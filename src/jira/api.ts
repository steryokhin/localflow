import { JiraClient, JiraHttpError } from "./client.ts";

export interface JiraIssue {
  key: string;
  id?: string;
  fields: Record<string, any>;
}

export interface SearchResult {
  issues: JiraIssue[];
  /** Field id -> human name (from `expand=names`). */
  names: Record<string, string>;
}

export interface JiraUser {
  key: string;
  name: string;
  displayName: string;
}

const API = "/rest/api/2";

export async function getMyself(client: JiraClient): Promise<JiraUser> {
  const me = await client.getJson(`${API}/myself`);
  return { key: me.key ?? "", name: me.name ?? "", displayName: me.displayName ?? "" };
}

export async function searchIssues(client: JiraClient, jql: string, pageSize = 50): Promise<SearchResult> {
  const issues: JiraIssue[] = [];
  const names: Record<string, string> = {};
  let startAt = 0;
  for (;;) {
    const page = await client.getJson(`${API}/search`, {
      jql,
      startAt,
      maxResults: pageSize,
      fields: "*all",
      expand: "names",
    });
    const batch: JiraIssue[] = page.issues ?? [];
    issues.push(...batch);
    Object.assign(names, page.names ?? {});
    const total: number = page.total ?? 0;
    if (batch.length === 0 || startAt + batch.length >= total) break;
    startAt += batch.length;
  }
  return { issues, names };
}

/** Returns null when the issue does not exist (deleted or moved). */
export async function getIssue(client: JiraClient, key: string): Promise<SearchResult | null> {
  try {
    const issue = await client.getJson(`${API}/issue/${encodeURIComponent(key)}`, { fields: "*all", expand: "names" });
    const names = issue.names ?? {};
    delete issue.names;
    return { issues: [issue], names };
  } catch (e) {
    if (e instanceof JiraHttpError && e.status === 404) return null;
    throw e;
  }
}

/** Fetch issues by key, tolerating keys that no longer exist. */
export async function getIssuesByKeys(
  client: JiraClient,
  keys: string[],
): Promise<SearchResult & { missing: string[] }> {
  const out: SearchResult & { missing: string[] } = { issues: [], names: {}, missing: [] };
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    try {
      const res = await searchIssues(client, `key in (${chunk.join(", ")})`);
      out.issues.push(...res.issues);
      Object.assign(out.names, res.names);
      const found = new Set(res.issues.map((x) => x.key));
      out.missing.push(...chunk.filter((k) => !found.has(k)));
    } catch (e) {
      // Jira rejects the whole `key in (...)` query when one key does not exist.
      if (!(e instanceof JiraHttpError && e.status === 400)) throw e;
      for (const key of chunk) {
        const one = await getIssue(client, key);
        if (!one) {
          out.missing.push(key);
          continue;
        }
        out.issues.push(...one.issues);
        Object.assign(out.names, one.names);
      }
    }
  }
  return out;
}

/** Search results may carry a truncated (or absent) comment list; load the full one if so. */
export async function ensureAllComments(client: JiraClient, issue: JiraIssue): Promise<void> {
  const c = issue.fields.comment;
  const have: number = c?.comments?.length ?? 0;
  if (c && (c.total ?? have) <= have) return;
  const full = await client.getJson(`${API}/issue/${encodeURIComponent(issue.key)}/comment`, { maxResults: 1000 });
  issue.fields.comment = {
    comments: full.comments ?? [],
    total: full.total ?? (full.comments ?? []).length,
    maxResults: full.maxResults ?? 1000,
    startAt: 0,
  };
}
