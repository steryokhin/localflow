// REST transport: fetch issues from Jira, then hand them to the shared apply step.

import type { Config } from "../config.ts";
import { readToken } from "../config.ts";
import { ensureAllComments, getIssuesByKeys, getMyself, searchIssues } from "../jira/api.ts";
import type { JiraIssue } from "../jira/api.ts";
import { JiraClient } from "../jira/client.ts";
import type { JiraAuth } from "../jira/client.ts";
import { UserError } from "../util.ts";
import { assertLocalOnly } from "../vault/git.ts";
import { listTickets } from "../vault/store.ts";
import { applyIssues } from "./apply.ts";
import type { SyncReport } from "./apply.ts";

export type { ActionKind, SyncAction, SyncReport } from "./apply.ts";

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

export function jiraAuth(config: Config): JiraAuth {
  const token = readToken(config);
  return config.jira.flavor === "cloud" ? { kind: "basic", token, email: config.jira.email } : { kind: "bearer", token };
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
  if (config.jira.transport === "import") {
    throw new UserError(
      'jira.transport is "import": lf opens no outbound connections. Fetch issues with the agent and run `lf import`, ' +
        'or set jira.transport to "rest" to allow REST access.',
    );
  }
  const client = new JiraClient(config.jira.baseUrl, jiraAuth(config), config.jira.userAgent);
  const warnings: string[] = [];

  const me = await getMyself(client);
  say(`Jira user: ${me.displayName} (${me.key || me.accountId || me.name})`);

  const issues = new Map<string, JiraIssue>();
  const names: Record<string, string> = {};
  const absorb = (res: { issues: JiraIssue[]; names: Record<string, string> }): void => {
    for (const issue of res.issues) issues.set(issue.key, issue);
    Object.assign(names, res.names);
  };

  let queries: string[];
  if (opts.keys?.length) {
    queries = [`key in (${opts.keys.join(", ")})`];
    const res = await getIssuesByKeys(client, opts.keys);
    absorb(res);
    for (const key of res.missing) warnings.push(`${key}: not found in Jira`);
  } else {
    const resolved = resolveQueries(config, opts);
    queries = resolved.queries;
    for (const jql of queries) {
      say(`JQL: ${jql}`);
      absorb(await searchIssues(client, jql));
    }
    // Tickets that left the query (usually closed) would otherwise stay frozen as "open" locally.
    if (!opts.noRefresh && resolved.refreshProjects.length) {
      const stale = listTickets(vault)
        .filter((t) => t.source === "jira" && resolved.refreshProjects.includes(t.project))
        .filter((t) => !issues.has(t.key) && t.fm.jira_status_category !== "Done")
        .map((t) => t.key);
      if (stale.length) {
        say(`Refreshing ${stale.length} local ticket(s) no longer returned by the query`);
        const res = await getIssuesByKeys(client, stale);
        absorb(res);
        for (const key of res.missing) warnings.push(`${key}: no longer exists in Jira (deleted or moved)`);
      }
    }
  }
  say(`Fetched ${issues.size} issue(s)`);
  for (const issue of issues.values()) await ensureAllComments(client, issue);

  return applyIssues(
    vault,
    config,
    { issues: [...issues.values()], names, me, client, label: "sync", queries, warnings },
    { dryRun: opts.dryRun, force: opts.force, log: say },
  );
}
