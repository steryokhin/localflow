// The Outline page's API: the tree as JSON (with what each item is as a loop), a batch of edit
// operations by id, and the history (an item's or a ticket's life, a day as it was, days with changes).

import { lastWorkingDay } from "../render/loops.ts";
import { UserError } from "../util.ts";
import { ME, doneOf, dueAt, fmtDay, normalizeId } from "../vault/loopfields.ts";
import { ownHash } from "../vault/outline.ts";
import type { Item, Outline } from "../vault/outline.ts";
import { allEvents, checkedSince, itemHistory, outlineAt, ticketHistory } from "../vault/outline-history.ts";
import type { OutlineEvent } from "../vault/outline-history.ts";
import { applyOps } from "../vault/outline-ops.ts";
import type { Op } from "../vault/outline-ops.ts";
import { loopOf, readModel } from "../vault/outline-store.ts";
import { listTickets } from "../vault/store.ts";
import type { Ticket } from "../vault/store.ts";
import { refreshInbox } from "../render/inbox.ts";
import { loadConfig } from "../config.ts";

export interface ItemView {
  id: string;
  /** False while the id is only derived (written by the next save). */
  written: boolean;
  check: " " | "x" | null;
  text: string;
  context: string[];
  /** Own-content hash: sent back as `expect` with an edit. */
  own: string;
  /** When it was checked off ("done …" on its line), or null. */
  done: string | null;
  /** Set when the item stands for a ticket; `exists` is false when the vault has no such ticket. */
  ticket: { key: string; title: string; closed: boolean; exists: boolean; status: string | null; jiraStatus: string | null } | null;
  loop: {
    text: string;
    owner: string;
    due: string;
    /** Epoch ms of the deadline, or null when unreadable. */
    dueAt: number | null;
    onExpiry: string;
    tag: string | null;
    after: string | null;
    created: string;
  } | null;
  children: ItemView[];
}

export interface OutlineView {
  /** Hash of outline.md + loops.md: changes on every write, by anyone. */
  version: string;
  exists: boolean;
  /** The top-level items. */
  items: ItemView[];
  conflicts: string[];
  /** Tickets that are not in the outline yet, for "add a ticket". */
  tickets: Array<{ key: string; title: string; status: string }>;
  /** Items checked off since the last working day (the standup lens). */
  checkedSince: string[];
  standupSince: string;
  now: string;
}

function itemView(it: Item, tickets: Map<string, Ticket>): ItemView {
  const l = loopOf(it, { closed: true });
  const t = it.ticket ? tickets.get(it.ticket.key) : undefined;
  return {
    id: it.ref, written: it.id !== null, check: it.check, text: it.text, context: it.context, own: ownHash(it), done: doneOf(it.text).done,
    ticket: it.ticket ? {
      ...it.ticket, exists: !!t, status: t?.status ?? null, jiraStatus: t && typeof t.fm.jira_status === "string" ? t.fm.jira_status : null,
    } : null,
    loop: l ? {
      text: l.text, owner: l.owner, due: l.due, dueAt: dueAt(l.due)?.getTime() ?? null, onExpiry: l.onExpiry, tag: l.tag, after: l.after, created: l.created,
    } : null,
    children: it.children.map((c) => itemView(c, tickets)),
  };
}

export function treeView(vault: string, o: Outline): ItemView[] {
  const tickets = new Map(listTickets(vault).map((t) => [t.key, t] as const));
  return o.roots.map((it) => itemView(it, tickets));
}

export function outlineView(vault: string, now = new Date()): OutlineView {
  const m = readModel(vault);
  const since = fmtDay(lastWorkingDay(now));
  const inOutline = new Set(m.o.items.map((it) => it.ticket?.key).filter(Boolean));
  let checked: string[] = [];
  try {
    checked = [...checkedSince(vault, since, now)];
  } catch {
    checked = [];
  }
  return {
    version: `${m.outlineHash}.${m.loopsHash}`,
    exists: m.outlineExists,
    items: treeView(vault, m.o),
    conflicts: [...m.conflicts],
    tickets: listTickets(vault)
      .filter((t) => !inOutline.has(t.key) && t.status !== "archived")
      .map((t) => ({ key: t.key, title: t.title, status: t.status })),
    checkedSince: checked,
    standupSince: since,
    now: now.toISOString(),
  };
}

export function outlineOps(vault: string, ops: unknown, now = new Date()): { ids: Record<string, string>; removed: Record<string, unknown>; created: string[]; view: OutlineView } {
  if (!Array.isArray(ops)) throw new UserError('"ops" must be a list of operations.');
  const r = applyOps(vault, ops as Op[], now, { workdayEnd: loadConfig(vault).loops?.workdayEnd });
  if (r.created.length) refreshInbox(vault);
  return { ...r, view: outlineView(vault, now) };
}

export interface HistoryView {
  title: string;
  events: OutlineEvent[];
}

export function outlineHistory(vault: string, target: { id?: string; key?: string }, now = new Date()): HistoryView {
  if (target.key) {
    const key = target.key.toUpperCase();
    return { title: key, events: ticketHistory(vault, key, now) };
  }
  if (target.id) {
    const id = normalizeId(target.id);
    return { title: `^${id}`, events: itemHistory(vault, id, {}, now) };
  }
  throw new UserError("History of what? Give id or key.");
}

/** Days that have changes (newest first), with counts. */
export function outlineDays(vault: string, now = new Date()): Array<{ day: string; changes: number; checked: number; added: number }> {
  const days = new Map<string, { changes: number; checked: number; added: number }>();
  for (const e of allEvents(vault, now)) {
    const d = e.date.slice(0, 10);
    const c = days.get(d) ?? { changes: 0, checked: 0, added: 0 };
    c.changes++;
    if (e.kind === "checked") c.checked++;
    if (e.kind === "added") c.added++;
    days.set(d, c);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, c]) => ({ day, ...c }));
}

/** The outline at the end of a day, and what changed that day (to mark it). */
export function outlineDay(vault: string, day: string, now = new Date()): { day: string; items: ItemView[]; events: OutlineEvent[]; sha: string | null } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UserError("day is YYYY-MM-DD");
  const v = outlineAt(vault, day, now);
  if (!v) throw new UserError(`No outline on ${day}: the history starts with the first commit of outline.md.`);
  const events = allEvents(vault, now).filter((e) => e.date.slice(0, 10) === day);
  return { day, items: treeView(vault, v.o), events, sha: v.sha };
}

export { ME };
