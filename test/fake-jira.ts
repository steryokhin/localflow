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
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) return this.#json(res, 401, {});

    if (url.pathname === "/redirect-out") {
      res.writeHead(302, { location: "http://example.invalid/stolen" });
      res.end();
      return;
    }
    if (url.pathname === "/rest/api/2/myself") return this.#json(res, 200, user("Test User"));

    if (url.pathname === "/rest/api/2/search") {
      const jql = url.searchParams.get("jql") ?? "";
      let found = [...this.issues.values()];
      const keyIn = /key in \(([^)]*)\)/.exec(jql);
      if (keyIn) {
        const keys = keyIn[1].split(",").map((k) => k.trim());
        if (keys.some((k) => !this.issues.has(k))) return this.#json(res, 400, { errorMessages: ["issue does not exist"] });
        found = keys.map((k) => this.issues.get(k)!);
      } else if (jql.includes("resolution = Unresolved")) {
        found = found.filter((i) => i.fields.resolution === null);
      }
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const maxResults = Number(url.searchParams.get("maxResults") ?? 50);
      return this.#json(res, 200, { startAt, maxResults, total: found.length, issues: found.slice(startAt, startAt + maxResults), names: NAMES });
    }

    const comment = /^\/rest\/api\/2\/issue\/([^/]+)\/comment$/.exec(url.pathname);
    if (comment) {
      const issue = this.issues.get(comment[1]);
      return issue ? this.#json(res, 200, issue.fields.comment) : this.#json(res, 404, {});
    }
    const one = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(url.pathname);
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
