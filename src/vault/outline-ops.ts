// Operations on outline items by id: what the Outline editor (and `lf outline`) sends. A batch of
// operations is one compare-and-swap write; an operation that names `expect` (the item's own-content
// hash as the client saw it) is refused when the item changed since.
//
// Loop rules apply on the way: a task that gets a readable "by" becomes a loop ("by tomorrow" is
// turned into a date, "opened" is stamped), checking a loop off writes it to the ticket's Log like
// `lf done`, and a ticket that gets a loop goes on the board.
//
// Tickets are items too ("KEY · title" bullets): "ticket" makes one (a new local ticket, or an
// existing one by key, or an item turned into a new ticket), "check" on one closes or reopens it,
// and a ticket put under another one gets that one as its `parent:` in notes.md.

import { ConflictError, UserError } from "../util.ts";
import { ME, dueAt, fmtStamp, parseLoop, parseWhen, withDone } from "./loopfields.ts";
import { logClosed, logReopened } from "./loops.ts";
import { isTracked, oneLine, parentKey, setParentKey, setTracked } from "./notes.ts";
import { insertItem, moveItem, newId, ownHash, removeItem, setItem, snapshot, ticketItem, ticketText, ticketsAbove } from "./outline.ts";
import type { Check, Item, NewItem, Place } from "./outline.ts";
import { apply, assertNoConflict, editModel, loopOf } from "./outline-store.ts";
import type { Model } from "./outline-store.ts";
import { KEY_ONLY_RE, createLocalTicket, findTicket, localPrefix } from "./store.ts";

export interface PlaceIn {
  /** Put it right after this item, as its next sibling. */
  after?: string;
  /** Or: under this parent (null: the top level) at `index` (counted without the moved item). */
  parent?: string | null;
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
  /**
   * A ticket item: `id` turns that item into a new local ticket (its text is the title); `key` puts
   * an existing ticket at `place`; with neither, a new local ticket called `title` goes there.
   */
  | { op: "ticket"; id?: string; key?: string; title?: string; place?: PlaceIn; temp?: string };

export interface OpsResult {
  /** Temporary ids of inserted items -> their real ids. */
  ids: Record<string, string>;
  /** Subtrees removed by delete ops, for undo. */
  removed: Record<string, NewItem>;
  /** Keys of local tickets the operations created. */
  created: string[];
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

const ID_RE = /^[A-Za-z0-9]{2,16}$/;

function checkOf(v: unknown): Check {
  if (v === null || v === " " || v === "x") return v;
  throw new UserError(`check is " ", "x" or null (got ${JSON.stringify(v)}).`);
}

/** Context lines as given, each on one line. */
function contextOf(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new UserError("context is a list of lines.");
  return v.map((c) => String(c).replace(/\r?\n/g, " "));
}

/**
 * A note's text that starts with "[ ] " or "[x] " would read back as a task: the box is taken as
 * meant, and the item becomes that task.
 */
function boxFromText(text: string, check: Check): { text: string; check: Check } {
  const m = /^\[([ xX])\] (.*)$/.exec(text);
  if (check !== null || !m) return { text, check };
  return { text: m[2], check: m[1] === " " ? " " : "x" };
}

function toNew(t: TreeIn, taken: Set<string>, now: Date, workdayEnd?: string): NewItem {
  if (!t || typeof t !== "object") throw new UserError("item is an object: { text, check, context?, children? }.");
  if (t.id !== undefined && (typeof t.id !== "string" || !ID_RE.test(t.id))) throw new UserError(`Not an id: ${JSON.stringify(t.id)}.`);
  if (t.children !== undefined && !Array.isArray(t.children)) throw new UserError("children is a list.");
  const boxed = boxFromText(oneLine(String(t.text ?? "")), checkOf(t.check));
  const id = t.id && !taken.has(t.id) ? t.id : newId(taken);
  taken.add(id);
  return {
    id, check: boxed.check, text: normalizeTaskText(boxed.text, boxed.check, now, workdayEnd), context: contextOf(t.context),
    children: (t.children ?? []).map((c) => toNew(c, taken, now, workdayEnd)),
  };
}

/** `moving`: the item being moved, which does not count among the siblings (see moveItem). */
function resolvePlace(m: Model, p: PlaceIn, ids: Record<string, string>, moving?: Item): Place {
  if (!p || typeof p !== "object") throw new UserError("place is { after } or { parent, section, index }.");
  const real = (id: string): string => ids[id] ?? id;
  if (p.after) {
    const it = m.o.byRef.get(real(p.after));
    if (!it) throw new UserError(`No item ^${p.after}.`);
    if (it === moving) throw new UserError("An item cannot go after itself.");
    const siblings = (it.parent ? it.parent.children : m.o.roots).filter((s) => s !== moving);
    return { parent: it.parent?.ref ?? null, index: siblings.indexOf(it) + 1 };
  }
  return { parent: p.parent ? real(p.parent) : null, index: p.index };
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

/** True when `parent` already sits (by notes.md parents) under `key`. */
function wouldCycle(vault: string, key: string, parent: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | null = parent; cur && !seen.has(cur); ) {
    if (cur === key) return true;
    seen.add(cur);
    const t = findTicket(vault, cur);
    cur = t ? parentKey(t) : null;
  }
  return false;
}

/** A bullet typed as just the key of a ticket the vault has gets its title. */
function expandKey(vault: string, text: string, check: Check): string {
  if (check !== null || !KEY_ONLY_RE.test(text.trim())) return text;
  const t = findTicket(vault, text.trim());
  return t ? ticketText(t.key, t.title) : text;
}

/** Ticket items in the subtree of these items (themselves included). */
function ticketsIn(m: Model, refs: string[]): Item[] {
  const out: Item[] = [];
  const walk = (it: Item): void => {
    if (it.ticket) out.push(it);
    it.children.forEach(walk);
  };
  for (const r of refs) {
    const it = m.o.byRef.get(r);
    if (it) walk(it);
  }
  return out;
}

export function applyOps(vault: string, ops: Op[], now: Date, opts: { workdayEnd?: string } = {}): OpsResult {
  if (!Array.isArray(ops) || !ops.length) throw new UserError("No operations.");
  let effects: Effect[] = [];
  /** Items inserted, moved or turned into tickets: the tickets among them (and under them) get their parent. */
  let placed: string[] = [];
  let parents = new Map<string, string | null>();
  const created: string[] = [];
  const made = new Map<number, string>();
  const result = editModel(vault, (m) => {
    effects = [];
    const ids: Record<string, string> = {};
    const removed: Record<string, NewItem> = {};
    placed = [];
    const real = (id: string): string => ids[id] ?? id;
    created.length = 0;
    for (const [opIndex, op] of ops.entries()) {
      // A local ticket is made once, even when the write is retried after a concurrent change.
      const newTicket = (title: string): string => {
        const key = made.get(opIndex) ?? createLocalTicket(vault, localPrefix(vault), title).key;
        made.set(opIndex, key);
        created.push(key);
        return key;
      };
      switch (op.op) {
        case "insert": {
          const taken = new Set(m.o.byRef.keys());
          const n = toNew(op.item, taken, now, opts.workdayEnd);
          n.text = expandKey(vault, n.text, n.check);
          apply(m, insertItem(m.o, resolvePlace(m, op.place, ids), n));
          if (op.temp) ids[op.temp] = n.id;
          // The client's own id comes back too, so it can see when a clash made the server pick another.
          if (op.item.id) ids[op.item.id] = n.id;
          const it = m.o.byRef.get(n.id)!;
          if (loopOf(it)) effects.push({ kind: "track", key: it.key });
          placed.push(n.id);
          m.summary.push(`add ${n.id}: ${n.text}`);
          break;
        }
        case "text": {
          const it = item(m, real(op.id), op.expect);
          const boxed = boxFromText(oneLine(String(op.text ?? "")), it.check);
          const text = expandKey(vault, normalizeTaskText(boxed.text, boxed.check, now, opts.workdayEnd), boxed.check);
          if (text === it.text && boxed.check === it.check) break;
          apply(m, setItem(m.o, it, { text, check: boxed.check }));
          const now2 = m.o.byRef.get(it.ref)!;
          if (loopOf(now2) && !loopOf(it)) effects.push({ kind: "track", key: now2.key });
          // Typed into a ticket's key (or out of one): it moved in the ticket tree.
          if (!!now2.ticket !== !!it.ticket || now2.ticket?.key !== it.ticket?.key) placed.push(it.ref);
          m.summary.push(`edit ${it.ref}: ${text}`);
          break;
        }
        case "check": {
          const it = item(m, real(op.id), op.expect);
          checkOf(op.check);
          if (it.ticket) {
            // A ticket item stays a bullet: checking it off closes it ("✓"), unchecking reopens it.
            const closed = op.check === "x";
            if (closed === it.ticket.closed) break;
            apply(m, setItem(m.o, it, { text: ticketText(it.ticket.key, it.ticket.title, closed) }));
            m.summary.push(`${closed ? "close" : "reopen"} ${it.ticket.key}`);
            break;
          }
          if (it.check === op.check) break;
          const wasLoop = loopOf(it);
          const text = withDone(normalizeTaskText(it.text, op.check, now, opts.workdayEnd), op.check === "x" ? fmtStamp(now) : null);
          apply(m, setItem(m.o, it, { check: op.check, text }));
          const after = m.o.byRef.get(it.ref)!;
          const closedLoop = loopOf(after, { closed: true });
          if (wasLoop && op.check === "x") effects.push({ kind: "closed", key: it.key, loop: wasLoop, outcome: op.outcome });
          else if (it.check === "x" && op.check === " " && closedLoop) effects.push({ kind: "reopened", key: it.key, loop: closedLoop });
          else if (loopOf(after)) effects.push({ kind: "track", key: it.key });
          m.summary.push(`${op.check === "x" ? "check" : op.check === " " ? "uncheck" : "untask"} ${it.ref}`);
          break;
        }
        case "context": {
          const it = item(m, real(op.id), op.expect);
          const context = contextOf(op.context ?? []);
          apply(m, setItem(m.o, it, { context }));
          m.summary.push(`note ${it.ref}`);
          break;
        }
        case "move": {
          const it = item(m, real(op.id));
          apply(m, moveItem(m.o, it, resolvePlace(m, op.place, ids, it)));
          m.summary.push(`move ${it.ref}`);
          placed.push(it.ref);
          break;
        }
        case "delete": {
          const it = item(m, real(op.id), op.expect);
          removed[it.ref] = snapshot(it);
          apply(m, removeItem(m.o, it));
          m.summary.push(`delete ${it.ref}: ${it.text}`);
          break;
        }
        case "ticket": {
          if (op.id) {
            // An item becomes a new local ticket named after its text; what is under it stays under it.
            const it = item(m, real(op.id));
            if (it.ticket) throw new UserError(`It is already ${it.ticket.key}.`);
            const title = (loopOf(it)?.text ?? it.text).trim();
            const key = newTicket(title);
            apply(m, setItem(m.o, it, { check: null, text: ticketText(key, title) }));
            placed.push(it.ref);
            m.summary.push(`ticket ${key} from ^${it.ref}`);
            break;
          }
          let key: string;
          let title: string;
          if (op.key) {
            key = op.key.trim().toUpperCase();
            if (!KEY_ONLY_RE.test(key)) throw new UserError(`Not a ticket key: ${op.key}`);
            if (ticketItem(m.o, key)) throw new UserError(`${key} is in the outline already.`);
            title = oneLine(op.title ?? "") || findTicket(vault, key)?.title || "";
          } else {
            title = oneLine(op.title ?? "");
            if (!title) throw new UserError("A new ticket needs a title.");
            key = newTicket(title);
          }
          const id = newId(new Set(m.o.byRef.keys()));
          apply(m, insertItem(m.o, resolvePlace(m, op.place ?? { parent: null }, ids), { id, check: null, text: ticketText(key, title) }));
          if (op.temp) ids[op.temp] = id;
          placed.push(id);
          m.summary.push(`ticket ${key}`);
          break;
        }
        default:
          throw new UserError(`Unknown operation: ${(op as { op: string }).op}`);
      }
    }
    // Where each moved or new ticket now sits in the ticket tree (the nearest ticket above it).
    parents = new Map();
    for (const t of ticketsIn(m, placed)) {
      const key = t.ticket!.key;
      // A ticket that is in the outline twice: the first place counts.
      if (ticketItem(m.o, key) !== t) continue;
      parents.set(key, ticketsAbove(t)[0]?.ticket?.key ?? null);
    }
    return { result: { ids, removed, created: [...created] } };
  }, (now2) => `That item changed meanwhile (now: ${now2}). Reload and try again.`);

  // The ticket tree in notes.md follows the outline: `parent:` is the nearest ticket above.
  for (const [key, parent] of parents) {
    const t = findTicket(vault, key);
    if (!t || parentKey(t) === parent) continue;
    if (parent !== null && (!findTicket(vault, parent) || wouldCycle(vault, key, parent))) continue;
    setParentKey(t, parent);
  }

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
