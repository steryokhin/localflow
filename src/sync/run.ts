// One-way sync: Jira -> vault. Never writes to Jira and never touches user-owned files.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { readToken } from "../config.ts";
import { ensureAllComments, getIssuesByKeys, getMyself, searchIssues } from "../jira/api.ts";
import type { JiraIssue } from "../jira/api.ts";
import { ATTACHMENTS_DIR, hasMissingAttachments, planAttachments, syncAttachments } from "../jira/attachments.ts";
import { JiraClient } from "../jira/client.ts";
import { compareKeys, mapLocalStatus } from "../jira/mapping.ts";
import { refreshInbox } from "../render/inbox.ts";
import { renderTicket } from "../render/ticket.ts";
import type { RenderContext } from "../render/ticket.ts";
import { UserError, nowStamp, readTextIfExists, stableJson, writeFileAtomic } from "../util.ts";
import { parseFrontmatter } from "../vault/frontmatter.ts";
import { assertLocalOnly, commitPaths } from "../vault/git.ts";
import { SYNC_SUBJECT_PREFIX, loadFieldNames, loadState, saveFieldNames, saveState } from "../vault/state.ts";
import { NOTES_FILE, RAW_DIR, RAW_FILE, TICKET_FILE, listTickets, notesStub, projectOf, ticketRel } from "../vault/store.ts";
import { summarizeChanges } from "./diff.ts";

export interface SyncOptions {
  project?: string;
  preset?: string;
  jql?: string;
  keys?: string[];
  dryRun?: boolean;
  /** Rewrite every fetched ticket even when nothing changed. */
  force?: boolean;
  /** Do not re-fetch local open tickets that dropped out of the query. */
  noRefresh?: boolean;
  log?: (line: string) => void;
}

export type ActionKind = "create" | "update" | "rerender" | "skip";

export interface SyncAction {
  kind: ActionKind;
  key: string;
  title: string;
  rel: string;
  /** Human-readable changes; empty for skip/rerender. */
  events: string[];
}

export interface SyncReport {
  actions: SyncAction[];
  commit: string | null;
  warnings: string[];
  queries: string[];
}

function resolveQueries(config: Config, opts: SyncOptions): { queries: string[]; refreshProjects: string[] } {
  if (opts.jql) return { queries: [opts.jql], refreshProjects: [] };
  const jiraProjects = Object.entries(config.projects).filter(
    ([name, p]) => p.source === "jira" && (!opts.project || name === opts.project),
  );
  if (jiraProjects.length === 0) {
    throw new UserError(opts.project ? `No Jira project "${opts.project}" in localflow.json.` : "No Jira projects in localflow.json.");
  }
  const queries: string[] = [];
  for (const [name, p] of jiraProjects) {
    const preset = opts.preset ?? p.defaultPreset ?? Object.keys(p.presets ?? {})[0];
    const jql = preset ? p.presets?.[preset] : undefined;
    if (!jql) {
      const known = Object.keys(p.presets ?? {}).join(", ") || "none";
      throw new UserError(`Project ${name} has no preset "${preset}". Available: ${known}.`);
    }
    queries.push(jql);
  }
  return { queries, refreshProjects: jiraProjects.map(([name]) => name) };
}

export async function runSync(vault: string, config: Config, opts: SyncOptions = {}): Promise<SyncReport> {
  const say = opts.log ?? (() => {});
  assertLocalOnly(vault);
  const client = new JiraClient(config.jira.baseUrl, readToken(config), config.jira.userAgent);
  const report: SyncReport = { actions: [], commit: null, warnings: [], queries: [] };

  const state = loadState(vault);
  state.me = await getMyself(client);
  say(`Jira user: ${state.me.displayName} (${state.me.key || state.me.name})`);

  const issues = new Map<string, JiraIssue>();
  const names = loadFieldNames(vault);
  const absorb = (res: { issues: JiraIssue[]; names: Record<string, string> }): void => {
    for (const issue of res.issues) issues.set(issue.key, issue);
    Object.assign(names, res.names);
  };

  if (opts.keys?.length) {
    report.queries.push(`key in (${opts.keys.join(", ")})`);
    const res = await getIssuesByKeys(client, opts.keys);
    absorb(res);
    for (const key of res.missing) report.warnings.push(`${key}: not found in Jira`);
  } else {
    const { queries, refreshProjects } = resolveQueries(config, opts);
    report.queries = queries;
    for (const jql of queries) {
      say(`JQL: ${jql}`);
      absorb(await searchIssues(client, jql));
    }
    // Tickets that left the query (usually closed) would otherwise stay frozen as "open" locally.
    if (!opts.noRefresh && refreshProjects.length) {
      const stale = listTickets(vault)
        .filter((t) => t.source === "jira" && refreshProjects.includes(t.project))
        .filter((t) => !issues.has(t.key) && t.fm.jira_status_category !== "Done")
        .map((t) => t.key);
      if (stale.length) {
        say(`Refreshing ${stale.length} local ticket(s) no longer returned by the query`);
        const res = await getIssuesByKeys(client, stale);
        absorb(res);
        for (const key of res.missing) report.warnings.push(`${key}: no longer exists in Jira (deleted or moved)`);
      }
    }
  }
  say(`Fetched ${issues.size} issue(s)`);

  const commitTargets: string[] = [];
  const maxBytes = config.jira.maxAttachmentMb * 1024 * 1024;

  for (const issue of [...issues.values()].sort((a, b) => compareKeys(a.key, b.key))) {
    const key = issue.key;
    const title = String(issue.fields.summary ?? "").trim();
    const project = config.projects[projectOf(key)];
    const rel = ticketRel(vault, key, title);
    const dir = path.join(vault, rel);
    const existing = readTextIfExists(path.join(dir, TICKET_FILE));
    if (existing !== null && parseFrontmatter(existing).data.source === "local") {
      report.warnings.push(`${key}: a local ticket with this key already exists — skipped`);
      continue;
    }

    await ensureAllComments(client, issue);
    const attachments = planAttachments(issue, maxBytes);
    const ctx: RenderContext = {
      baseUrl: config.jira.baseUrl,
      names,
      project,
      me: state.me,
      ignoreFields: config.jira.ignoreFields,
      attachments,
    };
    const content = renderTicket(issue, ctx);
    const isNew = existing === null;
    const contentChanged = content !== existing;
    const filesMissing = hasMissingAttachments(dir, attachments);
    if (!isNew && !contentChanged && !filesMissing && !opts.force) {
      report.actions.push({ kind: "skip", key, title, rel, events: [] });
      continue;
    }

    let events: string[] = [];
    if (isNew) {
      events = [`new ticket — ${title}`];
    } else if (contentChanged) {
      const oldRawText = readTextIfExists(path.join(dir, RAW_FILE));
      const oldRaw: JiraIssue | null = oldRawText ? JSON.parse(oldRawText) : null;
      if (oldRaw) {
        events = summarizeChanges(oldRaw, issue, ctx);
        if (events.length === 0 && oldRaw.fields.updated !== issue.fields.updated) events = ["other changes"];
      } else {
        events = ["updated"];
      }
    }
    const kind: ActionKind = isNew ? "create" : events.length ? "update" : "rerender";
    report.actions.push({ kind, key, title, rel, events });
    if (opts.dryRun) continue;

    fs.mkdirSync(dir, { recursive: true });
    const files = await syncAttachments(client, dir, attachments);
    for (const f of files.failed) report.warnings.push(`${key}: attachment ${f.name} failed — ${f.error}`);
    writeFileAtomic(path.join(dir, RAW_FILE), stableJson(issue));
    if (contentChanged) writeFileAtomic(path.join(dir, TICKET_FILE), content);
    commitTargets.push(`${rel}/${TICKET_FILE}`, `${rel}/${ATTACHMENTS_DIR}`, `${rel}/${RAW_DIR}`);

    // notes.md is created once and never touched again: it belongs to the user.
    const notesPath = path.join(dir, NOTES_FILE);
    if (!fs.existsSync(notesPath)) {
      const status = mapLocalStatus(
        issue.fields.status?.statusCategory?.name ?? "",
        issue.fields.status?.name ?? "",
        project,
      );
      writeFileAtomic(notesPath, notesStub(key, status));
      commitTargets.push(`${rel}/${NOTES_FILE}`);
    }
  }

  if (opts.dryRun) return report;

  saveFieldNames(vault, names);
  const created = report.actions.filter((a) => a.kind === "create");
  const updated = report.actions.filter((a) => a.kind === "update");
  const rerendered = report.actions.filter((a) => a.kind === "rerender");
  if (commitTargets.length) {
    const counts = [
      created.length ? `${created.length} new` : "",
      updated.length ? `${updated.length} updated` : "",
      rerendered.length ? `${rerendered.length} re-rendered` : "",
    ].filter(Boolean);
    const body = [
      ...[...created, ...updated].map((a) => `${a.key}: ${a.events.join("; ")}`),
      // The leading "~" keeps re-renders out of the unread list.
      ...rerendered.map((a) => `~ ${a.key}: re-rendered`),
    ];
    const message = `${SYNC_SUBJECT_PREFIX}${nowStamp()}: ${counts.join(", ")}\n\n${body.join("\n")}\n`;
    report.commit = commitPaths(vault, commitTargets, message);
  }

  state.lastSync = new Date().toISOString();
  saveState(vault, state);
  refreshInbox(vault);
  return report;
}
