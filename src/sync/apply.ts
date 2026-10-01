// The transport-independent half of a sync: takes Jira issue objects (from REST or from a file an
// agent produced) and brings the vault in line — render, diff, attachments, one commit.
// Never writes to Jira and never touches user-owned files.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { JiraIssue, JiraUser } from "../jira/api.ts";
import { ATTACHMENTS_DIR, hasMissingAttachments, planAttachments, syncAttachments } from "../jira/attachments.ts";
import type { JiraClient } from "../jira/client.ts";
import { compareKeys, mapLocalStatus } from "../jira/mapping.ts";
import { refreshInbox } from "../render/inbox.ts";
import { renderTicket } from "../render/ticket.ts";
import type { RenderContext } from "../render/ticket.ts";
import { nowStamp, readTextIfExists, stableJson, writeFileAtomic } from "../util.ts";
import { parseFrontmatter } from "../vault/frontmatter.ts";
import { commitPaths } from "../vault/git.ts";
import { SYNC_SUBJECT_PREFIX, loadFieldNames, loadState, saveFieldNames, saveState } from "../vault/state.ts";
import { NOTES_FILE, RAW_DIR, RAW_FILE, TICKET_FILE, notesStub, projectOf, ticketRel } from "../vault/store.ts";
import { summarizeChanges } from "./diff.ts";

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

export interface ApplyInput {
  issues: JiraIssue[];
  /** Field id -> human name, as far as the transport knows. */
  names: Record<string, string>;
  me: JiraUser | null;
  /** Present for REST sync (downloads attachments); null for file import. */
  client: JiraClient | null;
  /** Shown in the commit subject: "sync" or "import". */
  label: string;
  queries: string[];
  warnings?: string[];
}

export interface ApplyOptions {
  dryRun?: boolean;
  /** Rewrite every ticket even when nothing changed. */
  force?: boolean;
  log?: (line: string) => void;
}

export async function applyIssues(vault: string, config: Config, input: ApplyInput, opts: ApplyOptions = {}): Promise<SyncReport> {
  const report: SyncReport = { actions: [], commit: null, warnings: [...(input.warnings ?? [])], queries: input.queries };
  const state = loadState(vault);
  if (input.me) state.me = input.me;
  const names = { ...loadFieldNames(vault), ...input.names, ...config.jira.fieldNames };
  const commitTargets: string[] = [];
  const maxBytes = config.jira.maxAttachmentMb * 1024 * 1024;

  for (const issue of [...input.issues].sort((a, b) => compareKeys(a.key, b.key))) {
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
    const c = issue.fields.comment;
    if (c && typeof c.total === "number" && c.total > (c.comments?.length ?? 0)) {
      report.warnings.push(`${key}: only ${c.comments?.length ?? 0} of ${c.total} comments were provided`);
    }

    const attachments = planAttachments(issue, maxBytes);
    if (!input.client) {
      for (const a of attachments) {
        if (!a.skipReason && !fs.existsSync(path.join(dir, ATTACHMENTS_DIR, a.localName))) {
          a.skipReason = "not downloaded: imported without Jira access";
        }
      }
    }
    const ctx: RenderContext = {
      baseUrl: config.jira.baseUrl,
      names,
      project,
      me: state.me,
      ignoreFields: config.jira.ignoreFields,
      attachments,
      textFormat: config.jira.textFormat,
    };
    const content = renderTicket(issue, ctx);
    const isNew = existing === null;
    const contentChanged = content !== existing;
    const filesMissing = !!input.client && hasMissingAttachments(dir, attachments);
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
    if (input.client) {
      const files = await syncAttachments(input.client, dir, attachments);
      for (const f of files.failed) report.warnings.push(`${key}: attachment ${f.name} failed — ${f.error}`);
    }
    writeFileAtomic(path.join(dir, RAW_FILE), stableJson(issue));
    if (contentChanged) writeFileAtomic(path.join(dir, TICKET_FILE), content);
    commitTargets.push(`${rel}/${TICKET_FILE}`, `${rel}/${ATTACHMENTS_DIR}`, `${rel}/${RAW_DIR}`);

    // notes.md is created once and never touched again: it belongs to the user.
    // The user's status starts at "inbox" (= not triaged yet) whatever Jira says — Jira's
    // "In Progress" category covers states like "Ready for Pickup" that mean nothing was started.
    // Only tickets already closed in Jira skip the inbox; statusOverrides can still pin a status.
    const notesPath = path.join(dir, NOTES_FILE);
    if (!fs.existsSync(notesPath)) {
      const mapped = mapLocalStatus(issue.fields.status?.statusCategory?.name ?? "", issue.fields.status?.name ?? "", project);
      const overridden = project?.statusOverrides?.[(issue.fields.status?.name ?? "").trim().toLowerCase()] !== undefined;
      const status = overridden || mapped === "done" ? mapped : "inbox";
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
    const via = input.label === "sync" ? "" : ` (${input.label})`;
    const message = `${SYNC_SUBJECT_PREFIX}${nowStamp()}${via}: ${counts.join(", ")}\n\n${body.join("\n")}\n`;
    report.commit = commitPaths(vault, commitTargets, message);
  }

  state.lastSync = new Date().toISOString();
  saveState(vault, state);
  refreshInbox(vault);
  return report;
}
