// `lf serve`: the local web UI. The only place in the code base that opens a listening socket,
// and it binds the loopback interface only. Every request is checked against the Host header
// (DNS rebinding) and mutations need a custom header (cross-site requests cannot set one).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ConflictError, UserError } from "../util.ts";
import { assertLocalOnly } from "../vault/git.ts";
import {
  alignStatus, createGroup, createLoop, editLoopLine, createNote, createTicketFile, deleteGroup, fileView, finishLoop, linkedFileView, loopBoard, loopInput,
  markSeen, moveLoop, overview, rawFilePath, renderOne, saveFile, setFrontmatter, setStatus, setTicketGroup, setTicketParent, standupText,
  syncTicket, ticketHistory, ticketView,
} from "./api.ts";
import type { SyncResult } from "./api.ts";
import { outlineDay, outlineDays, outlineHistory, outlineOps, outlineView } from "./outline-api.ts";
import { commitOutline } from "../vault/outline-history.ts";
import { migrateOutline } from "../vault/outline-migrate.ts";
import { LOOPS_FILE, outlineHooks } from "../vault/outline-store.ts";
import { OUTLINE_FILE } from "../vault/outline.ts";
import { linkFolder, unlinkFolder } from "../vault/links.ts";
import { setRepo } from "../vault/scaffold.ts";
import { requireTicket } from "../vault/store.ts";
import { loadState } from "../vault/state.ts";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7420;
const UI_DIR = path.join(import.meta.dirname, "ui");
const MAX_BODY = 4 * 1024 * 1024;

const UI_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
// Attachments come from Jira, i.e. from other people. Only types a browser cannot execute are
// shown inline; everything else (html, svg, js, …) is offered as a download, and every raw
// response is sandboxed so even a mislabeled file cannot run script against the API.
const RAW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

export interface ServeOptions {
  port?: number;
  /** Quiet period before the outline's changes are committed (default 20 s). */
  commitDelayMs?: number;
  log?: (line: string) => void;
  /** Replaces the in-process sync (tests only: lets a sync be held open). */
  syncRunner?: (vault: string, key: string) => Promise<SyncResult>;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  // Serialised first: a value that cannot be sent becomes a 500, not a half-written response.
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new HttpError(413, "Request body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `${LOOPBACK_HOST}:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  return origin === `http://${LOOPBACK_HOST}:${port}` || origin === `http://localhost:${port}` || origin === `http://[::1]:${port}`;
}

/**
 * Change counter for the page's long-poll: any file event under the vault (except git internals)
 * bumps it after a short quiet period, and waiting /api/changes requests are answered.
 */
class ChangeFeed {
  version = 1;
  #waiters: Array<() => void> = [];
  #timer: NodeJS.Timeout | null = null;

  constructor(vault: string, say: (line: string) => void, onFile?: (rel: string) => void) {
    try {
      const watcher = fs.watch(vault, { recursive: true }, (_event, name) => {
        const rel = String(name ?? "");
        if (rel === ".git" || rel.startsWith(".git/") || rel.endsWith(".tmp")) return;
        onFile?.(rel);
        this.#bump();
      });
      watcher.on("error", (e) => say(`watch error: ${(e as Error).message}`));
      watcher.unref();
    } catch (e) {
      say(`live updates off: ${(e as Error).message}`);
    }
  }

  #bump(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.version++;
      const w = this.#waiters;
      this.#waiters = [];
      for (const resolve of w) resolve();
    }, 250);
    this.#timer.unref();
  }

  /** Resolves when the version passes `since`, or after `timeoutMs`. */
  wait(since: number, timeoutMs: number): Promise<number> {
    if (this.version > since) return Promise.resolve(this.version);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        this.#waiters = this.#waiters.filter((x) => x !== done);
        resolve(this.version);
      };
      const t = setTimeout(done, timeoutMs);
      this.#waiters.push(done);
    });
  }
}

/**
 * Commits outline.md and loops.md after a quiet period: edits from the page ("outline (ui)") and
 * edits made in another editor while the UI runs ("outline (hand)"), so the history has them all.
 */
class OutlineCommitter {
  #summary: string[] = [];
  #timer: NodeJS.Timeout | null = null;
  #vault: string;
  #say: (line: string) => void;
  #delay: number;

  constructor(vault: string, say: (line: string) => void, delay: number) {
    this.#vault = vault;
    this.#say = say;
    this.#delay = delay;
  }

  wrote(summary: string[]): void {
    this.#summary.push(...summary);
    this.touched();
  }

  touched(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), this.#delay);
    this.#timer.unref();
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const summary = this.#summary;
    this.#summary = [];
    try {
      commitOutline(this.#vault, summary.length ? "ui" : "hand", summary.length ? summary : ["edited outside lf"]);
    } catch (e) {
      // Another git command may hold the index (lf sync): keep what was done and try again later.
      this.#say(`outline commit failed, retrying: ${(e as Error).message}`);
      this.#summary = [...summary, ...this.#summary];
      this.#timer = setTimeout(() => this.flush(), this.#delay * 3);
      this.#timer.unref();
    }
  }
}

export function startServer(vault: string, opts: ServeOptions = {}): Promise<http.Server> {
  assertLocalOnly(vault);
  // Replaced by the real port once listening, so that port 0 (ephemeral) passes the Host check.
  let port = opts.port ?? DEFAULT_PORT;
  const say = opts.log ?? (() => {});
  const committer = new OutlineCommitter(vault, say, opts.commitDelayMs ?? 20_000);
  outlineHooks.afterWrite = (v, summary) => {
    if (v === vault) committer.wrote(summary);
  };
  const changes = new ChangeFeed(vault, say, (rel) => {
    if (rel === OUTLINE_FILE || rel === LOOPS_FILE) committer.touched();
  });
  // One sync at a time per server: a second request while one runs gets 409.
  let syncing = false;
  const runSyncOnce = async (key: string): Promise<SyncResult> => {
    if (syncing) throw new HttpError(409, "A sync is already running.");
    syncing = true;
    try {
      return await (opts.syncRunner ?? syncTicket)(vault, key);
    } finally {
      syncing = false;
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, port)) throw new HttpError(421, "Local Flow answers only to 127.0.0.1 / localhost");
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);
      const method = req.method ?? "GET";
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'");

      if (url.pathname.startsWith("/api/")) {
        const route = `${method} ${url.pathname}`;
        if (method !== "GET") {
          if (req.headers["x-localflow"] !== "1") throw new HttpError(403, "Missing X-LocalFlow header");
          if (!originAllowed(req.headers.origin, port)) throw new HttpError(403, "Cross-origin request refused");
        }
        if (route === "GET /api/changes") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return json(res, 200, { version: await changes.wait(Number.isFinite(since) ? since : 0, 25_000) });
        }
        return json(res, 200, await api(vault, method, url, method === "GET" ? {} : parseJson(await readBody(req)), runSyncOnce));
      }
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
      if (url.pathname.startsWith("/raw/")) return serveRaw(res, rawFilePath(vault, decodeURIComponent(url.pathname.slice(5))));
      if (url.pathname === "/") return serveUi(res, path.join(UI_DIR, "app.html"));
      if (/^\/(app|outline)\.(css|js)$/.test(url.pathname)) return serveUi(res, path.join(UI_DIR, url.pathname.slice(1)));
      throw new HttpError(404, "Not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof ConflictError ? 409 : e instanceof UserError ? 400 : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status === 500) say(`error: ${message}`);
      json(res, status, { error: message });
    }
  });

  server.on("close", () => {
    committer.flush();
    if (outlineHooks.afterWrite) outlineHooks.afterWrite = null;
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      port = (server.address() as { port: number }).port;
      say(`Local Flow UI: http://${LOOPBACK_HOST}:${port}/  (vault ${vault})`);
      resolve(server);
    });
  });
}

function parseJson(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Body must be a JSON object");
}

function serveUi(res: http.ServerResponse, file: string): void {
  if (!fs.existsSync(file)) throw new HttpError(404, "Not found");
  res.writeHead(200, { "content-type": UI_MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

function serveRaw(res: http.ServerResponse, file: string | null): void {
  if (!file) throw new HttpError(404, "Not found");
  const type = RAW_MIME[path.extname(file).toLowerCase()];
  const headers: Record<string, string> = {
    "content-type": type ?? "application/octet-stream",
    "cache-control": "no-store",
    "content-security-policy": "sandbox; default-src 'none'",
  };
  if (!type) headers["content-disposition"] = `attachment; filename=${JSON.stringify(path.basename(file))}`;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function str(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key];
  if (typeof v === "string") return v;
  if (required) throw new HttpError(400, `Missing "${key}"`);
  return "";
}

/** A string, or null when the key is absent or null (clears the value). */
function strOrNull(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  throw new HttpError(400, `"${key}" must be a string or null`);
}

function optional(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  throw new HttpError(400, `"${key}" must be a string`);
}

function obj(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = body[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, `"${key}" must be an object`);
  return v as Record<string, unknown>;
}

async function api(
  vault: string, method: string, url: URL, body: Record<string, unknown>, sync: (key: string) => Promise<SyncResult>,
): Promise<unknown> {
  const p = url.pathname;
  const route = `${method} ${p}`;
  if (route === "GET /api/overview") return overview(vault);
  const ticket = /^GET \/api\/ticket\/([A-Za-z][A-Za-z0-9_]*-\d+)$/.exec(route);
  if (ticket) return ticketView(vault, ticket[1]);
  const history = /^GET \/api\/ticket\/([A-Za-z][A-Za-z0-9_]*-\d+)\/history$/.exec(route);
  if (history) return { events: ticketHistory(vault, loadState(vault), history[1].toUpperCase()) };
  if (route === "GET /api/file") return fileView(vault, url.searchParams.get("path") ?? "");
  if (route === "GET /api/linked-file") {
    return linkedFileView(vault, url.searchParams.get("key") ?? "", url.searchParams.get("path") ?? "");
  }
  if (route === "POST /api/render") return { html: renderOne(str(body, "src"), str(body, "path")) };
  // Whole-file writes are compare-and-swap: the client sends the hash of the version it loaded.
  if (route === "PUT /api/file") {
    return { ok: true, hash: saveFile(vault, str(body, "path"), str(body, "body"), str(body, "head", false), str(body, "hash")) };
  }
  if (route === "POST /api/frontmatter") {
    const updates = body.updates;
    if (!updates || typeof updates !== "object") throw new HttpError(400, 'Missing "updates"');
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(updates as Record<string, unknown>)) if (typeof v === "string" && /^[A-Za-z_][\w-]*$/.test(k) && !["__proto__", "constructor", "prototype"].includes(k)) clean[k] = v;
    return { ok: true, hash: setFrontmatter(vault, str(body, "path"), clean, str(body, "hash")) };
  }
  if (route === "POST /api/seen") {
    markSeen(vault, str(body, "key"));
    return { ok: true };
  }
  if (route === "POST /api/status") {
    setStatus(vault, str(body, "key"), str(body, "status"));
    return { ok: true };
  }
  if (route === "POST /api/ticket-file") return { path: createTicketFile(vault, str(body, "key"), str(body, "name")) };
  if (route === "POST /api/group") {
    createGroup(vault, str(body, "name"));
    return { ok: true };
  }
  if (route === "POST /api/group/delete" || route === "DELETE /api/group") {
    deleteGroup(vault, str(body, "name"));
    return { ok: true };
  }
  if (route === "POST /api/ticket-group") {
    setTicketGroup(vault, str(body, "key"), strOrNull(body, "group"));
    return { ok: true };
  }
  if (route === "POST /api/ticket-parent") {
    setTicketParent(vault, str(body, "key"), strOrNull(body, "parent"));
    return { ok: true };
  }
  if (route === "POST /api/link") return linkFolder(vault, str(body, "key"), str(body, "path"));
  if (route === "POST /api/unlink") return unlinkFolder(vault, str(body, "key"), str(body, "path"));
  if (route === "POST /api/repo") return setRepo(vault, requireTicket(vault, str(body, "key")), str(body, "name"));
  if (route === "POST /api/sync") return sync(str(body, "key"));
  if (route === "POST /api/note") return { path: createNote(vault, str(body, "folder", false), str(body, "name")) };
  if (route === "POST /api/align") {
    const keys = body.keys;
    if (keys !== "all" && !(Array.isArray(keys) && keys.every((k) => typeof k === "string"))) throw new HttpError(400, '"keys" must be a list of keys or "all"');
    return { changes: alignStatus(vault, keys as string[] | "all", body.dryRun === true) };
  }
  if (route === "GET /api/loops") return loopBoard(vault);
  if (route === "POST /api/loop") return createLoop(vault, loopInput(body));
  if (route === "POST /api/loop/done") {
    // "next": a loop, or null when the user explicitly skipped it. Leaving it out is an error.
    if (!("next" in body)) throw new HttpError(400, 'Missing "next": the next loop, or null to skip it');
    const next = body.next === null ? null : loopInput(obj(body, "next"));
    return finishLoop(vault, str(body, "id"), str(body, "outcome", false), next, optional(body, "expect"));
  }
  if (route === "POST /api/loop/bump") return moveLoop(vault, str(body, "id"), str(body, "by"), optional(body, "else"), optional(body, "expect"));
  if (route === "PUT /api/loop/line") return editLoopLine(vault, str(body, "id"), str(body, "line"), str(body, "expect"));
  if (route === "GET /api/outline") return outlineView(vault);
  if (route === "POST /api/outline/op") return outlineOps(vault, body.ops);
  if (route === "GET /api/outline/history") {
    return outlineHistory(vault, { id: url.searchParams.get("id") ?? undefined, key: url.searchParams.get("key") ?? undefined });
  }
  if (route === "POST /api/outline/migrate") {
    const r = migrateOutline(vault);
    return { ...r, message: `outline.md: ${r.tickets} tickets, ${r.items} items (${r.closed} closed steps from the Logs)` };
  }
  if (route === "GET /api/outline/days") return { days: outlineDays(vault) };
  if (route === "GET /api/outline/day") return outlineDay(vault, url.searchParams.get("day") ?? "");
  if (route === "GET /api/standup") return { text: standupText(vault, url.searchParams.get("week") === "1") };
  throw new HttpError(404, `No such API: ${route}`);
}
