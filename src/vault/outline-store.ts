// outline.md on disk, and loops.md kept in step with it (LFLOW-024).
//
// outline.md is the source of truth. loops.md lists the same open loops one line each and stays
// editable by hand: a read merges what changed there since lf last wrote it (the baseline, one
// line per loop id in .lf/state.json) into the outline in memory, and the next write stores both
// files. A loop edited in both files since the baseline is a conflict: it is left alone in both
// and every operation on it is refused until one side is made to agree. A loop line deleted from
// loops.md removes the item and everything under it from the outline; the vault's git has it.
//
// Reads never write. Every write is a compare-and-swap of both files: if either changed after it
// was read, the operation runs again on the fresh content.

import path from "node:path";
import { ConflictError, contentHash, readTextIfExists, writeFileAtomic } from "../util.ts";
import { ME, OPEN_RE, formatLoop, formatLoopItem, parseLoop, splitLeadingTag } from "./loopfields.ts";
import type { Loop } from "./loopfields.ts";
import {
  NO_TICKET, OUTLINE_FILE, OUTLINE_HEADER, addSection, derivedId, findSection, insertItem, moveItem, outlineText, parseOutline, removeItem,
  sectionRef, setItem, withIds,
} from "./outline.ts";
import type { Item, NewItem, Outline, Place, Section } from "./outline.ts";
import { loadState, saveState } from "./state.ts";
import { findTicket } from "./store.ts";

export const LOOPS_FILE = "loops.md";

const LOOPS_HEADER = `# Open loops

<!-- One line per loop: id · opened · ticket · #branch · what · from WHO · by WHEN · after Ln · else: WHAT TO DO.
     Edit freely; \`lf done\` / \`lf bump\` / \`lf loop\` keep the format. The same loops live in outline.md,
     with the steps around them; an edit here goes there too. Closed loops go to the ticket's ## Log. -->
`;

export interface Model {
  vault: string;
  o: Outline;
  /** Hashes of the two files as read: the write goes through only if both are unchanged. */
  outlineHash: string;
  loopsHash: string;
  outlineExists: boolean;
  /** loops.md as read (null when absent), and the loop id of each of its open-loop lines. */
  loopsLines: string[] | null;
  lineIds: Map<number, string>;
  /** Loop id -> its loops.md line as lf last wrote it; null when lf never wrote it. */
  base: Record<string, string> | null;
  /** Loops edited in both files since the baseline. */
  conflicts: Set<string>;
  /** Whether the outline differs from outline.md (a merge from loops.md or an operation). */
  changed: boolean;
  /** What the operations did, for the commit message. */
  summary: string[];
}

// ---------- items as loops ----------

/** An item's own branch tag: "#android …" at the start or a "#android" field. */
export function ownTag(text: string): string | null {
  const lead = splitLeadingTag(text);
  if (lead.tag) return lead.tag;
  const m = /(?:^| · )#([\p{L}\p{N}_-]+)(?: · |$)/u.exec(text);
  return m ? m[1] : null;
}

/** The tag an item gets from the closest tagged parent. */
export function inheritedTag(it: Item): string | null {
  for (let p = it.parent; p; p = p.parent) {
    const t = ownTag(p.text);
    if (t) return t;
  }
  return null;
}

/** The item as a loop when it is one: a task with a deadline. Closed ones only with `closed`. */
export function loopOf(it: Item, opts: { closed?: boolean } = {}): Loop | null {
  if (it.check === null || (it.check === "x" && !opts.closed)) return null;
  const p = parseLoop(it.text);
  if (!p.due) return null;
  const loop: Loop = { ...p, id: it.ref, key: it.section.key, tag: p.tag ?? inheritedTag(it) };
  loop.raw = formatLoop(loop);
  return loop;
}

export function openLoops(o: Outline): Array<Loop & { item: Item }> {
  const out: Array<Loop & { item: Item }> = [];
  for (const it of o.items) {
    const l = loopOf(it);
    if (l) out.push({ ...l, item: it });
  }
  return out;
}

/** The section for a ticket (or the "No ticket" one), created at the end when missing. */
export function ensureSection(m: Model, key: string | null): Section {
  const found = key ? m.o.sections.find((s) => s.key === key) : m.o.sections.find((s) => !s.key && s.title === NO_TICKET);
  if (found) return found;
  const title = key ? findTicket(m.vault, key)?.title ?? "" : NO_TICKET;
  apply(m, addSection(m.o, key, title));
  return m.o.sections[m.o.sections.length - 1];
}

/** Where a new loop goes: right after the step it follows, under its branch, or at the end. */
export function loopPlace(m: Model, s: Section, tag: string | null, after: string | null): Place {
  const prev = after ? m.o.byRef.get(after) : undefined;
  if (prev && prev.section === s) {
    const siblings = prev.parent ? prev.parent.children : s.items;
    return { parent: prev.parent?.ref ?? null, section: sectionRef(s), index: siblings.indexOf(prev) + 1 };
  }
  if (tag) {
    const branch = m.o.items.find((it) => it.section === s && it.text === `#${tag}`);
    if (branch) return { parent: branch.ref };
  }
  return { parent: null, section: sectionRef(s) };
}

/** Replaces the outline's lines in memory and parses them again. */
export function apply(m: Model, lines: string[]): void {
  m.o = parseOutline(outlineText(lines));
  m.changed = true;
}

/** Writes a loop's fields into its item, moving it when its ticket changed. */
export function setLoop(m: Model, it: Item, l: Loop): void {
  const ref = it.ref;
  if (l.key !== it.section.key) {
    const s = ensureSection(m, l.key);
    apply(m, moveItem(m.o, m.o.byRef.get(ref)!, { parent: null, section: sectionRef(s) }));
  }
  const now = m.o.byRef.get(ref)!;
  apply(m, setItem(m.o, now, { text: formatLoopItem(l, inheritedTag(now)) }));
}

export function addLoopItem(m: Model, l: Loop, place?: Place): Item {
  const s = ensureSection(m, l.key);
  const where = place ?? loopPlace(m, s, l.tag, l.after);
  const parent = where.parent ? m.o.byRef.get(where.parent) ?? null : null;
  const item: NewItem = { id: l.id, check: " ", text: formatLoopItem(l, parent ? ownTag(parent.text) ?? inheritedTag(parent) : null) };
  apply(m, insertItem(m.o, where, item));
  return m.o.byRef.get(l.id)!;
}

// ---------- reading ----------

/** Reads both files and merges what changed in loops.md since lf last wrote it. Writes nothing. */
export function readModel(vault: string): Model {
  const otext = readTextIfExists(path.join(vault, OUTLINE_FILE));
  const ltext = readTextIfExists(path.join(vault, LOOPS_FILE));
  const m: Model = {
    vault, o: parseOutline(otext ?? ""), outlineHash: contentHash(otext), loopsHash: contentHash(ltext), outlineExists: otext !== null,
    loopsLines: ltext === null ? null : ltext.replace(/\n$/, "").split("\n"), lineIds: new Map(), base: loadState(vault).loopsBase ?? null,
    conflicts: new Set(), changed: false, summary: [],
  };
  if (m.loopsLines) mergeLoops(m);
  return m;
}

function mergeLoops(m: Model): void {
  const lines = m.loopsLines!;
  const taken = new Set(m.o.byRef.keys());
  const seen = new Map<string, number>();
  const parsed: Array<{ i: number; raw: string; loop: Loop }> = [];
  lines.forEach((line, i) => {
    const match = OPEN_RE.exec(line.trim());
    if (!match) return;
    const raw = line.trim();
    const loop = parseLoop(match[1]);
    if (!loop.id) {
      const n = (seen.get(raw) ?? 0) + 1;
      seen.set(raw, n);
      loop.id = derivedId(`${LOOPS_FILE}\0${raw}\0${n}`, taken);
    }
    taken.add(loop.id);
    m.lineIds.set(i, loop.id);
    parsed.push({ i, raw, loop });
  });
  const base = m.base;
  // Without a baseline lf cannot tell which side changed a loop both files have: the outline wins.
  const trustLines = base !== null || !m.outlineExists;
  for (const { raw, loop } of parsed) {
    const was = base?.[loop.id];
    if (was === raw) continue;
    const it = m.o.byRef.get(loop.id);
    if (!it) {
      // A new line, or one whose item is gone from the outline (then the write drops the line).
      if (was === undefined) addLoopItem(m, { ...loop, key: loop.key });
      continue;
    }
    if (it.check !== " " || !trustLines) continue;
    const now = loopOf(it);
    const gen = now?.raw ?? null;
    if (gen === raw) continue;
    if (was !== undefined && gen !== was) {
      m.conflicts.add(loop.id);
      continue;
    }
    setLoop(m, it, { ...loop, created: loop.created || now?.created || "" });
  }
  if (base) {
    const present = new Set(parsed.map((p) => p.loop.id));
    for (const id of Object.keys(base)) {
      const it = m.o.byRef.get(id);
      if (present.has(id) || !it || !loopOf(it)) continue;
      apply(m, removeItem(m.o, it));
      m.summary.push(`removed ^${id} with what was under it (its line was deleted from loops.md)`);
    }
  }
}

// ---------- writing ----------

/** Test hook: runs between an operation's read and its write, to simulate a concurrent edit. */
export const outlineTestHooks: { beforeWrite: (() => void) | null } = { beforeWrite: null };

/** Called after every successful write (the CLI commits at once, the web UI after a pause). */
export const outlineHooks: { afterWrite: ((vault: string, summary: string[]) => void) | null } = { afterWrite: null };

/** loops.md as it should be for this outline: each open loop's line in place, new ones at the end. */
export function loopsTextFor(m: Model, o: Outline): string {
  const open = new Map(openLoops(o).map((l) => [l.id, l.raw!] as const));
  const out: string[] = [];
  const emitted = new Set<string>();
  const src = m.loopsLines ?? LOOPS_HEADER.split("\n");
  src.forEach((line, i) => {
    const id = m.lineIds.get(i);
    if (id === undefined) return void out.push(line);
    if (emitted.has(id)) return;
    if (m.conflicts.has(id)) {
      out.push(line);
      emitted.add(id);
      return;
    }
    const gen = open.get(id);
    if (gen !== undefined) {
      out.push(gen);
      emitted.add(id);
    }
  });
  for (const [id, gen] of open) if (!emitted.has(id) && !m.conflicts.has(id)) out.push(gen);
  return out.join("\n").replace(/\n*$/, "\n");
}

/** Stores the model in both files if neither changed since it was read. False when one did. */
export function writeModel(m: Model): boolean {
  const o = parseOutline(outlineText(withIds(m.o)));
  if (!o.lines.length && !m.outlineExists && !m.loopsLines) return true;
  const outline = outlineText(o.lines.length ? o.lines : [OUTLINE_HEADER.trimEnd()]);
  const loops = loopsTextFor(m, o);
  const ofile = path.join(m.vault, OUTLINE_FILE);
  const lfile = path.join(m.vault, LOOPS_FILE);
  if (contentHash(readTextIfExists(ofile)) !== m.outlineHash || contentHash(readTextIfExists(lfile)) !== m.loopsHash) return false;
  if (contentHash(outline) !== m.outlineHash) writeFileAtomic(ofile, outline);
  if (contentHash(loops) !== m.loopsHash) writeFileAtomic(lfile, loops);
  const base: Record<string, string> = {};
  for (const l of openLoops(o)) if (!m.conflicts.has(l.id)) base[l.id] = l.raw!;
  for (const id of m.conflicts) if (m.base?.[id] !== undefined) base[id] = m.base[id];
  const state = loadState(m.vault);
  state.loopsBase = base;
  saveState(m.vault, state);
  m.o = o;
  return true;
}

/**
 * Read → change → compare-and-swap write, re-applied on a concurrent change. `op` returns what it
 * acts on as read (an item's own content): if that differs on a retry, the operation is refused.
 */
export function editModel<T>(vault: string, op: (m: Model) => { result: T; target?: string }, refused: (now: string) => string): T {
  let pinned: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const m = readModel(vault);
    const { result, target } = op(m);
    if (target !== undefined) {
      if (pinned === undefined) pinned = target;
      else if (pinned !== target) throw new ConflictError(refused(target));
    }
    const hook = outlineTestHooks.beforeWrite;
    outlineTestHooks.beforeWrite = null;
    hook?.();
    if (writeModel(m)) {
      outlineHooks.afterWrite?.(vault, m.summary);
      return result;
    }
  }
  throw new ConflictError("outline.md or loops.md keeps changing while lf writes it: nothing was changed. Try again.");
}

/** Refuses an operation on a loop that was edited in both files since lf last wrote them. */
export function assertNoConflict(m: Model, id: string): void {
  if (m.conflicts.has(id)) {
    throw new ConflictError(
      `${id} was edited both in loops.md and in outline.md since lf last wrote them. Make the two agree (edit either one), then run it again.`,
    );
  }
}

export { ME };
