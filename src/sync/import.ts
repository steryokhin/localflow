// File transport: issues fetched by an agent (e.g. through the Atlassian Rovo connector) and
// saved as JSON. Accepted shapes per file: one issue `{key, fields}`, an array of issues, or a
// search result `{issues: [...], names?: {...}}`. Everything else about the sync is shared.

import fs from "node:fs";
import type { Config } from "../config.ts";
import type { JiraIssue } from "../jira/api.ts";
import { userFromString } from "../jira/api.ts";
import { UserError } from "../util.ts";
import { assertLocalOnly } from "../vault/git.ts";
import { loadState } from "../vault/state.ts";
import { applyIssues } from "./apply.ts";
import type { SyncReport } from "./apply.ts";

export interface ImportOptions {
  dryRun?: boolean;
  force?: boolean;
  log?: (line: string) => void;
}

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

function looksLikeIssue(v: unknown): v is JiraIssue {
  return !!v && typeof v === "object" && typeof (v as JiraIssue).key === "string" && KEY_RE.test((v as JiraIssue).key) && typeof (v as JiraIssue).fields === "object";
}

export function parseIssueFile(text: string, source: string): { issues: JiraIssue[]; names: Record<string, string> } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UserError(`${source}: not valid JSON — ${(e as Error).message}`);
  }
  const names: Record<string, string> = {};
  let list: unknown[];
  if (Array.isArray(data)) list = data;
  else if (looksLikeIssue(data)) list = [data];
  else if (data && typeof data === "object" && Array.isArray((data as { issues?: unknown }).issues)) {
    list = (data as { issues: unknown[] }).issues;
    Object.assign(names, (data as { names?: Record<string, string> }).names ?? {});
  } else {
    throw new UserError(`${source}: expected an issue object, an array of issues, or {"issues": [...]}`);
  }
  const issues: JiraIssue[] = [];
  list.forEach((item, i) => {
    if (!looksLikeIssue(item)) throw new UserError(`${source}: item ${i} is not a Jira issue (needs "key" and "fields")`);
    issues.push(item);
  });
  return { issues, names };
}

export async function runImport(vault: string, config: Config, files: string[], opts: ImportOptions = {}): Promise<SyncReport> {
  assertLocalOnly(vault);
  if (files.length === 0) throw new UserError("Usage: lf import FILE.json [FILE.json...]  (or `-` for stdin)");
  const issues = new Map<string, JiraIssue>();
  const names: Record<string, string> = {};
  for (const file of files) {
    const text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
    const parsed = parseIssueFile(text, file === "-" ? "stdin" : file);
    for (const issue of parsed.issues) issues.set(issue.key, issue);
    Object.assign(names, parsed.names);
  }
  opts.log?.(`Read ${issues.size} issue(s) from ${files.length} file(s)`);
  const me = config.jira.me ? userFromString(config.jira.me) : loadState(vault).me;
  const warnings = me ? [] : ['jira.me is not set in localflow.json — "mine" cannot be determined for imported tickets'];
  return applyIssues(
    vault,
    config,
    { issues: [...issues.values()], names, me, client: null, label: "import", queries: files, warnings },
    { dryRun: opts.dryRun, force: opts.force, log: opts.log },
  );
}
