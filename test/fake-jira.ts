// In-process fake of the Jira Data Center REST API, just enough for the sync.
// All data is invented for tests.

import http from "node:http";
import type { AddressInfo } from "node:net";

export const TEST_TOKEN = "test-token";

const NAMES: Record<string, string> = {
  summary: "Summary",
  description: "Description",
  customfield_100: "Acceptance Criteria",
  customfield_101: "Steps to Reproduce",
  customfield_102: "Story Points",
  customfield_103: "Sprint",
  customfield_104: "Epic Link",
  customfield_200: "Team",
  customfield_201: "Rank",
  environment: "Environment",
};

const user = (name: string) => ({ key: name.toLowerCase().replace(/\s+/g, "_"), name: name.toLowerCase().replace(/\s+/g, "_"), displayName: name });

export function makeIssue(key: string, fields: Record<string, unknown> = {}): { key: string; id: string; fields: Record<string, any> } {
  return {
    key,
    id: key.replace(/\D/g, ""),
    fields: {
      summary: `Summary of ${key}`,
      description: "Plain description.",
      issuetype: { name: "Bug" },
      status: { name: "Open", statusCategory: { name: "To Do", key: "new" } },
      priority: { name: "Critical" },
      resolution: null,
      created: "2026-09-01T10:00:00.000+0000",
      updated: "2026-09-01T10:00:00.000+0000",
      assignee: user("Test User"),
      reporter: user("Olga Reporter"),
      labels: ["ios"],
      components: [],
      fixVersions: [],
      versions: [],
      issuelinks: [],
      subtasks: [],
      attachment: [],
      comment: { comments: [], total: 0, maxResults: 50, startAt: 0 },
      votes: { votes: 0 },
      watches: { watchCount: 1 },
      lastViewed: null,
      customfield_201: "0|i00abc:",
      ...fields,
    },
  };
}

export function makeComment(id: number, author: string, body: string, created = "2026-09-02T09:30:00.000+0000") {
  return { id: String(id), author: user(author), body, created, updated: created };
}

export class FakeJira {
  issues = new Map<string, ReturnType<typeof makeIssue>>();
  files = new Map<string, Buffer>();
  requests: { method: string; url: string }[] = [];
  baseUrl = "";
  /** Behave like Jira Cloud: v2 search is gone, Basic auth (any email + the test token) is accepted. */
  cloud = false;
  /** Where /redirect-media sends the client (a second server in tests). */
  redirectTarget = "";
  #server: http.Server | null = null;

  addAttachment(key: string, id: number, filename: string, content: string): void {
    const issue = this.issues.get(key)!;
    const buf = Buffer.from(content);
    this.files.set(String(id), buf);
    issue.fields.attachment.push({
      id: String(id),
      filename,
      size: buf.length,
      author: user("Olga Reporter"),
      created: "2026-09-01T10:05:00.000+0000",
      content: `${this.baseUrl}/secure/attachment/${id}/${encodeURIComponent(filename)}`,
    });
  }

  async start(): Promise<string> {
    this.#server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  #json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", this.baseUrl);
    this.requests.push({ method: req.method ?? "", url: url.pathname });
    if (req.method !== "GET") return this.#json(res, 405, { error: "read-only fake" });
    const auth = req.headers.authorization ?? "";
    const basicOk = this.cloud && auth.startsWith("Basic ") && Buffer.from(auth.slice(6), "base64").toString("utf8").endsWith(`:${TEST_TOKEN}`);
    if (auth !== `Bearer ${TEST_TOKEN}` && !basicOk) return this.#json(res, 401, {});

    if (url.pathname === "/redirect-media") {
      res.writeHead(302, { location: this.redirectTarget });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-out") {
      res.writeHead(302, { location: "http://example.invalid/stolen" });
      res.end();
      return;
    }
    if (/^\/rest\/api\/[23]\/myself$/.test(url.pathname)) return this.#json(res, 200, user("Test User"));

    const search = (): JiraIssue[] | null => {
      const jql = url.searchParams.get("jql") ?? "";
      let found = [...this.issues.values()];
      const keyIn = /key in \(([^)]*)\)/.exec(jql);
      if (keyIn) {
        const keys = keyIn[1].split(",").map((k) => k.trim());
        if (keys.some((k) => !this.issues.has(k))) return null;
        found = keys.map((k) => this.issues.get(k)!);
      } else if (jql.includes("resolution = Unresolved")) {
        found = found.filter((i) => i.fields.resolution === null);
      }
      return found;
    };
    if (url.pathname === "/rest/api/2/search") {
      if (this.cloud) return this.#json(res, 410, { errorMessages: ["The requested API has been removed."] });
      const found = search();
      if (!found) return this.#json(res, 400, { errorMessages: ["issue does not exist"] });
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const maxResults = Number(url.searchParams.get("maxResults") ?? 50);
      return this.#json(res, 200, { startAt, maxResults, total: found.length, issues: found.slice(startAt, startAt + maxResults), names: NAMES });
    }
    // Cloud: token pagination, no `names`, `fields` defaults to id only (we always send *all).
    if (url.pathname === "/rest/api/3/search/jql") {
      const found = search();
      if (!found) return this.#json(res, 400, { errorMessages: ["issue does not exist"] });
      if (url.searchParams.get("fields") !== "*all") return this.#json(res, 200, { issues: found.map((i) => ({ key: i.key, id: i.id })), isLast: true });
      const start = Number(url.searchParams.get("nextPageToken") ?? 0);
      const maxResults = Number(url.searchParams.get("maxResults") ?? 50);
      const page = found.slice(start, start + maxResults);
      const isLast = start + page.length >= found.length;
      return this.#json(res, 200, { issues: page, isLast, ...(isLast ? {} : { nextPageToken: String(start + page.length) }) });
    }
    if (url.pathname === "/rest/api/3/field") {
      return this.#json(res, 200, Object.entries(NAMES).map(([id, name]) => ({ id, name })));
    }

    const comment = /^\/rest\/api\/[23]\/issue\/([^/]+)\/comment$/.exec(url.pathname);
    if (comment) {
      const issue = this.issues.get(comment[1]);
      return issue ? this.#json(res, 200, issue.fields.comment) : this.#json(res, 404, {});
    }
    const one = /^\/rest\/api\/[23]\/issue\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const issue = this.issues.get(one[1]);
      return issue ? this.#json(res, 200, { ...issue, names: NAMES }) : this.#json(res, 404, {});
    }
    const file = /^\/secure\/attachment\/(\d+)\//.exec(url.pathname);
    if (file && this.files.has(file[1])) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(this.files.get(file[1]));
      return;
    }
    this.#json(res, 404, {});
  }
}
