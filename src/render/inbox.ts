// INBOX.md: a generated, untracked overview — smart groups first, then the rest by status.

import path from "node:path";
import { INBOX_FILE, loadConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { STATUS_RANK, mapLocalStatus } from "../jira/mapping.ts";
import { summaryLines, unreadChanges } from "../sync/changes.ts";
import type { Change } from "../sync/changes.ts";
import { nowStamp, writeFileAtomic } from "../util.ts";
import { readLoops } from "../vault/loops.ts";
import type { Loop } from "../vault/loops.ts";
import { isTracked } from "../vault/notes.ts";
import { isMine, isOpen, waitingByKey } from "../vault/smart.ts";
import { fmtDue } from "./loops.ts";
import { loadState, unreadByTicket } from "../vault/state.ts";
import type { UnreadEvent } from "../vault/state.ts";
import { NOTES_FILE, TICKET_FILE, listTickets } from "../vault/store.ts";
import type { Ticket } from "../vault/store.ts";

export const BOARD_ORDER = ["inprogress", "inreview", "inbox", "done", "archived"];
const STATUS_TITLES: Record<string, string> = {
  inprogress: "In progress",
  inreview: "In review",
  inbox: "Inbox",
  done: "Done",
  archived: "Archived",
};

/** Jira's status mapped to local terms when it is further along than the user's own status. */
export function jiraAhead(t: Ticket, config: Config): string | null {
  if (t.source !== "jira") return null;
  const mapped = mapLocalStatus(String(t.fm.jira_status_category ?? ""), String(t.fm.jira_status ?? ""), config.projects[t.project]);
  return (STATUS_RANK[mapped] ?? 0) > (STATUS_RANK[t.status] ?? 0) ? mapped : null;
}

export function priorityOf(t: Ticket): string {
  return String(t.notes.priority ?? t.fm.priority ?? "");
}

function link(t: Ticket, file: string): string {
  return `${encodeURI(t.rel)}/${file}`;
}

/** What to show under an unread ticket: what changed, or the sync's own event lines as a fallback. */
export function unreadLines(events: UnreadEvent[], changes: Change[] | undefined): string[] {
  return changes?.length ? summaryLines(changes) : events.map((e) => `${e.date}: ${e.text}`);
}

function ticketLine(t: Ticket, config: Config): string {
  const prio = priorityOf(t);
  const jira = t.source === "jira" ? ` · Jira: ${t.fm.jira_status}${jiraAhead(t, config) ? " ⚠" : ""}` : " · local";
  const mine = t.fm.mine === false ? ` · ${t.fm.assignee}` : "";
  return `- [${t.key}](${link(t, TICKET_FILE)})${prio ? ` \`${prio}\`` : ""} ${t.title}${jira}${mine} · [notes](${link(t, NOTES_FILE)})`;
}

/** A waiting loop as one line: "Tom: PR #41 review · by 18:00". */
export function waitingLine(l: Loop, now: Date): string {
  return `${l.owner}: ${l.text} · by ${fmtDue(l.due, now)}`;
}

/**
 * Smart groups from the top: activity in my and tracked tickets, other unread, waiting on people,
 * mine, tracking; then everything else by status (done and archived folded away).
 */
export function renderInbox(
  tickets: Ticket[], unread: Map<string, UnreadEvent[]>, config: Config, changes = new Map<string, Change[]>(), loops: Loop[] = [], now = new Date(),
): string {
  const lines: string[] = ["# Local Flow — Inbox", "", `_Generated ${nowStamp()} by \`lf\`. Do not edit: this file is rewritten._`, ""];
  const waiting = waitingByKey(loops);
  const followed = (t: Ticket): boolean => isMine(t) || isTracked(t);
  const unreadBlock = (t: Ticket): void => {
    lines.push(`- [${t.key}](${link(t, TICKET_FILE)}) — ${t.title}`);
    for (const line of unreadLines(unread.get(t.key) ?? [], changes.get(t.key))) lines.push(`    - ${line}`);
  };

  const activity = tickets.filter((t) => unread.has(t.key) && followed(t));
  lines.push(`## Activity (${activity.length})`, "");
  if (activity.length === 0) lines.push("_Nothing new in your tickets._");
  activity.forEach(unreadBlock);
  lines.push("");

  const otherUnread = tickets.filter((t) => unread.has(t.key) && !followed(t));
  if (otherUnread.length) {
    lines.push(`## Other unread (${otherUnread.length})`, "");
    otherUnread.forEach(unreadBlock);
    lines.push("");
  }

  const waitingOn = tickets.filter((t) => waiting.has(t.key));
  if (waitingOn.length) {
    lines.push(`## Waiting on people (${waitingOn.length})`, "");
    for (const t of waitingOn) {
      lines.push(`- [${t.key}](${link(t, TICKET_FILE)}) — ${t.title}`);
      for (const l of waiting.get(t.key)!) lines.push(`    - ${waitingLine(l, now)}`);
    }
    lines.push("");
  }

  const byStatus = (a: Ticket, b: Ticket): number => BOARD_ORDER.indexOf(a.status) - BOARD_ORDER.indexOf(b.status);
  const mine = tickets.filter((t) => isMine(t) && isOpen(t)).sort(byStatus);
  lines.push(`## Mine (${mine.length})`, "");
  if (mine.length === 0) lines.push("_Nothing open is assigned to you._");
  for (const t of mine) lines.push(`${ticketLine(t, config)} · ${STATUS_TITLES[t.status] ?? t.status}`);
  lines.push("");
  const tracking = tickets.filter((t) => isTracked(t) && !isMine(t) && isOpen(t)).sort(byStatus);
  if (tracking.length) {
    lines.push(`## Tracking (${tracking.length})`, "");
    for (const t of tracking) lines.push(`${ticketLine(t, config)} · ${STATUS_TITLES[t.status] ?? t.status}`);
    lines.push("");
  }

  const rest = tickets.filter((t) => !(isOpen(t) && followed(t)));
  const statuses = [...BOARD_ORDER, ...new Set(rest.map((t) => t.status).filter((s) => !BOARD_ORDER.includes(s)))];
  for (const status of statuses) {
    const group = rest.filter((t) => t.status === status);
    if (group.length === 0) continue;
    const title = STATUS_TITLES[status] ?? status;
    const collapsed = status === "done" || status === "archived";
    if (collapsed) lines.push(`<details><summary><b>${title} (${group.length})</b></summary>`, "");
    else lines.push(`## ${title} (${group.length})`, "");
    for (const t of group) lines.push(ticketLine(t, config));
    lines.push("");
    if (collapsed) lines.push("</details>", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function refreshInbox(vault: string): void {
  const config = loadConfig(vault);
  const tickets = listTickets(vault);
  const state = loadState(vault);
  const unread = unreadByTicket(vault, state);
  const changes = unreadChanges(vault, tickets, unread.keys(), config, state);
  writeFileAtomic(path.join(vault, INBOX_FILE), renderInbox(tickets, unread, config, changes, readLoops(vault)));
}
