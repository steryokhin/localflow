// outline.md: one plain-text tree where everything is an item (LFLOW-024, one tree since LFLOW-026).
//
//   - Mobile ^p2q3
//     - PROJ-1 · Login crash on swipe ^a7c4
//       - [x] reproduce on iOS 26 ^k3f9
//       - [ ] research issue #123 ^m4p2
//         > Tom: the crash is in the swipe handler
//         - [ ] wait for Jim's review · from Jim · by 2026-10-15 12:00 · else: ping in #ios ^L7
//       - PROJ-2 · Crash in the cache ^b5d6
//
// Items are "- [ ]" / "- [x]" tasks or plain "- " bullets, nested by indentation to any depth;
// "> " lines right under an item are its context; "^id" at the end is its permanent id. A bullet
// whose text is "KEY · title" (or just "KEY") stands for a ticket; a trailing " ✓" marks it closed.
// Everything under it belongs to that ticket (the nearest one up the tree). Tickets, folders and
// steps nest and move alike. A task with a "by" field is a loop (see loopfields.ts).
//
// Files written before one tree had "## KEY · title" headings with the items under them; they are
// read as bullets with the items one level in, and the next write stores that form.
//
// Everything here is pure and line-based: an operation rewrites only the lines it is about, so
// untouched lines keep every byte. Items without an id get a deterministic one derived from their
// text, so reads never need to write; the first write stores it.

import crypto from "node:crypto";
import { UserError } from "../util.ts";

export const OUTLINE_FILE = "outline.md";
export const NO_TICKET = "No ticket";
export const OUTLINE_HEADER = "# Outline\n";

export type Check = " " | "x" | null;

export interface Item {
  /** The id written in the file, or null. */
  id: string | null;
  /** The id written in the file, or the derived one it gets on the next write. */
  ref: string;
  line: number;
  /** Width of the leading whitespace (a tab counts as 2). */
  indent: number;
  check: Check;
  /** The text after the checkbox, without "^id". */
  text: string;
  /** "> " lines under the item, without the marker. */
  context: string[];
  /** First line after the item line and its context. */
  ctxEnd: number;
  /** First line after the whole subtree. */
  end: number;
  parent: Item | null;
  children: Item[];
  /** Set when the item stands for a ticket ("KEY · title" bullet). */
  ticket: TicketHead | null;
  /** The nearest ticket item: the item itself or the closest one up the tree; null when none. */
  home: Item | null;
  /** The ticket this item belongs to: home's key. */
  key: string | null;
}

export interface TicketHead {
  key: string;
  title: string;
  closed: boolean;
}

export interface Outline {
  lines: string[];
  /** Items at the top level, in file order. */
  roots: Item[];
  /** Every item, in file order. */
  items: Item[];
  byRef: Map<string, Item>;
}

const HEAD_RE = /^## (.*)$/;
const ITEM_RE = /^([ \t]*)[-*+] (?:\[([ xX])\](?= |$) ?)?(.*)$/;
const CTX_RE = /^([ \t]*)> ?(.*)$/;
const ID_TAIL_RE = /(?:^|\s)\^([A-Za-z0-9]{2,16})$/;
const KEY_HEAD_RE = /^([A-Z][A-Z0-9_]*-\d+)(?:\s+·\s+(.*))?$/;
const CLOSED_MARK_RE = /\s*✓$/;

/** Ids lf hands out: letter, digit, letter, digit ("k3f9"); no l, o, 0 or 1 to misread. */
export const GEN_ID_SRC = "[a-km-np-z][2-9][a-km-np-z][2-9]";
/** A loop id wherever one is referenced (Log lines, "after", lf done): the old "L7" or a new one. */
export const REF_ID_SRC = `L\\d+|${GEN_ID_SRC}`;
const GEN_ID_RE = new RegExp(`^(?:${GEN_ID_SRC})$`);
const LETTERS = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";

export function isGeneratedId(id: string): boolean {
  return GEN_ID_RE.test(id);
}

function idFromBytes(b: Uint8Array): string {
  return LETTERS[b[0] % LETTERS.length] + DIGITS[b[1] % DIGITS.length] + LETTERS[b[2] % LETTERS.length] + DIGITS[b[3] % DIGITS.length];
}

/** A fresh random id not in `taken`. */
export function newId(taken: Set<string>): string {
  for (;;) {
    const id = idFromBytes(crypto.randomBytes(4));
    if (!taken.has(id)) return id;
  }
}

/** A stable id for content that has none yet: the same text gets the same id on every read. */
export function derivedId(seed: string, taken: Set<string>): string {
  for (let salt = 0; ; salt++) {
    const id = idFromBytes(crypto.createHash("sha256").update(`${salt}\0${seed}`).digest());
    if (!taken.has(id)) return id;
  }
}

export function width(ws: string): number {
  let w = 0;
  for (const c of ws) w += c === "\t" ? 2 : 1;
  return w;
}

const leading = (line: string): string => /^[ \t]*/.exec(line)![0];

/** A bullet's text as a ticket: "KEY · title" or "KEY", with " ✓" when closed. */
export function parseTicketText(text: string): TicketHead | null {
  const closed = CLOSED_MARK_RE.test(text);
  const m = KEY_HEAD_RE.exec(text.replace(CLOSED_MARK_RE, "").trim());
  return m ? { key: m[1], title: (m[2] ?? "").trim(), closed } : null;
}

export function ticketText(key: string, title: string, closed = false): string {
  return `${title ? `${key} · ${title}` : key}${closed ? " ✓" : ""}`;
}

/**
 * The text of a file from before one tree, in the one-tree form: each "## heading" becomes a top
 * bullet ("## title ✓" without a key: a checked task) and what was under it moves one level in.
 */
export function fromHeadings(lines: string[]): string[] {
  if (!lines.some((l) => HEAD_RE.test(l))) return lines;
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const h = HEAD_RE.exec(line);
    if (h) {
      const t = parseTicketText(h[1]);
      const closed = CLOSED_MARK_RE.test(h[1]);
      const title = h[1].replace(CLOSED_MARK_RE, "").trim();
      // A blank line between top-level blocks reads better than one glued to the previous block.
      while (out.length && !out[out.length - 1].trim()) out.pop();
      if (out.length) out.push("");
      out.push(t ? `- ${ticketText(t.key, t.title, t.closed)}` : closed ? `- [x] ${title}` : `- ${title}`);
      inSection = true;
      continue;
    }
    out.push(inSection && line.trim() ? `  ${line}` : line);
  }
  return out;
}

/** Splits an item line's text into text and id. */
function splitId(rest: string): { text: string; id: string | null } {
  const m = ID_TAIL_RE.exec(rest);
  if (!m) return { text: rest.replace(/\s+$/, ""), id: null };
  return { text: rest.slice(0, m.index).replace(/\s+$/, ""), id: m[1] };
}

export function parseOutline(raw: string): Outline {
  // Windows line ends are read as plain ones (and written back as plain ones).
  const text = raw.replace(/\r\n?/g, "\n");
  const split = text.replace(/\n$/, "").split("\n");
  if (text === "") split.length = 0;
  const lines = fromHeadings(split);
  const roots: Item[] = [];
  const items: Item[] = [];
  const stack: Item[] = [];
  // The item whose context block is still open (its line or context lines came last).
  let ctxOwner: Item | null = null;

  const touch = (i: number): void => {
    for (const it of stack) it.end = i + 1;
  };

  lines.forEach((line, i) => {
    const m = ITEM_RE.exec(line);
    if (m) {
      const indent = width(m[1]);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1] ?? null;
      const { text: body, id } = splitId(m[3]);
      const check: Check = m[2] === undefined ? null : m[2] === " " ? " " : "x";
      const ticket = check === null ? parseTicketText(body) : null;
      const it: Item = {
        id, ref: id ?? "", line: i, indent, check, text: body, context: [], ctxEnd: i + 1, end: i + 1, parent, children: [], ticket, home: null, key: null,
      };
      it.home = ticket ? it : parent?.home ?? null;
      it.key = it.home?.ticket?.key ?? null;
      (parent ? parent.children : roots).push(it);
      items.push(it);
      stack.push(it);
      touch(i);
      ctxOwner = it;
      return;
    }
    const c = CTX_RE.exec(line);
    if (c && ctxOwner && ctxOwner.ctxEnd === i && width(c[1]) >= ctxOwner.indent) {
      ctxOwner.context.push(c[2]);
      ctxOwner.ctxEnd = i + 1;
      touch(i);
      return;
    }
    ctxOwner = null;
    if (!line.trim()) return;
    // Free text: belongs to the items it is indented under, ends the others.
    const w = width(leading(line));
    while (stack.length && stack[stack.length - 1].indent >= w) stack.pop();
    touch(i);
  });

  const byRef = new Map<string, Item>();
  for (const it of items) if (it.id && !byRef.has(it.id)) byRef.set(it.id, it);
  const taken = new Set(byRef.keys());
  const seen = new Map<string, number>();
  for (const it of items) {
    if (it.id && byRef.get(it.id) === it) continue;
    // A duplicate id typed by hand is treated as missing: it gets its own on the next write.
    // The scope is the ticket, or the top item (a section's title in files from before one tree).
    let root = it;
    while (root.parent) root = root.parent;
    const scope = it.home && it.home !== it ? it.home.ticket!.key : root !== it ? root.text : "";
    const seed = `${scope}\0${it.text}`;
    const n = (seen.get(seed) ?? 0) + 1;
    seen.set(seed, n);
    it.ref = derivedId(`${seed}\0${n}`, taken);
    if (it.id) it.id = null;
    taken.add(it.ref);
    byRef.set(it.ref, it);
  }
  return { lines, roots, items, byRef };
}

export function outlineText(o: Outline | string[]): string {
  const lines = Array.isArray(o) ? o : o.lines;
  return lines.length ? lines.join("\n").replace(/\n*$/, "\n") : "";
}

/** What an operation's compare-and-swap checks: the item's own line and context, not where it sits. */
export function ownContent(it: Item): string {
  return `${it.check ?? "-"}|${it.text}\n${it.context.join("\n")}`;
}

export function ownHash(it: Item): string {
  return crypto.createHash("sha256").update(ownContent(it)).digest("hex").slice(0, 12);
}

export function formatItemLine(indent: string, check: Check, text: string, id: string | null): string {
  const box = check === null ? "" : `[${check}] `;
  const body = `${box}${text}`.replace(/\s+$/, "");
  return `${indent}- ${body}${id ? `${body ? " " : ""}^${id}` : ""}`;
}

function contextLines(indent: string, context: string[]): string[] {
  return context.map((c) => (c ? `${indent}  > ${c}` : `${indent}  >`));
}

export const spaces = (n: number): string => " ".repeat(Math.max(0, n));

// ---------- the tree as data ----------

export function ancestors(it: Item): Item[] {
  const out: Item[] = [];
  for (let p = it.parent; p; p = p.parent) out.unshift(p);
  return out;
}

/** The item that stands for a ticket (the first one, if the key is there twice). */
export function ticketItem(o: Outline, key: string): Item | null {
  const k = key.toUpperCase();
  return o.items.find((it) => it.ticket?.key === k) ?? null;
}

/** The ticket items over this one, nearest first (not the item itself). */
export function ticketsAbove(it: Item): Item[] {
  const out: Item[] = [];
  for (let p = it.parent; p; p = p.parent) if (p.ticket) out.push(p);
  return out;
}

// ---------- line operations (each returns new lines; parse again to see the result) ----------

/** Writes every derived id into its line. Returns the lines unchanged when all items have ids. */
export function withIds(o: Outline): string[] {
  const lines = [...o.lines];
  for (const it of o.items) {
    if (it.id) continue;
    lines[it.line] = formatItemLine(leading(lines[it.line]), it.check, it.text, it.ref);
  }
  return lines;
}

export function setItem(o: Outline, it: Item, patch: { text?: string; check?: Check; context?: string[] }): string[] {
  const lines = [...o.lines];
  const ws = leading(lines[it.line]);
  const check = patch.check === undefined ? it.check : patch.check;
  lines[it.line] = formatItemLine(ws, check, patch.text ?? it.text, it.id ?? it.ref);
  if (patch.context) lines.splice(it.line + 1, it.ctxEnd - it.line - 1, ...contextLines(ws, patch.context));
  return lines;
}

/** The subtree's lines re-indented so the item sits at `indent` columns. */
function reindent(lines: string[], from: number, to: number, base: number, indent: number): string[] {
  return lines.slice(from, to).map((l) => {
    if (!l.trim()) return "";
    const w = width(leading(l));
    return spaces(Math.max(indent, w - base + indent)) + l.slice(leading(l).length);
  });
}

/** Where the subtree block ends without its trailing blank lines. */
function blockEnd(lines: string[], from: number, to: number): number {
  let e = to;
  while (e > from + 1 && !lines[e - 1].trim()) e--;
  return e;
}

export interface Place {
  /** The new parent; null for the top level. */
  parent: string | null;
  /** Position among the parent's children; past the end (or omitted) appends. */
  index?: number;
}

/** Line index and indentation for a new child of `place`, in `o`. */
function slot(o: Outline, place: Place): { at: number; indent: number } {
  let siblings: Item[];
  let indent: number;
  let after: number;
  if (place.parent) {
    const p = o.byRef.get(place.parent);
    if (!p) throw new UserError(`No item ^${place.parent}.`);
    siblings = p.children;
    indent = siblings[0]?.indent ?? p.indent + 2;
    after = blockEnd(o.lines, p.line, p.end);
  } else {
    siblings = o.roots;
    indent = 0;
    after = o.lines.length;
    while (after > 0 && !o.lines[after - 1].trim()) after--;
  }
  const i = place.index === undefined ? siblings.length : Math.max(0, Math.min(place.index, siblings.length));
  if (i < siblings.length) return { at: siblings[i].line, indent: siblings[i].indent };
  if (siblings.length) {
    // After the last sibling, at its own indentation (hand-indented siblings may differ).
    const last = siblings[siblings.length - 1];
    return { at: blockEnd(o.lines, last.line, last.end), indent: last.indent };
  }
  return { at: after, indent };
}

export interface NewItem {
  id: string;
  check: Check;
  text: string;
  context?: string[];
  children?: NewItem[];
}

function renderNew(n: NewItem, indent: number): string[] {
  const ws = spaces(indent);
  return [formatItemLine(ws, n.check, n.text, n.id), ...contextLines(ws, n.context ?? []), ...(n.children ?? []).flatMap((c) => renderNew(c, indent + 2))];
}

export function insertItem(o: Outline, place: Place, item: NewItem): string[] {
  const { at, indent } = slot(o, place);
  return spliceBlock([...o.lines], at, renderNew(item, indent));
}

/** Inserts lines at `at`; a top item right after a title or other text gets a blank line before it. */
function spliceBlock(lines: string[], at: number, block: string[]): string[] {
  const prev = at > 0 ? lines[at - 1] : "";
  const afterText = prev.trim() !== "" && !ITEM_RE.test(prev) && !CTX_RE.test(prev) && /^- /.test(block[0] ?? "");
  lines.splice(at, 0, ...(afterText ? [""] : []), ...block);
  return lines;
}

export function removeItem(o: Outline, it: Item): string[] {
  const lines = [...o.lines];
  lines.splice(it.line, blockEnd(lines, it.line, it.end) - it.line);
  return lines;
}

/** The subtree as a NewItem (ids kept), e.g. to put it back after a delete. */
export function snapshot(it: Item): NewItem {
  return { id: it.id ?? it.ref, check: it.check, text: it.text, context: [...it.context], children: it.children.map(snapshot) };
}

/** Moves an item with its children and context to `place` (computed after it is taken out). */
export function moveItem(o: Outline, it: Item, place: Place): string[] {
  if (place.parent) {
    for (let p: Item | null | undefined = o.byRef.get(place.parent); p; p = p.parent) {
      if (p === it) throw new UserError("An item cannot move under itself.");
    }
  }
  const end = blockEnd(o.lines, it.line, it.end);
  const block = o.lines.slice(it.line, end);
  // The place is resolved without the item: `index` counts the siblings that remain.
  const rest = [...o.lines];
  rest.splice(it.line, end - it.line);
  const without = parseOutline(outlineText(rest));
  // Ids derived from text stay the same across the reparse; written ids too.
  const { at, indent } = slot(without, place);
  return spliceBlock(rest, at, reindent(block, 0, block.length, it.indent, indent));
}
