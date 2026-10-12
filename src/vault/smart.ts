// Smart groups: views across projects and the user's own groups.
//   mine     — assigned to me in Jira (local tickets are always mine)
//   tracked  — `tracked: true` in notes.md (lf track, a loop, lf start, a first note)
//   activity — mine or tracked, with unread changes from Jira
//   waiting  — has an open loop where someone else owes the next move

import type { Loop } from "./loops.ts";
import { ME } from "./loops.ts";
import { isTracked } from "./notes.ts";
import type { Ticket } from "./store.ts";

export const SMART_GROUPS = ["activity", "mine", "tracked", "waiting"] as const;
export type SmartGroup = (typeof SMART_GROUPS)[number];
const CLOSED = ["done", "archived"];

export const isMine = (t: Ticket): boolean => t.fm.mine !== false;
export const isOpen = (t: Ticket): boolean => !CLOSED.includes(t.status);

/** Ticket key -> its open loops waiting on someone else, earliest first as in loops.md. */
export function waitingByKey(loops: Loop[]): Map<string, Loop[]> {
  const out = new Map<string, Loop[]>();
  for (const l of loops) if (l.key && l.owner !== ME) out.set(l.key, [...(out.get(l.key) ?? []), l]);
  return out;
}

export function inSmartGroup(group: SmartGroup, t: Ticket, unread: boolean, waiting: Map<string, Loop[]>): boolean {
  switch (group) {
    case "mine":
      return isMine(t) && isOpen(t);
    case "tracked":
      return isTracked(t) && isOpen(t);
    case "activity":
      return unread && (isMine(t) || isTracked(t));
    case "waiting":
      return waiting.has(t.key);
  }
}
