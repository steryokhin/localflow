// The fields of one loop as they are written in loops.md and in an outline item:
//
//   L3 · 2026-10-12 11:05 · EXP-123 · #android · QA check · from Tom · by 2026-10-12 18:00 · after L2 · else: ping
//
// Fields are separated by " · " and recognised by their shape, so a hand-written line may leave
// some out or use the Russian markers (от / до / после / иначе: / открыто). Ids are the old "L7"
// or the outline's "k3f9", written "^k3f9" where a bare word could be mistaken for one.

import { UserError } from "../util.ts";
import { oneLine } from "./notes.ts";
import { GEN_ID_SRC, REF_ID_SRC, isGeneratedId } from "./outline.ts";
import { KEY_ONLY_RE } from "./store.ts";

export const ME = "me";

export interface Loop {
  /** "L3" or "k3f9"; for a hand-written line, the id it gets on the next write. */
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
  /** The loop as a loops.md line (set when read). */
  raw?: string;
}

/** An open loop line in loops.md. */
export const OPEN_RE = /^- \[ \] (.+)$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2})?$/;
const ID_FIELD_RE = new RegExp(`^(?:L\\d+|\\^[A-Za-z0-9]{2,16}|${GEN_ID_SRC})$`);
const AFTER_RE = new RegExp(`^(?:after|после)\\s+\\^?(${REF_ID_SRC})$`, "i");

/** An id as typed or written ("^k3f9", "l7", "7") -> "k3f9" / "L7". */
export function normalizeId(raw: string): string {
  const s = raw.trim().replace(/^\^/, "");
  if (/^\d+$/.test(s)) return `L${s}`;
  if (/^l\d+$/i.test(s)) return s.toUpperCase();
  return isGeneratedId(s.toLowerCase()) ? s.toLowerCase() : s;
}

/** How an id is written in a field: "L7" as it always was, any other id with a caret. */
export function idField(id: string): string {
  return /^L\d+$/.test(id) ? id : `^${id}`;
}

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
export function splitLeadingTag(text: string): { tag: string | null; text: string } {
  const m = LEADING_TAG_RE.exec(text);
  return m ? { tag: m[1], text: text.slice(m[0].length) } : { tag: null, text };
}

export function parseLoop(rest: string): Loop {
  const loop: Loop = { id: "", created: "", key: null, text: "", owner: "", due: "", onExpiry: "", tag: null, after: null };
  let keySeen = false;
  const text: string[] = [];
  for (const raw of rest.split(" · ")) {
    const f = raw.trim();
    let m: RegExpExecArray | null;
    if (!f) continue;
    if (!loop.id && !text.length && !loop.created && !keySeen && ID_FIELD_RE.test(f)) loop.id = normalizeId(f);
    else if ((m = /^(?:from|от)\s+(.+)$/i.exec(f))) loop.owner = m[1].trim();
    else if ((m = /^(?:by|до)\s+(.+)$/i.exec(f))) loop.due = m[1].trim();
    else if ((m = /^(?:else|иначе)\s*:\s*(.*)$/i.exec(f))) loop.onExpiry = m[1].trim();
    else if ((m = AFTER_RE.exec(f))) loop.after = normalizeId(m[1]);
    else if ((m = /^(?:opened|открыто)\s+(\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2})?)$/i.exec(f))) loop.created = m[1];
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

const clean = (s: string): string => oneLine(s).replace(/ · /g, " - ");

/** The loop as a loops.md line. */
export function formatLoop(l: Loop): string {
  const fields = [
    l.id ? idField(l.id) : "", l.created, l.key ?? "—", l.tag ? `#${l.tag}` : "", clean(l.text), `from ${clean(l.owner)}`, l.due ? `by ${l.due}` : "",
    l.after ? `after ${idField(l.after)}` : "", l.onExpiry ? `else: ${clean(l.onExpiry)}` : "",
  ];
  return `- [ ] ${fields.filter(Boolean).join(" · ")}`;
}

/**
 * The loop as an outline item's text: the ticket comes from the heading and the id from "^id", so
 * neither is repeated; "from me" and a tag the item inherits from its parent are left out.
 */
export function formatLoopItem(l: Loop, inheritedTag: string | null): string {
  const tag = l.tag && l.tag !== inheritedTag ? `#${l.tag} ` : "";
  return [
    `${tag}${clean(l.text)}`, l.owner && l.owner !== ME ? `from ${clean(l.owner)}` : "", l.due ? `by ${l.due}` : "",
    l.after ? `after ${idField(l.after)}` : "", l.onExpiry ? `else: ${clean(l.onExpiry)}` : "", l.created ? `opened ${l.created}` : "",
  ].filter(Boolean).join(" · ");
}
