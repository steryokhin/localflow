// Two statuses per Jira ticket: Jira's own (jira_status in ticket.md, owned by the sync) and the
// user's (status in notes.md). Neither changes the other by itself; "align" copies Jira's into the
// user's on request, through the same mapping the sync uses for new tickets. Never the other way.

import path from "node:path";
import type { Config } from "../config.ts";
import { mapLocalStatus } from "../jira/mapping.ts";
import type { LocalStatus } from "../jira/mapping.ts";
import { refreshInbox } from "../render/inbox.ts";
import { writeFileAtomic } from "../util.ts";
import { setFrontmatterKeys } from "./frontmatter.ts";
import { notesText } from "./notes.ts";
import { NOTES_FILE, listTickets, requireTicket } from "./store.ts";
import type { Ticket } from "./store.ts";

/** Jira's status in local terms (statusOverrides, then the status category); null for local tickets. */
export function jiraLocalStatus(t: Ticket, config: Config): LocalStatus | null {
  if (t.source !== "jira") return null;
  return mapLocalStatus(String(t.fm.jira_status_category ?? ""), String(t.fm.jira_status ?? ""), config.projects[t.project]);
}

/** The two statuses disagree. An archived ticket that Jira has done is not a disagreement. */
export function statusMismatch(t: Ticket, config: Config): boolean {
  const mapped = jiraLocalStatus(t, config);
  if (mapped === null || mapped === t.status) return false;
  return !(t.status === "archived" && mapped === "done");
}

export interface AlignChange {
  key: string;
  from: string;
  to: LocalStatus;
}

/** Copies Jira's status into notes.md for the given tickets (all of them for "all") that disagree. */
export function alignTickets(vault: string, config: Config, keys: string[] | "all", opts: { dryRun?: boolean } = {}): AlignChange[] {
  const tickets = keys === "all" ? listTickets(vault) : keys.map((k) => requireTicket(vault, k));
  const changes: AlignChange[] = [];
  for (const t of tickets) {
    if (!statusMismatch(t, config)) continue;
    const to = jiraLocalStatus(t, config)!;
    changes.push({ key: t.key, from: t.status, to });
    if (!opts.dryRun) writeFileAtomic(path.join(t.dir, NOTES_FILE), setFrontmatterKeys(notesText(t), { status: to }));
  }
  if (changes.length && !opts.dryRun) refreshInbox(vault);
  return changes;
}
