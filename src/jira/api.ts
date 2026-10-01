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

/** Data Center users have key/name; Cloud users have accountId/emailAddress. Empty strings never match. */
export interface JiraUser {
  key: string;
  name: string;
  displayName: string;
  accountId: string;
  emailAddress: string;
}

export type Flavor = "datacenter" | "cloud";

// Data Center still serves REST v2. Cloud removed `/rest/api/2/search` (410 Gone) in favour of
// `/rest/api/3/search/jql` with token pagination; the rest of v3 is a path change only.
function base(flavor: Flavor): string {
  return flavor === "cloud" ? "/rest/api/3" : "/rest/api/2";
}

export async function getMyself(client: JiraClient, flavor: Flavor = "datacenter"): Promise<JiraUser> {
  const me = await client.getJson(`${base(flavor)}/myself`);
  return {
    key: me.key ?? "",
    name: me.name ?? "",
    displayName: me.displayName ?? "",
    accountId: me.accountId ?? "",
    emailAddress: me.emailAddress ?? "",
  };
}

/** A user identity from a single configured string, for imported data. */
export function userFromString(me: string): JiraUser {
  return { key: me, name: me, displayName: me, accountId: me, emailAddress: me };
}

/** Cloud's search endpoint does not expand field names; `/field` lists them once per sync. */
async function cloudFieldNames(client: JiraClient): Promise<Record<string, string>> {
  const fields = await client.getJson("/rest/api/3/field");
  const names: Record<string, string> = {};
  for (const f of Array.isArray(fields) ? fields : []) if (f?.id && f?.name) names[f.id] = f.name;
  return names;
}

async function searchCloud(client: JiraClient, jql: string, pageSize: number): Promise<SearchResult> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  for (;;) {
    const page = await client.getJson("/rest/api/3/search/jql", {
      jql,
      maxResults: pageSize,
      fields: "*all",
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    issues.push(...(page.issues ?? []));
    nextPageToken = page.nextPageToken;
    if (!nextPageToken || page.isLast || (page.issues ?? []).length === 0) break;
  }
  return { issues, names: await cloudFieldNames(client) };
}

export async function searchIssues(client: JiraClient, jql: string, flavor: Flavor = "datacenter", pageSize = 50): Promise<SearchResult> {
  if (flavor === "cloud") return searchCloud(client, jql, pageSize);
  const issues: JiraIssue[] = [];
  const names: Record<string, string> = {};
  let startAt = 0;
  for (;;) {
    const page = await client.getJson(`${base(flavor)}/search`, {
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

/** One minimal search request — what `lf doctor` uses to prove the search endpoint is alive. */
export async function probeSearch(client: JiraClient, flavor: Flavor = "datacenter"): Promise<void> {
  // Cloud's search/jql rejects unbounded JQL (a bare "order by"), so the probe carries a condition.
  const params = { jql: "updated >= -30d order by updated desc", maxResults: 1, fields: "id" };
  if (flavor === "cloud") await client.getJson("/rest/api/3/search/jql", params);
  else await client.getJson(`${base(flavor)}/search`, params);
}

/** Returns null when the issue does not exist (deleted or moved). */
export async function getIssue(client: JiraClient, key: string, flavor: Flavor = "datacenter"): Promise<SearchResult | null> {
  try {
    const issue = await client.getJson(`${base(flavor)}/issue/${encodeURIComponent(key)}`, { fields: "*all", expand: "names" });
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
  flavor: Flavor = "datacenter",
): Promise<SearchResult & { missing: string[] }> {
  const out: SearchResult & { missing: string[] } = { issues: [], names: {}, missing: [] };
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    try {
      const res = await searchIssues(client, `key in (${chunk.join(", ")})`, flavor);
      out.issues.push(...res.issues);
      Object.assign(out.names, res.names);
      const found = new Set(res.issues.map((x) => x.key));
      out.missing.push(...chunk.filter((k) => !found.has(k)));
    } catch (e) {
      // Jira rejects the whole `key in (...)` query when one key does not exist.
      if (!(e instanceof JiraHttpError && e.status === 400)) throw e;
      for (const key of chunk) {
        const one = await getIssue(client, key, flavor);
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
export async function ensureAllComments(client: JiraClient, issue: JiraIssue, flavor: Flavor = "datacenter"): Promise<void> {
  const c = issue.fields.comment;
  const have: number = c?.comments?.length ?? 0;
  if (c && (c.total ?? have) <= have) return;
  const full = await client.getJson(`${base(flavor)}/issue/${encodeURIComponent(issue.key)}/comment`, { maxResults: 1000 });
  issue.fields.comment = {
    comments: full.comments ?? [],
    total: full.total ?? (full.comments ?? []).length,
    maxResults: full.maxResults ?? 1000,
    startAt: 0,
  };
}
