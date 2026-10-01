// The ONLY module allowed to touch the network (enforced by test/network-guard.test.ts).
// Guarantees:
//   - GET requests only: there is no code path that writes to Jira;
//   - every request, including each redirect hop, must target the configured Jira origin, or one
//     of the extra hosts the caller allows (Cloud serves attachments from api.media.atlassian.com);
//     credentials are sent to the Jira origin only, never to an extra host;
//   - plain http is accepted for loopback only (tests);
//   - with `loopbackOnly` (transport "import") no connection ever leaves the machine.

import { UserError } from "../util.ts";

const MAX_REDIRECTS = 5;
/** Where Jira Cloud redirects attachment downloads (pre-signed URLs, no credentials needed). */
export const CLOUD_MEDIA_HOSTS = ["api.media.atlassian.com"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class JiraHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface JiraAuth {
  /** Data Center: Personal Access Token as a Bearer token. Cloud: email + API token as Basic auth. */
  kind: "bearer" | "basic";
  token: string;
  email?: string;
}

export function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export class JiraClient {
  readonly origin: URL;
  readonly #authorization: string;
  readonly #userAgent: string;
  readonly #loopbackOnly: boolean;
  readonly #extraHosts: Set<string>;

  constructor(baseUrl: string, auth: JiraAuth, userAgent: string, loopbackOnly = false, extraHosts: string[] = []) {
    let origin: URL;
    try {
      origin = new URL(baseUrl);
    } catch {
      throw new UserError(`Invalid jira.baseUrl: ${baseUrl}`);
    }
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && LOOPBACK_HOSTS.has(origin.hostname))) {
      throw new UserError(`jira.baseUrl must be https (got ${baseUrl})`);
    }
    this.#loopbackOnly = loopbackOnly;
    if (loopbackOnly && !isLoopback(origin.hostname)) {
      throw new UserError(
        `jira.transport is "import": lf opens no outbound connections (${origin.host} refused). ` +
          `Use \`lf import\`, or set jira.transport to "rest" to allow REST access.`,
      );
    }
    this.origin = origin;
    this.#extraHosts = new Set(loopbackOnly ? [] : extraHosts);
    if (auth.kind === "basic") {
      if (!auth.email) throw new UserError("Jira Cloud needs jira.email in localflow.json (paired with the API token).");
      this.#authorization = "Basic " + Buffer.from(`${auth.email}:${auth.token}`).toString("base64");
    } else {
      this.#authorization = `Bearer ${auth.token}`;
    }
    this.#userAgent = userAgent;
  }

  #assertAllowed(url: URL): void {
    if (this.#loopbackOnly && !isLoopback(url.hostname)) {
      throw new Error(`Refusing request to ${url.origin}: transport is "import", loopback only`);
    }
    if (url.protocol === this.origin.protocol && url.host === this.origin.host) return;
    if ((url.protocol === "https:" || isLoopback(url.hostname)) && this.#extraHosts.has(url.host)) return;
    const allowed = [this.origin.origin, ...[...this.#extraHosts].map((h) => `https://${h}`)].join(", ");
    throw new Error(`Refusing request to ${url.origin}: only ${allowed} is allowed`);
  }

  #isOrigin(url: URL): boolean {
    return url.protocol === this.origin.protocol && url.host === this.origin.host;
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
            // Extra hosts get pre-signed URLs from Jira; the token never travels there.
            ...(this.#isOrigin(current) ? { Authorization: this.#authorization } : {}),
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
