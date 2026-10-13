// Open loops: something I did or asked for, who I am waiting on, until when, and what to do if
// the deadline passes. They live in <vault>/loops.md, a user-owned plain file, one line per loop:
//
//   - [ ] L3 · 2026-10-12 11:05 · EXP-123 · #android · QA check · from Tom · by 2026-10-12 18:00 · after L2 · else: ping
//
// Fields are separated by " · " and recognised by their shape, so a hand-written line may leave
// some out or use the Russian markers (от / до / после / иначе:). "#tag" names a branch of the
// ticket's work (several can run in parallel); "after L2" links a step to the one it follows.
// Closing a loop removes the line and writes it to the ticket's "## Log" with its id, tag and
// "after" (or to loops-archive.md for a loop without a ticket).
//
// The user edits loops.md by hand or in the web UI while lf changes it, so every change is a
// compare-and-swap: read, change, write only if the file is still what was read; otherwise read
// again and re-apply by id. A loop whose line changed in between is refused, never overwritten.

import path from "node:path";
import { ConflictError, UserError, contentHash, readTextIfExists, writeFileAtomic } from "../util.ts";
import { appendTicketLog, isTracked, oneLine, setTracked } from "./notes.ts";
import { loadState, saveState } from "./state.ts";
import { KEY_ONLY_RE, requireTicket } from "./store.ts";

export const LOOPS_FILE = "loops.md";
export const LOOPS_ARCHIVE = "loops-archive.md";
export const ME = "me";

export interface Loop {
  /** "L3"; empty for a hand-written line that has not been numbered yet. */
  id: string;
  /** When the loop was opened: "YYYY-MM-DD HH:MM" or "YYYY-MM-DD"; may be empty. */
  created: string;
  key: string | null;
  text: string;
  /** "me" or the person I am waiting on. */
  owner: string;
  /** "YYYY-MM-DD HH:MM" or "YYYY-MM-DD" (the end of that day); empty means no deadline. */
  due: string;
  /** What to do when the deadline passes. */
  onExpiry: string;
  /** Branch of the ticket's work ("android" for "#android"), or null. */
  tag: string | null;
  /** The step this one follows ("L3"), or null. */
  after: string | null;
  /** The line as it is in loops.md (set when read from the file). */
  raw?: string;
}

interface Doc {
  lines: string[];
  loops: Array<Loop & { line: number }>;
  /** Hash of the file as read: the write goes through only if it is unchanged. */
  hash: string;
}

const HEADER = `# Open loops

<!-- One line per loop: id · opened · ticket · what · from WHO · by WHEN · else: WHAT TO DO.
     Edit freely; \`lf done\` / \`lf bump\` / \`lf loop\` keep the format. Closed loops go to the ticket's ## Log. -->
`;

const OPEN_RE = /^- \[ \] (.+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2})?$/;

// ---------- time ----------

const pad = (n: number): string => String(n).padStart(2, "0");
export const fmtDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtStamp = (d: Date): string => `${fmtDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The moment a due string expires: a date alone means the end of that day. Null when unparsable. */
export function dueAt(due: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2}))?$/.exec(due.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  return m[4] === undefined ? new Date(y, mo, d, 23, 59, 59, 999) : new Date(y, mo, d, Number(m[4]), Number(m[5]));
}

/**
 * Turns what the user typed after --by into a due string: "+4h", "+30m", "+2d", "18:00" (the next
 * time it is 18:00), "eod" (the next end of the working day), "tomorrow", "2026-10-14",
 * "2026-10-14 12:00".
 */
export function parseWhen(input: string, now: Date, workdayEnd = "18:00"): string {
  const s = input.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^\+(\d+)\s*([mhd])$/.exec(s))) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    return fmtStamp(new Date(now.getTime() + Number(m[1]) * ms));
  }
  const at = (hhmm: string): string => {
    const [h, min] = hhmm.split(":").map(Number);
    if (h > 23 || min > 59) throw new UserError(`Not a time of day: ${hhmm}`);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min);
    if (d <= now) d.setDate(d.getDate() + 1);
    return fmtStamp(d);
  };
  if (/^\d{1,2}:\d{2}$/.test(s)) return at(s);
  if (s === "eod") return at(workdayEnd);
  if (s === "today") return fmtDay(now);
  if (s === "tomorrow") return fmtDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  if (DATE_RE.test(s) && dueAt(s)) return s.replace(/ (\d):/, " 0$1:");
  throw new UserError(`Cannot read "${input}" as a deadline. Use +4h, +30m, +2d, 18:00, eod, tomorrow, 2026-10-14 or "2026-10-14 12:00".`);
}

// ---------- the file ----------

const TAG_RE = /^#([\p{L}\p{N}_-]+)$/u;
const LEADING_TAG_RE = /^#([\p{L}\p{N}_-]+)\s+(?=\S)/u;

/** "#android" or "android" -> "android"; refuses anything that would not survive a round trip. */
export function cleanTag(raw: string | undefined | null): string | null {
  const t = (raw ?? "").trim().replace(/^#/, "");
  if (!t) return null;
  if (!TAG_RE.test(`#${t}`)) throw new UserError(`Not a branch tag: "${raw}". Use letters, digits, - or _ (e.g. android, a11y, web-scope).`);
  return t;
}

/** "#android QA check" -> tag "android", text "QA check". */
function splitLeadingTag(text: string): { tag: string | null; text: string } {
  const m = LEADING_TAG_RE.exec(text);
  return m ? { tag: m[1], text: text.slice(m[0].length) } : { tag: null, text };
}

function parseLoop(rest: string): Loop {
  const loop: Loop = { id: "", created: "", key: null, text: "", owner: "", due: "", onExpiry: "", tag: null, after: null };
  let keySeen = false;
  const text: string[] = [];
  for (const raw of rest.split(" · ")) {
    const f = raw.trim();
    let m: RegExpExecArray | null;
    if (!f) continue;
    if (!loop.id && !text.length && /^L\d+$/.test(f)) loop.id = f;
    else if ((m = /^(?:from|от)\s+(.+)$/i.exec(f))) loop.owner = m[1].trim();
    else if ((m = /^(?:by|до)\s+(.+)$/i.exec(f))) loop.due = m[1].trim();
    else if ((m = /^(?:else|иначе)\s*:\s*(.*)$/i.exec(f))) loop.onExpiry = m[1].trim();
    else if ((m = /^(?:after|после)\s+(L\d+)$/i.exec(f))) loop.after = m[1].toUpperCase();
    else if (!loop.tag && (m = TAG_RE.exec(f))) loop.tag = m[1];
    else if (!loop.created && !keySeen && !text.length && DATE_RE.test(f)) loop.created = f;
    else if (!keySeen && !text.length && (KEY_ONLY_RE.test(f) || f === "—" || f === "-")) {
      keySeen = true;
      loop.key = KEY_ONLY_RE.test(f) ? f : null;
    } else text.push(f);
  }
  loop.text = text.join(" · ");
  if (!loop.tag) Object.assign(loop, splitLeadingTag(loop.text));
  if (!loop.owner) {
    // "waiting for the review from Tom" written as one field.
    const m = /(?:^|\s)(?:from|от)\s+([\p{L}][\p{L}.'-]*)$/u.exec(loop.text);
    loop.owner = m ? m[1] : ME;
  }
  return loop;
}

export function formatLoop(l: Loop): string {
  const clean = (s: string): string => oneLine(s).replace(/ · /g, " - ");
  const fields = [
    l.id, l.created, l.key ?? "—", l.tag ? `#${l.tag}` : "", clean(l.text), `from ${clean(l.owner)}`, l.due ? `by ${l.due}` : "",
    l.after ? `after ${l.after}` : "", l.onExpiry ? `else: ${clean(l.onExpiry)}` : "",
  ];
  return `- [ ] ${fields.filter(Boolean).join(" · ")}`;
}

function readDoc(vault: string): Doc {
  const text = readTextIfExists(path.join(vault, LOOPS_FILE));
  const lines = text === null ? HEADER.split("\n") : text.replace(/\n$/, "").split("\n");
  const loops: Doc["loops"] = [];
  lines.forEach((line, i) => {
    const m = OPEN_RE.exec(line.trim());
    if (m) loops.push({ ...parseLoop(m[1]), raw: line.trim(), line: i });
  });
  return { lines, loops, hash: contentHash(text) };
}

/** Every open loop in loops.md, in file order. */
export function readLoops(vault: string): Loop[] {
  return readDoc(vault).loops.map(({ line: _line, ...l }) => l);
}

/** Hash of loops.md as it is now (what a client sends back to say which version it saw). */
export function loopsHash(vault: string): string {
  return contentHash(readTextIfExists(path.join(vault, LOOPS_FILE)));
}

/** Writes the document unless loops.md changed since it was read. Returns false on a change. */
function writeDoc(vault: string, doc: Doc): boolean {
  const file = path.join(vault, LOOPS_FILE);
  if (contentHash(readTextIfExists(file)) !== doc.hash) return false;
  writeFileAtomic(file, doc.lines.join("\n").replace(/\n*$/, "\n"));
  return true;
}

/** Test hook: runs between an operation's read and its write, to simulate a concurrent edit. */
export const loopsTestHooks: { beforeWrite: (() => void) | null } = { beforeWrite: null };

/**
 * Read → change → compare-and-swap write, re-applied on a concurrent change. `op` returns the
 * line it acts on (as read): if that line differs on a retry, the operation is refused.
 */
function edit<T>(vault: string, op: (doc: Doc) => { result: T; target?: string }): T {
  let pinned: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = readDoc(vault);
    numberAll(vault, doc);
    const { result, target } = op(doc);
    if (target !== undefined) {
      if (pinned === undefined) pinned = target;
      else if (pinned !== target) throw new ConflictError(`That loop was edited in loops.md meanwhile (now: ${target}). Nothing was changed; run it again.`);
    }
    const hook = loopsTestHooks.beforeWrite;
    loopsTestHooks.beforeWrite = null;
    hook?.();
    if (writeDoc(vault, doc)) return result;
  }
  throw new ConflictError("loops.md keeps changing while lf writes it: nothing was changed. Try again.");
}

/** Gives hand-written lines an id, so every loop can be closed or bumped by it. */
function numberAll(vault: string, doc: Doc): boolean {
  const missing = doc.loops.filter((l) => !l.id);
  if (!missing.length) return false;
  for (const l of missing) {
    l.id = nextId(vault, doc);
    doc.lines[l.line] = formatLoop(l);
    l.raw = doc.lines[l.line];
  }
  return true;
}

/** The next free "L<n>". The counter lives in the untracked state so closed ids are not reused. */
function nextId(vault: string, doc: Doc): string {
  const state = loadState(vault);
  const used = doc.loops.map((l) => Number(l.id.slice(1)) || 0);
  const n = Math.max(state.loopSeq ?? 0, ...used) + 1;
  state.loopSeq = n;
  saveState(vault, state);
  return `L${n}`;
}

/** Re-reads loops.md and numbers hand-written lines; returns the open loops. */
export function syncLoops(vault: string): Loop[] {
  const doc = readDoc(vault);
  // A concurrent edit wins: the numbering happens on the next read.
  if (numberAll(vault, doc)) writeDoc(vault, doc);
  return doc.loops.map(({ line: _line, ...l }) => ({ ...l, raw: doc.lines[_line].trim() }));
}

function findIn(doc: Doc, query: string): Loop & { line: number } {
  const q = query.trim();
  if (!q) throw new UserError("Which loop? Give its id (L3) or a word from it.");
  const id = /^l?\d+$/i.test(q) ? `L${q.replace(/^l/i, "")}` : null;
  const byId = id ? doc.loops.find((l) => l.id === id) : undefined;
  if (byId) return byId;
  if (q.length < 3) throw new UserError(`No open loop ${id ?? `"${q}"`}. Give an id (L3) or at least 3 letters of its text.`);
  const needle = q.toLowerCase();
  const hits = doc.loops.filter((l) => `${l.text} ${l.owner} ${l.key ?? ""}`.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new UserError(`No open loop matches "${q}". See \`lf loops\`.`);
  throw new UserError(`"${q}" matches ${hits.length} loops:\n${hits.map((l) => `  ${l.id}  ${l.text}`).join("\n")}\nUse the id.`);
}

// ---------- operations ----------

export interface NewLoop {
  text: string;
  key?: string;
  owner?: string;
  by: string;
  onExpiry?: string;
  /** Branch tag; a leading "#tag " in the text works too. */
  tag?: string | null;
  /** The step this one follows. */
  after?: string | null;
}

/** Checks a new loop without writing anything: text, ticket, deadline, tag. */
function buildLoop(vault: string, input: NewLoop, now: Date, workdayEnd?: string): Omit<Loop, "id"> {
  const split = splitLeadingTag(oneLine(input.text));
  const text = split.text;
  if (!text) throw new UserError('Usage: lf loop "what I am waiting for" --by WHEN [--key KEY] [--from WHO] [--else "what then"] [--tag BRANCH]');
  const t = input.key ? requireTicket(vault, input.key) : null;
  return {
    created: fmtStamp(now),
    key: t?.key ?? null,
    text,
    owner: oneLine(input.owner ?? "") || ME,
    due: parseWhen(input.by, now, workdayEnd),
    onExpiry: oneLine(input.onExpiry ?? ""),
    tag: cleanTag(input.tag) ?? split.tag,
    after: input.after ? input.after.toUpperCase() : null,
  };
}

export function addLoop(vault: string, input: NewLoop, now: Date, workdayEnd?: string): Loop {
  const fields = buildLoop(vault, input, now, workdayEnd);
  const loop = edit(vault, (doc) => {
    const l: Loop = { id: nextId(vault, doc), ...fields };
    doc.lines.push(formatLoop(l));
    return { result: l };
  });
  if (loop.key) {
    const t = requireTicket(vault, loop.key);
    if (!isTracked(t)) setTracked(t, true);
  }
  return loop;
}

/** The loop's id, tag and "after" as they go into the Log: "L3 #android, after L2". */
function stepRef(l: Loop): string {
  return `${l.id}${l.tag ? ` #${l.tag}` : ""}${l.after ? `, after ${l.after}` : ""}`;
}

function logLine(vault: string, loop: Loop, line: string, now: Date): string {
  if (loop.key) {
    try {
      const t = requireTicket(vault, loop.key);
      appendTicketLog(t, fmtStamp(now), line);
      return path.join(t.rel, "notes.md");
    } catch {
      // The ticket folder is gone: keep the record in the archive instead.
    }
  }
  const archive = path.join(vault, LOOPS_ARCHIVE);
  const old = readTextIfExists(archive);
  const prev = old === null ? "# Closed loops without a ticket\n\n" : old.replace(/\n*$/, "\n");
  writeFileAtomic(archive, `${prev}- ${fmtStamp(now)} — ${loop.key ? `${loop.key}: ` : ""}${line}\n`);
  return LOOPS_ARCHIVE;
}

/** Refuses when the caller saw a different version of the loop's line (the web UI sends it). */
function checkExpected(l: Loop & { raw?: string }, expect: string | undefined): void {
  if (expect !== undefined && expect.trim() !== l.raw) {
    throw new ConflictError(`${l.id} changed in loops.md since it was loaded (now: ${l.raw}). Reload and try again.`);
  }
}

/** Closes a loop: removes its line and logs it with the outcome. Returns where it was logged. */
export function closeLoop(vault: string, query: string, outcome: string, now: Date, opts: { expect?: string } = {}): { loop: Loop; loggedTo: string } {
  const loop = edit(vault, (doc) => {
    const l = findIn(doc, query);
    checkExpected(l, opts.expect);
    doc.lines.splice(l.line, 1);
    const { line: _line, ...rest } = l;
    return { result: rest, target: l.raw };
  });
  const who = loop.owner === ME ? "" : `, from ${loop.owner}`;
  const loggedTo = logLine(vault, loop, `${oneLine(outcome) || "done"} (${stepRef(loop)}: ${loop.text}${who})`, now);
  return { loop, loggedTo };
}

/** Moves a loop's deadline (and optionally its "else"); the ticket's Log records what it was. */
export function bumpLoop(
  vault: string, query: string, by: string, now: Date, workdayEnd?: string, opts: { onExpiry?: string; expect?: string } = {},
): { loop: Loop; was: string; wasElse: string } {
  const due = parseWhen(by, now, workdayEnd);
  const r = edit(vault, (doc) => {
    const l = findIn(doc, query);
    checkExpected(l, opts.expect);
    const target = l.raw;
    const was = l.due;
    const wasElse = l.onExpiry;
    l.due = due;
    if (opts.onExpiry !== undefined) l.onExpiry = oneLine(opts.onExpiry);
    doc.lines[l.line] = formatLoop(l);
    const { line: _line, ...loop } = l;
    return { result: { loop: { ...loop, raw: doc.lines[l.line] }, was, wasElse }, target };
  });
  const { loop, was, wasElse } = r;
  if (loop.key) {
    const elseNote = opts.onExpiry !== undefined && wasElse !== loop.onExpiry ? `; else: ${loop.onExpiry || "—"} (was: ${wasElse || "—"})` : "";
    try {
      appendTicketLog(requireTicket(vault, loop.key), fmtStamp(now), `${stepRef(loop)} moved to ${loop.due}${was ? ` (was ${was})` : ""}${elseNote}: ${loop.text}`);
    } catch {
      // No ticket folder: nothing to log into.
    }
  }
  return r;
}

/**
 * Replaces one loop's line with an edited one (the web UI's text view). The new line goes through
 * the same parser and checks as lf: same id, an existing ticket, a readable deadline, a text.
 */
export function replaceLoopLine(vault: string, id: string, newLine: string, expect: string | undefined): Loop {
  const body = newLine.trim().replace(/^- \[ \]\s*/, "");
  if (!body || /\n/.test(newLine.trim())) throw new UserError("One line, please: id · ticket · #tag · text · from WHO · by WHEN · after L1 · else: …");
  const parsed = parseLoop(body);
  if (parsed.id && parsed.id !== id) throw new UserError(`The id stays ${id} (the line says ${parsed.id}).`);
  if (!parsed.text) throw new UserError("The line has no text.");
  if (parsed.key) requireTicket(vault, parsed.key);
  if (parsed.due && !dueAt(parsed.due)) throw new UserError(`Cannot read the deadline "${parsed.due}": use 2026-10-14 or "2026-10-14 12:00".`);
  if (!parsed.due) throw new UserError("Every loop needs a deadline: by 2026-10-14 or by 2026-10-14 12:00.");
  if (parsed.after && !/^L\d+$/.test(parsed.after)) throw new UserError(`"after" takes a loop id, e.g. after L3.`);
  return edit(vault, (doc) => {
    const l = findIn(doc, id);
    checkExpected(l, expect);
    const next: Loop = { ...parsed, id: l.id, created: parsed.created || l.created };
    doc.lines[l.line] = formatLoop(next);
    return { result: { ...next, raw: doc.lines[l.line] }, target: l.raw };
  });
}

// ---------- branches ----------

/** A closed step read back from a ticket's ## Log. */
export interface ClosedStep {
  id: string;
  tag: string | null;
  after: string | null;
  text: string;
  outcome: string;
  date: string;
}

const CLOSED_RE = /^(.*) \((L\d+)(?: #([\p{L}\p{N}_-]+))?(?:, after (L\d+))?: (.+?)(?:, from [^()]+)?\)$/u;

/** Closed steps in the Log lines (as written by closeLoop), oldest first. */
export function closedSteps(log: Array<{ date: string; time: string; text: string }>): ClosedStep[] {
  const out: ClosedStep[] = [];
  for (const l of log) {
    const m = CLOSED_RE.exec(l.text);
    if (!m || / moved to /.test(l.text)) continue;
    out.push({ outcome: m[1], id: m[2], tag: m[3] ?? null, after: m[4] ?? null, text: m[5], date: `${l.date}${l.time ? ` ${l.time}` : ""}` });
  }
  return out;
}

export interface Branch {
  /** "" for steps without a tag. */
  tag: string;
  closed: ClosedStep[];
  open: Loop[];
}

/** A ticket's work by branch: closed steps from its Log, then the open loops. Tagged branches first. */
export function ticketBranches(log: Array<{ date: string; time: string; text: string }>, open: Loop[]): Branch[] {
  const by = new Map<string, Branch>();
  const get = (tag: string): Branch => {
    if (!by.has(tag)) by.set(tag, { tag, closed: [], open: [] });
    return by.get(tag)!;
  };
  for (const c of closedSteps(log)) get(c.tag ?? "").closed.push(c);
  for (const l of open) get(l.tag ?? "").open.push(l);
  return [...by.values()].sort((a, b) => (a.tag === "" ? 1 : b.tag === "" ? -1 : a.tag.localeCompare(b.tag)));
}
