// Open loops: something I did or asked for, who I am waiting on, until when, and what to do if
// the deadline passes. They live in <vault>/loops.md, a user-owned plain file, one line per loop:
//
//   - [ ] L3 · 2026-10-12 11:05 · EXP-123 · PR #41 review · from Tom · by 2026-10-12 18:00 · else: ping in #ios-reviews
//
// Fields are separated by " · " and recognised by their shape, so a hand-written line may leave
// some out or use the Russian markers (от / до / иначе:). Closing a loop removes the line and
// writes it to the ticket's "## Log" (or to loops-archive.md for a loop without a ticket).

import path from "node:path";
import { UserError, readTextIfExists, writeFileAtomic } from "../util.ts";
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
}

interface Doc {
  lines: string[];
  loops: Array<Loop & { line: number }>;
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

function parseLoop(rest: string): Loop {
  const loop: Loop = { id: "", created: "", key: null, text: "", owner: "", due: "", onExpiry: "" };
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
    else if (!loop.created && !keySeen && !text.length && DATE_RE.test(f)) loop.created = f;
    else if (!keySeen && !text.length && (KEY_ONLY_RE.test(f) || f === "—" || f === "-")) {
      keySeen = true;
      loop.key = KEY_ONLY_RE.test(f) ? f : null;
    } else text.push(f);
  }
  loop.text = text.join(" · ");
  if (!loop.owner) {
    // "waiting for the review from Tom" written as one field.
    const m = /(?:^|\s)(?:from|от)\s+([\p{L}][\p{L}.'-]*)$/u.exec(loop.text);
    loop.owner = m ? m[1] : ME;
  }
  return loop;
}

export function formatLoop(l: Loop): string {
  const clean = (s: string): string => oneLine(s).replace(/ · /g, " - ");
  const fields = [l.id, l.created, l.key ?? "—", clean(l.text), `from ${clean(l.owner)}`, l.due ? `by ${l.due}` : "", l.onExpiry ? `else: ${clean(l.onExpiry)}` : ""];
  return `- [ ] ${fields.filter(Boolean).join(" · ")}`;
}

function readDoc(vault: string): Doc {
  const text = readTextIfExists(path.join(vault, LOOPS_FILE));
  const lines = text === null ? HEADER.split("\n") : text.replace(/\n$/, "").split("\n");
  const loops: Doc["loops"] = [];
  lines.forEach((line, i) => {
    const m = OPEN_RE.exec(line.trim());
    if (m) loops.push({ ...parseLoop(m[1]), line: i });
  });
  return { lines, loops };
}

/** Every open loop in loops.md, in file order. */
export function readLoops(vault: string): Loop[] {
  return readDoc(vault).loops.map(({ line: _line, ...l }) => l);
}

function writeDoc(vault: string, doc: Doc): void {
  writeFileAtomic(path.join(vault, LOOPS_FILE), doc.lines.join("\n").replace(/\n*$/, "\n"));
}

/** Gives hand-written lines an id, so every loop can be closed or bumped by it. */
function numberAll(vault: string, doc: Doc): boolean {
  const missing = doc.loops.filter((l) => !l.id);
  if (!missing.length) return false;
  for (const l of missing) {
    l.id = nextId(vault, doc);
    doc.lines[l.line] = formatLoop(l);
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
  if (numberAll(vault, doc)) writeDoc(vault, doc);
  return doc.loops.map(({ line: _line, ...l }) => l);
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
}

export function addLoop(vault: string, input: NewLoop, now: Date, workdayEnd?: string): Loop {
  const text = oneLine(input.text);
  if (!text) throw new UserError('Usage: lf loop "what I am waiting for" --by WHEN [--key KEY] [--from WHO] [--else "what then"]');
  const t = input.key ? requireTicket(vault, input.key) : null;
  const doc = readDoc(vault);
  numberAll(vault, doc);
  const loop: Loop = {
    id: nextId(vault, doc),
    created: fmtStamp(now),
    key: t?.key ?? null,
    text,
    owner: oneLine(input.owner ?? "") || ME,
    due: parseWhen(input.by, now, workdayEnd),
    onExpiry: oneLine(input.onExpiry ?? ""),
  };
  doc.lines.push(formatLoop(loop));
  writeDoc(vault, doc);
  if (t && !isTracked(t)) setTracked(t, true);
  return loop;
}

/** Closes a loop: removes its line and logs it with the outcome. Returns where it was logged. */
export function closeLoop(vault: string, query: string, outcome: string, now: Date): { loop: Loop; loggedTo: string } {
  const doc = readDoc(vault);
  numberAll(vault, doc);
  const loop = findIn(doc, query);
  doc.lines.splice(loop.line, 1);
  writeDoc(vault, doc);
  const who = loop.owner === ME ? "" : `, from ${loop.owner}`;
  const line = `${oneLine(outcome) || "done"} (${loop.id}: ${loop.text}${who})`;
  if (loop.key) {
    try {
      const t = requireTicket(vault, loop.key);
      appendTicketLog(t, fmtStamp(now), line);
      return { loop, loggedTo: path.join(t.rel, "notes.md") };
    } catch {
      // The ticket folder is gone: keep the record in the archive instead.
    }
  }
  const archive = path.join(vault, LOOPS_ARCHIVE);
  const old = readTextIfExists(archive);
  const prev = old === null ? "# Closed loops without a ticket\n\n" : old.replace(/\n*$/, "\n");
  writeFileAtomic(archive, `${prev}- ${fmtStamp(now)} — ${loop.key ? `${loop.key}: ` : ""}${line}\n`);
  return { loop, loggedTo: LOOPS_ARCHIVE };
}

/** Moves a loop's deadline; the ticket's Log records the move. */
export function bumpLoop(vault: string, query: string, by: string, now: Date, workdayEnd?: string): { loop: Loop; was: string } {
  const doc = readDoc(vault);
  numberAll(vault, doc);
  const loop = findIn(doc, query);
  const was = loop.due;
  loop.due = parseWhen(by, now, workdayEnd);
  doc.lines[loop.line] = formatLoop(loop);
  writeDoc(vault, doc);
  if (loop.key) {
    try {
      appendTicketLog(requireTicket(vault, loop.key), fmtStamp(now), `${loop.id} moved to ${loop.due}${was ? ` (was ${was})` : ""}: ${loop.text}`);
    } catch {
      // No ticket folder: nothing to log into.
    }
  }
  return { loop, was };
}
