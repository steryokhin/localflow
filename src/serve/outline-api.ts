// The Outline page's API: the tree as JSON (with what each item is as a loop), a batch of edit
// operations by id, and the history (an item's or a ticket's life, a day as it was, days with changes).

import { lastWorkingDay } from "../render/loops.ts";
import { UserError } from "../util.ts";
import { ME, dueAt, fmtDay, normalizeId } from "../vault/loopfields.ts";
import { ownHash, sectionRef } from "../vault/outline.ts";
import type { Item, Outline } from "../vault/outline.ts";
import { allEvents, checkedSince, itemHistory, outlineAt, ticketHistory } from "../vault/outline-history.ts";
import type { OutlineEvent } from "../vault/outline-history.ts";
import { applyOps } from "../vault/outline-ops.ts";
import type { Op } from "../vault/outline-ops.ts";
import { loopOf, readModel } from "../vault/outline-store.ts";
import { listTickets } from "../vault/store.ts";
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

export interface SectionView {
  ref: string;
  key: string | null;
  title: string;
  closed: boolean;
  /** The ticket behind the heading (local status), when the vault has it. */
  ticket: { title: string; status: string; jiraStatus: string | null } | null;
  items: ItemView[];
}

export interface OutlineView {
  /** Hash of outline.md + loops.md: changes on every write, by anyone. */
  version: string;
  exists: boolean;
  sections: SectionView[];
  conflicts: string[];
  /** Tickets that have no section yet, for "add a section". */
  tickets: Array<{ key: string; title: string; status: string }>;
  /** Items checked off since the last working day (the standup lens). */
  checkedSince: string[];
  standupSince: string;
  now: string;
}

function itemView(it: Item): ItemView {
  const l = loopOf(it, { closed: true });
  return {
    id: it.ref, written: it.id !== null, check: it.check, text: it.text, context: it.context, own: ownHash(it),
    loop: l ? {
      text: l.text, owner: l.owner, due: l.due, dueAt: dueAt(l.due)?.getTime() ?? null, onExpiry: l.onExpiry, tag: l.tag, after: l.after, created: l.created,
    } : null,
    children: it.children.map(itemView),
  };
}

export function sectionsView(vault: string, o: Outline): SectionView[] {
  const tickets = new Map(listTickets(vault).map((t) => [t.key, t] as const));
  return o.sections.map((s) => {
    const t = s.key ? tickets.get(s.key) : undefined;
    return {
      ref: sectionRef(s), key: s.key, title: s.title, closed: s.closed,
      ticket: t ? { title: t.title, status: t.status, jiraStatus: typeof t.fm.jira_status === "string" ? t.fm.jira_status : null } : null,
      items: s.items.map(itemView),
    };
  });
}

export function outlineView(vault: string, now = new Date()): OutlineView {
  const m = readModel(vault);
  const since = fmtDay(lastWorkingDay(now));
  const inOutline = new Set(m.o.sections.map((s) => s.key).filter(Boolean));
  let checked: string[] = [];
  try {
    checked = [...checkedSince(vault, since, now)];
  } catch {
    checked = [];
  }
  return {
    version: `${m.outlineHash}.${m.loopsHash}`,
    exists: m.outlineExists,
    sections: sectionsView(vault, m.o),
    conflicts: [...m.conflicts],
    tickets: listTickets(vault)
      .filter((t) => !inOutline.has(t.key) && t.status !== "archived")
      .map((t) => ({ key: t.key, title: t.title, status: t.status })),
    checkedSince: checked,
    standupSince: since,
    now: now.toISOString(),
  };
}

export function outlineOps(vault: string, ops: unknown, now = new Date()): { ids: Record<string, string>; removed: Record<string, unknown>; view: OutlineView } {
  if (!Array.isArray(ops)) throw new UserError('"ops" must be a list of operations.');
  const r = applyOps(vault, ops as Op[], now, { workdayEnd: loadConfig(vault).loops?.workdayEnd });
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
export function outlineDay(vault: string, day: string, now = new Date()): { day: string; sections: SectionView[]; events: OutlineEvent[]; sha: string | null } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UserError("day is YYYY-MM-DD");
  const v = outlineAt(vault, day, now);
  if (!v) throw new UserError(`No outline on ${day}: the history starts with the first commit of outline.md.`);
  const events = allEvents(vault, now).filter((e) => e.date.slice(0, 10) === day);
  return { day, sections: sectionsView(vault, v.o), events, sha: v.sha };
}

export { ME };
