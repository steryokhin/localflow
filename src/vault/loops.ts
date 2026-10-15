// Open loops: something I did or asked for, who I am waiting on, until when, and what to do if
// the deadline passes. A loop is an outline item with a deadline (outline.md, see outline.ts), and
// <vault>/loops.md lists the open ones one line each, editable by hand (outline-store.ts keeps the
// two in step):
//
//   - [ ] L3 · 2026-10-12 11:05 · EXP-123 · #android · QA check · from Tom · by 2026-10-12 18:00 · after L2 · else: ping
//
// "#tag" names a branch of the ticket's work (several can run in parallel); "after L2" links a
// step to the one it follows. Closing a loop checks its item off where it is and writes it to the
// ticket's "## Log" with its id, tag and "after" (or to loops-archive.md for a loop without a ticket).
//
// The user edits both files by hand or in the web UI while lf changes them, so every change is a
// compare-and-swap: read, change, write only if the files are still what was read; otherwise read
// again and re-apply by id. A loop whose own content changed in between is refused, never overwritten.

import path from "node:path";
import { ConflictError, UserError, contentHash, readTextIfExists, writeFileAtomic } from "../util.ts";
import { ME, cleanTag, dueAt, fmtStamp, formatLoop, normalizeId, parseLoop, parseWhen, splitLeadingTag } from "./loopfields.ts";
import type { Loop } from "./loopfields.ts";
import { appendTicketLog, isTracked, oneLine, setTracked } from "./notes.ts";
import { REF_ID_SRC, newId, setItem } from "./outline.ts";
import {
  LOOPS_FILE, addLoopItem, apply, assertNoConflict, editModel, openLoops, outlineTestHooks, readModel, setLoop,
} from "./outline-store.ts";
import type { Model } from "./outline-store.ts";
import { requireTicket } from "./store.ts";

export { DATE_RE, ME, cleanTag, dueAt, fmtDay, fmtStamp, formatLoop, parseLoop, parseWhen } from "./loopfields.ts";
export type { Loop } from "./loopfields.ts";
export { LOOPS_FILE } from "./outline-store.ts";
export const LOOPS_ARCHIVE = "loops-archive.md";

/** Every open loop, in outline order (hand edits in loops.md merged). Writes nothing. */
export function readLoops(vault: string): Loop[] {
  return openLoops(readModel(vault).o).map(({ item: _item, ...l }) => l);
}

/** Hash of loops.md as it is now (what a client sends back to say which version it saw). */
export function loopsHash(vault: string): string {
  return contentHash(readTextIfExists(path.join(vault, LOOPS_FILE)));
}

/** Test hook: runs between an operation's read and its write, to simulate a concurrent edit. */
export const loopsTestHooks = outlineTestHooks;

/** The open loops with their loops.md lines. Reads only: a hand-written line's id is stored by the next write. */
export function syncLoops(vault: string): Loop[] {
  return readLoops(vault);
}

type Found = Loop & { item: NonNullable<ReturnType<typeof openLoops>[number]["item"]> };

function findIn(m: Model, query: string): Found {
  const loops = openLoops(m.o);
  const q = query.trim();
  if (!q) throw new UserError("Which loop? Give its id (L3, k3f9) or a word from it.");
  const id = normalizeId(q);
  const byId = loops.find((l) => l.id === id);
  if (byId) return byId;
  const looksLikeId = /^\^?(l?\d+)$/i.test(q) || new RegExp(`^\\^?(?:${REF_ID_SRC})$`, "i").test(q);
  if (q.length < 3) throw new UserError(`No open loop ${looksLikeId ? id : `"${q}"`}. Give an id (L3, k3f9) or at least 3 letters of its text.`);
  const needle = q.toLowerCase();
  const hits = loops.filter((l) => `${l.text} ${l.owner} ${l.key ?? ""}`.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new UserError(looksLikeId ? `No open loop ${id}. See \`lf loops\`.` : `No open loop matches "${q}". See \`lf loops\`.`);
  throw new UserError(`"${q}" matches ${hits.length} loops:\n${hits.map((l) => `  ${l.id}  ${l.text}`).join("\n")}\nUse the id.`);
}

const refused = (now: string): string => `That loop was edited in loops.md meanwhile (or in outline.md; now: ${now}). Nothing was changed; run it again.`;

const strip = (l: Found | Loop): Loop => {
  const { item: _item, ...rest } = l as Found;
  return rest;
};

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
    after: input.after ? normalizeId(input.after) : null,
  };
}

export function addLoop(vault: string, input: NewLoop, now: Date, workdayEnd?: string): Loop {
  const fields = buildLoop(vault, input, now, workdayEnd);
  const loop = editModel(vault, (m) => {
    const l: Loop = { id: newId(new Set(m.o.byRef.keys())), ...fields };
    addLoopItem(m, l);
    m.summary.push(`loop ${l.id}: ${l.text}`);
    return { result: { ...l, raw: formatLoop(l) } };
  }, refused);
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
  const loop = editModel(vault, (m) => {
    const l = findIn(m, query);
    assertNoConflict(m, l.id);
    checkExpected(l, opts.expect);
    apply(m, setItem(m.o, l.item, { check: "x" }));
    m.summary.push(`done ${l.id}: ${oneLine(outcome) || "done"}`);
    return { result: strip(l), target: l.raw };
  }, refused);
  return { loop, loggedTo: logClosed(vault, loop, outcome, now) };
}

/** The Log line of a closed loop: "outcome (L3 #android, after L2: text, from Tom)". Returns where it went. */
export function logClosed(vault: string, loop: Loop, outcome: string, now: Date): string {
  const who = loop.owner === ME ? "" : `, from ${loop.owner}`;
  return logLine(vault, loop, `${oneLine(outcome) || "done"} (${stepRef(loop)}: ${loop.text}${who})`, now);
}

/** A loop checked off by mistake and opened again (the outline editor). */
export function logReopened(vault: string, loop: Loop, now: Date): string {
  return logLine(vault, loop, `reopened ${loop.id}: ${loop.text}`, now);
}

/** Moves a loop's deadline (and optionally its "else"); the ticket's Log records what it was. */
export function bumpLoop(
  vault: string, query: string, by: string, now: Date, workdayEnd?: string, opts: { onExpiry?: string; expect?: string } = {},
): { loop: Loop; was: string; wasElse: string } {
  const due = parseWhen(by, now, workdayEnd);
  const r = editModel(vault, (m) => {
    const l = findIn(m, query);
    assertNoConflict(m, l.id);
    checkExpected(l, opts.expect);
    const next: Loop = { ...strip(l), due, onExpiry: opts.onExpiry !== undefined ? oneLine(opts.onExpiry) : l.onExpiry };
    setLoop(m, l.item, next);
    m.summary.push(`bump ${l.id} to ${due}`);
    return { result: { loop: { ...next, raw: formatLoop(next) }, was: l.due, wasElse: l.onExpiry }, target: l.raw };
  }, refused);
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
  if (parsed.id && parsed.id !== normalizeId(id)) throw new UserError(`The id stays ${id} (the line says ${parsed.id}).`);
  if (!parsed.text) throw new UserError("The line has no text.");
  if (parsed.key) requireTicket(vault, parsed.key);
  if (parsed.due && !dueAt(parsed.due)) throw new UserError(`Cannot read the deadline "${parsed.due}": use 2026-10-14 or "2026-10-14 12:00".`);
  if (!parsed.due) throw new UserError("Every loop needs a deadline: by 2026-10-14 or by 2026-10-14 12:00.");
  return editModel(vault, (m) => {
    const l = findIn(m, id);
    assertNoConflict(m, l.id);
    checkExpected(l, expect);
    const next: Loop = { ...parsed, id: l.id, created: parsed.created || l.created };
    setLoop(m, l.item, next);
    m.summary.push(`edit ${l.id}: ${next.text}`);
    return { result: { ...next, raw: formatLoop(next) }, target: l.raw };
  }, refused);
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

const CLOSED_RE = new RegExp(`^(.*) \\((${REF_ID_SRC})(?: #([\\p{L}\\p{N}_-]+))?(?:, after (${REF_ID_SRC}))?: (.+?)(?:, from [^()]+)?\\)$`, "u");

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
