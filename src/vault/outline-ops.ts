// Operations on outline items by id: what the Outline editor (and `lf outline`) sends. A batch of
// operations is one compare-and-swap write; an operation that names `expect` (the item's own-content
// hash as the client saw it) is refused when the item changed since.
//
// Loop rules apply on the way: a task that gets a readable "by" becomes a loop ("by tomorrow" is
// turned into a date, "opened" is stamped), checking a loop off writes it to the ticket's Log like
// `lf done`, and a ticket that gets a loop goes on the board.

import { ConflictError, UserError } from "../util.ts";
import { ME, dueAt, fmtStamp, parseLoop, parseWhen } from "./loopfields.ts";
import { logClosed, logReopened } from "./loops.ts";
import { isTracked, oneLine, setTracked } from "./notes.ts";
import {
  addSection, findSection, insertItem, moveItem, newId, ownHash, removeItem, removeSection, setItem, setSection, snapshot,
} from "./outline.ts";
import type { Check, Item, NewItem, Place } from "./outline.ts";
import { apply, assertNoConflict, editModel, loopOf } from "./outline-store.ts";
import type { Model } from "./outline-store.ts";
import { KEY_ONLY_RE, findTicket } from "./store.ts";

export interface PlaceIn {
  /** Put it right after this item, as its next sibling. */
  after?: string;
  /** Or: under this parent (null: the section's top level) at `index` (counted without the moved item). */
  parent?: string | null;
  section?: string;
  index?: number;
}

export interface TreeIn {
  /** Kept when given (undo of a delete puts the same ids back). */
  id?: string;
  text: string;
  check: Check;
  context?: string[];
  children?: TreeIn[];
}

export type Op =
  | { op: "insert"; temp?: string; place: PlaceIn; item: TreeIn }
  | { op: "text"; id: string; text: string; expect?: string }
  | { op: "check"; id: string; check: Check; outcome?: string; expect?: string }
  | { op: "context"; id: string; context: string[]; expect?: string }
  | { op: "move"; id: string; place: PlaceIn }
  | { op: "delete"; id: string; expect?: string }
  | { op: "section"; key?: string | null; title?: string }
  | { op: "sectionSet"; section: string; title?: string; closed?: boolean }
  | { op: "sectionDelete"; section: string };

export interface OpsResult {
  /** Temporary ids of inserted items -> their real ids. */
  ids: Record<string, string>;
  /** Subtrees removed by delete ops, for undo. */
  removed: Record<string, NewItem>;
}

const BY_FIELD_RE = /(^| · )(by|до) ([^·]+?)(?= · |$)/i;

/**
 * A task's text as it is stored: a "by" that lf can read ("tomorrow", "+2h", "18:00") becomes a
 * date, and a new loop gets "opened" stamped. Anything else is kept exactly as typed.
 */
export function normalizeTaskText(text: string, check: Check, now: Date, workdayEnd?: string): string {
  const t = oneLine(text);
  if (check !== " ") return t;
  const m = BY_FIELD_RE.exec(t);
  if (!m) return t;
  let due = m[3].trim();
  let out = t;
  if (!dueAt(due)) {
    try {
      due = parseWhen(due, now, workdayEnd);
    } catch {
      return t;
    }
    out = t.slice(0, m.index) + `${m[1]}${m[2]} ${due}` + t.slice(m.index + m[0].length);
  }
  if (!parseLoop(out).created) out += ` · opened ${fmtStamp(now)}`;
  return out;
}

function toNew(t: TreeIn, taken: Set<string>, now: Date, workdayEnd?: string): NewItem {
  let id = t.id && !taken.has(t.id) ? t.id : newId(taken);
  taken.add(id);
  return {
    id, check: t.check, text: normalizeTaskText(t.text ?? "", t.check, now, workdayEnd), context: t.context ?? [],
    children: (t.children ?? []).map((c) => toNew(c, taken, now, workdayEnd)),
  };
}

/** `moving`: the item being moved, which does not count among the siblings (see moveItem). */
function resolvePlace(m: Model, p: PlaceIn, ids: Record<string, string>, moving?: Item): Place {
  const real = (id: string): string => ids[id] ?? id;
  if (p.after) {
    const it = m.o.byRef.get(real(p.after));
    if (!it) throw new UserError(`No item ^${p.after}.`);
    const siblings = (it.parent ? it.parent.children : it.section.items).filter((s) => s !== moving);
    return { parent: it.parent?.ref ?? null, section: it.section.key ?? `#${it.section.title}`, index: siblings.indexOf(it) + 1 };
  }
  return { parent: p.parent ? real(p.parent) : null, section: p.section, index: p.index };
}

function item(m: Model, id: string, expect?: string): Item {
  const it = m.o.byRef.get(id);
  if (!it) throw new ConflictError(`Item ^${id} is gone from outline.md (deleted or edited elsewhere). Reload to see the current version.`);
  if (expect !== undefined && ownHash(it) !== expect) {
    throw new ConflictError(`Item ^${id} was changed elsewhere since it was loaded (now: ${it.text}). Reload to see the current version.`);
  }
  if (loopOf(it)) assertNoConflict(m, id);
  return it;
}

interface Effect {
  kind: "closed" | "reopened" | "track";
  key: string | null;
  loop?: NonNullable<ReturnType<typeof loopOf>>;
  outcome?: string;
}

export function applyOps(vault: string, ops: Op[], now: Date, opts: { workdayEnd?: string } = {}): OpsResult {
  if (!Array.isArray(ops) || !ops.length) throw new UserError("No operations.");
  let effects: Effect[] = [];
  const result = editModel(vault, (m) => {
    effects = [];
    const ids: Record<string, string> = {};
    const removed: Record<string, NewItem> = {};
    const real = (id: string): string => ids[id] ?? id;
    for (const op of ops) {
      switch (op.op) {
        case "insert": {
          const taken = new Set(m.o.byRef.keys());
          const n = toNew(op.item, taken, now, opts.workdayEnd);
          apply(m, insertItem(m.o, resolvePlace(m, op.place, ids), n));
          if (op.temp) ids[op.temp] = n.id;
          // The client's own id comes back too, so it can see when a clash made the server pick another.
          if (op.item.id) ids[op.item.id] = n.id;
          const it = m.o.byRef.get(n.id)!;
          if (loopOf(it)) effects.push({ kind: "track", key: it.section.key });
          m.summary.push(`add ${n.id}: ${n.text}`);
          break;
        }
        case "text": {
          const it = item(m, real(op.id), op.expect);
          const text = normalizeTaskText(op.text, it.check, now, opts.workdayEnd);
          if (text === it.text) break;
          apply(m, setItem(m.o, it, { text }));
          const now2 = m.o.byRef.get(it.ref)!;
          if (loopOf(now2) && !loopOf(it)) effects.push({ kind: "track", key: now2.section.key });
          m.summary.push(`edit ${it.ref}: ${text}`);
          break;
        }
        case "check": {
          const it = item(m, real(op.id), op.expect);
          if (op.check !== null && op.check !== " " && op.check !== "x") throw new UserError(`check is " ", "x" or null.`);
          if (it.check === op.check) break;
          const wasLoop = loopOf(it);
          apply(m, setItem(m.o, it, { check: op.check, text: normalizeTaskText(it.text, op.check, now, opts.workdayEnd) }));
          const after = m.o.byRef.get(it.ref)!;
          const closedLoop = loopOf(after, { closed: true });
          if (wasLoop && op.check === "x") effects.push({ kind: "closed", key: it.section.key, loop: wasLoop, outcome: op.outcome });
          else if (it.check === "x" && op.check === " " && closedLoop) effects.push({ kind: "reopened", key: it.section.key, loop: closedLoop });
          else if (loopOf(after)) effects.push({ kind: "track", key: it.section.key });
          m.summary.push(`${op.check === "x" ? "check" : op.check === " " ? "uncheck" : "untask"} ${it.ref}`);
          break;
        }
        case "context": {
          const it = item(m, real(op.id), op.expect);
          const context = (op.context ?? []).map((c) => String(c).replace(/\r?\n/g, " "));
          apply(m, setItem(m.o, it, { context }));
          m.summary.push(`note ${it.ref}`);
          break;
        }
        case "move": {
          const it = item(m, real(op.id));
          apply(m, moveItem(m.o, it, resolvePlace(m, op.place, ids, it)));
          m.summary.push(`move ${it.ref}`);
          break;
        }
        case "delete": {
          const it = item(m, real(op.id), op.expect);
          removed[it.ref] = snapshot(it);
          apply(m, removeItem(m.o, it));
          m.summary.push(`delete ${it.ref}: ${it.text}`);
          break;
        }
        case "section": {
          const key = op.key ? op.key.trim().toUpperCase() : null;
          if (key && !KEY_ONLY_RE.test(key)) throw new UserError(`Not a ticket key: ${op.key}`);
          if (key && m.o.sections.some((s) => s.key === key)) throw new UserError(`${key} already has a section.`);
          const title = (op.title ?? "").trim() || (key ? findTicket(vault, key)?.title ?? "" : "");
          if (!key && !title) throw new UserError("A section needs a ticket key or a title.");
          apply(m, addSection(m.o, key, oneLine(title)));
          m.summary.push(`section ${key ?? title}`);
          break;
        }
        case "sectionSet": {
          const s = findSection(m.o, op.section);
          if (!s) throw new ConflictError(`No section ${op.section}. Reload to see the current version.`);
          apply(m, setSection(m.o, s, { title: op.title === undefined ? undefined : oneLine(op.title), closed: op.closed }));
          m.summary.push(`section ${op.section}${op.closed === undefined ? "" : op.closed ? " closed" : " reopened"}`);
          break;
        }
        case "sectionDelete": {
          const s = findSection(m.o, op.section);
          if (!s) throw new ConflictError(`No section ${op.section}. Reload to see the current version.`);
          if (s.items.length) throw new UserError(`${op.section} still has items: move or delete them first.`);
          apply(m, removeSection(m.o, s));
          m.summary.push(`remove section ${op.section}`);
          break;
        }
        default:
          throw new UserError(`Unknown operation: ${(op as { op: string }).op}`);
      }
    }
    return { result: { ids, removed } };
  }, (now2) => `That item changed meanwhile (now: ${now2}). Reload and try again.`);

  // After the write, as `lf done` does: the Log lines and the board.
  for (const e of effects) {
    const t = e.key ? findTicket(vault, e.key) : null;
    if (e.kind === "track") {
      if (t && !isTracked(t)) setTracked(t, true);
    } else if (e.kind === "closed") logClosed(vault, e.loop!, e.outcome ?? "", now);
    else if (e.kind === "reopened") logReopened(vault, e.loop!, now);
  }
  return result;
}

export { ME };
