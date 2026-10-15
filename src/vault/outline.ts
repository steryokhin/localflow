// outline.md: one plain-text tree of tickets → actions → subtasks → waits (LFLOW-024).
//
//   ## PROJ-1 · Login crash on swipe
//   - [x] reproduce on iOS 26 ^k3f9
//   - [ ] research issue #123 ^m4p2
//     > Tom: the crash is in the swipe handler
//     - [ ] wait for Jim's review · from Jim · by 2026-10-15 12:00 · else: ping in #ios ^L7
//
// A "## KEY · title" heading is a ticket root ("## title" without a key is a free root; a trailing
// " ✓" marks it closed). Items are "- [ ]" / "- [x]" tasks or plain "- " bullets, nested by
// indentation; "> " lines right under an item are its context. "^id" at the end of an item is its
// permanent id. A task with a "by" field is a loop (see loops.ts for the fields).
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
  section: Section;
  children: Item[];
}

export interface Section {
  /** Index of the "## " line. */
  line: number;
  key: string | null;
  title: string;
  closed: boolean;
  items: Item[];
  /** First line of the next section (or the end of the file). */
  end: number;
}

export interface Outline {
  lines: string[];
  sections: Section[];
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

export function parseHeading(text: string): { key: string | null; title: string; closed: boolean } {
  const closed = CLOSED_MARK_RE.test(text);
  const body = text.replace(CLOSED_MARK_RE, "").trim();
  const m = KEY_HEAD_RE.exec(body);
  return m ? { key: m[1], title: (m[2] ?? "").trim(), closed } : { key: null, title: body, closed };
}

export function formatHeading(key: string | null, title: string, closed: boolean): string {
  const body = key ? (title ? `${key} · ${title}` : key) : title;
  return `## ${body}${closed ? " ✓" : ""}`;
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
  const lines = text.replace(/\n$/, "").split("\n");
  if (text === "") lines.length = 0;
  const sections: Section[] = [];
  const items: Item[] = [];
  let section: Section | null = null;
  let stack: Item[] = [];
  // The item whose context block is still open (its line or context lines came last).
  let ctxOwner: Item | null = null;

  const touch = (i: number): void => {
    for (const it of stack) it.end = i + 1;
  };

  lines.forEach((line, i) => {
    const h = HEAD_RE.exec(line);
    if (h) {
      if (section) section.end = i;
      section = { line: i, ...parseHeading(h[1]), items: [], end: lines.length };
      sections.push(section);
      stack = [];
      ctxOwner = null;
      return;
    }
    if (!section) return;
    const m = ITEM_RE.exec(line);
    if (m) {
      const indent = width(m[1]);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1] ?? null;
      const { text: body, id } = splitId(m[3]);
      const it: Item = {
        id, ref: id ?? "", line: i, indent, check: m[2] === undefined ? null : m[2] === " " ? " " : "x", text: body, context: [],
        ctxEnd: i + 1, end: i + 1, parent, section, children: [],
      };
      (parent ? parent.children : section.items).push(it);
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
    const seed = `${it.section.key ?? it.section.title}\0${it.text}`;
    const n = (seen.get(seed) ?? 0) + 1;
    seen.set(seed, n);
    it.ref = derivedId(`${seed}\0${n}`, taken);
    if (it.id) it.id = null;
    taken.add(it.ref);
    byRef.set(it.ref, it);
  }
  return { lines, sections, items, byRef };
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

export function sectionRef(s: Section): string {
  return s.key ?? `#${s.title}`;
}

export function findSection(o: Outline, ref: string): Section | null {
  if (ref.startsWith("#")) return o.sections.find((s) => !s.key && s.title === ref.slice(1)) ?? null;
  return o.sections.find((s) => s.key === ref.toUpperCase()) ?? null;
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
  /** The new parent; null for the section's top level. */
  parent: string | null;
  /** Section ref (key or "#title") when parent is null. */
  section?: string;
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
    const s = place.section === undefined ? null : findSection(o, place.section);
    if (!s) throw new UserError(`No section ${place.section ?? "(none given)"}.`);
    siblings = s.items;
    indent = siblings[0]?.indent ?? 0;
    // After the heading and any free text under it.
    after = blockEnd(o.lines, s.line, s.end);
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

/** Inserts lines at `at`; a block that would touch the next heading gets a blank line before it. */
function spliceBlock(lines: string[], at: number, block: string[]): string[] {
  const nextIsHeading = at < lines.length && HEAD_RE.test(lines[at]);
  lines.splice(at, 0, ...block, ...(nextIsHeading ? [""] : []));
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

export function addSection(o: Outline, key: string | null, title: string): string[] {
  const lines = [...o.lines];
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) lines.push(OUTLINE_HEADER.trimEnd());
  lines.push("", formatHeading(key, title, false));
  return lines;
}

export function setSection(o: Outline, s: Section, patch: { title?: string; closed?: boolean }): string[] {
  const lines = [...o.lines];
  lines[s.line] = formatHeading(s.key, patch.title ?? s.title, patch.closed ?? s.closed);
  return lines;
}

export function removeSection(o: Outline, s: Section): string[] {
  const lines = [...o.lines];
  let start = s.line;
  while (start > 0 && !lines[start - 1].trim()) start--;
  lines.splice(start, s.end - start);
  return lines;
}
