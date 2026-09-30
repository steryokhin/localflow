// INBOX.md: a generated, untracked overview — unread changes first, then the board by status.

import path from "node:path";
import { INBOX_FILE, loadConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { STATUS_RANK, mapLocalStatus } from "../jira/mapping.ts";
import { nowStamp, writeFileAtomic } from "../util.ts";
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

export function renderInbox(tickets: Ticket[], unread: Map<string, UnreadEvent[]>, config: Config): string {
  const lines: string[] = ["# Local Flow — Inbox", "", `_Generated ${nowStamp()} by \`lf\`. Do not edit: this file is rewritten._`, ""];

  const unreadTickets = tickets.filter((t) => unread.has(t.key));
  lines.push(`## Unread (${unreadTickets.length})`, "");
  if (unreadTickets.length === 0) lines.push("_Nothing new._");
  for (const t of unreadTickets) {
    lines.push(`- [${t.key}](${link(t, TICKET_FILE)}) — ${t.title}`);
    for (const e of unread.get(t.key) ?? []) lines.push(`    - ${e.date}: ${e.text}`);
  }
  lines.push("");

  const statuses = [...BOARD_ORDER, ...new Set(tickets.map((t) => t.status).filter((s) => !BOARD_ORDER.includes(s)))];
  for (const status of statuses) {
    const group = tickets.filter((t) => t.status === status);
    if (group.length === 0) continue;
    const title = STATUS_TITLES[status] ?? status;
    const collapsed = status === "done" || status === "archived";
    if (collapsed) lines.push(`<details><summary><b>${title} (${group.length})</b></summary>`, "");
    else lines.push(`## ${title} (${group.length})`, "");
    for (const t of group) {
      const prio = priorityOf(t);
      const jira = t.source === "jira" ? ` · Jira: ${t.fm.jira_status}${jiraAhead(t, config) ? " ⚠" : ""}` : " · local";
      const mine = t.fm.mine === false ? ` · ${t.fm.assignee}` : "";
      lines.push(
        `- [${t.key}](${link(t, TICKET_FILE)})${prio ? ` \`${prio}\`` : ""} ${t.title}${jira}${mine} · [notes](${link(t, NOTES_FILE)})`,
      );
    }
    lines.push("");
    if (collapsed) lines.push("</details>", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function refreshInbox(vault: string): void {
  const config = loadConfig(vault);
  const tickets = listTickets(vault);
  const unread = unreadByTicket(vault, loadState(vault));
  writeFileAtomic(path.join(vault, INBOX_FILE), renderInbox(tickets, unread, config));
}
