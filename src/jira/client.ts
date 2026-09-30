// The ONLY module allowed to touch the network (enforced by test/network-guard.test.ts).
// Guarantees:
//   - GET requests only: there is no code path that writes to Jira;
//   - every request, including each redirect hop, must target the configured Jira origin;
//   - plain http is accepted for loopback only (tests).

import { UserError } from "../util.ts";

const MAX_REDIRECTS = 5;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class JiraHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class JiraClient {
  readonly origin: URL;
  readonly #token: string;
  readonly #userAgent: string;

  constructor(baseUrl: string, token: string, userAgent: string) {
    let origin: URL;
    try {
      origin = new URL(baseUrl);
    } catch {
      throw new UserError(`Invalid jira.baseUrl: ${baseUrl}`);
    }
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && LOOPBACK_HOSTS.has(origin.hostname))) {
      throw new UserError(`jira.baseUrl must be https (got ${baseUrl})`);
    }
    this.origin = origin;
    this.#token = token;
    this.#userAgent = userAgent;
  }

  #assertAllowed(url: URL): void {
    if (url.protocol !== this.origin.protocol || url.host !== this.origin.host) {
      throw new Error(`Refusing request to ${url.origin}: only ${this.origin.origin} is allowed`);
    }
  }

  async #get(url: URL, accept: string, timeoutMs: number): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.#assertAllowed(current);
      let res: Response;
      try {
        res = await fetch(current, {
          method: "GET",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${this.#token}`,
            Accept: accept,
            "User-Agent": this.#userAgent,
            "X-Atlassian-Token": "no-check",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
        throw new Error(`Cannot reach ${this.origin.host} (${cause}). Is the VPN connected?`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new JiraHttpError(res.status, `Redirect without Location from ${current.pathname}`);
        current = new URL(location, current);
        continue;
      }
      if (!res.ok) {
        let hint = "";
        if (res.status === 401) hint = " — token is invalid or expired";
        else if (res.status === 403) hint = " — token lacks permission (or was blocked by the WAF)";
        throw new JiraHttpError(res.status, `Jira responded ${res.status} for ${current.pathname}${hint}`);
      }
      return res;
    }
    throw new Error(`Too many redirects for ${url.pathname}`);
  }

  /** `apiPath` is relative to the Jira base URL, e.g. `/rest/api/2/myself`. */
  async getJson(apiPath: string, params: Record<string, string | number> = {}): Promise<any> {
    const base = this.origin.href.replace(/\/$/, "");
    const url = new URL(base + apiPath);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await this.#get(url, "application/json", 30_000);
    return res.json();
  }

  /** Download a binary resource (attachment). The URL must be on the Jira origin. */
  async download(absoluteUrl: string): Promise<Uint8Array> {
    const res = await this.#get(new URL(absoluteUrl), "*/*", 120_000);
    return new Uint8Array(await res.arrayBuffer());
  }
}
