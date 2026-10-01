// `lf serve`: the local web UI. The only place in the code base that opens a listening socket,
// and it binds the loopback interface only. Every request is checked against the Host header
// (DNS rebinding) and mutations need a custom header (cross-site requests cannot set one).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { UserError } from "../util.ts";
import { assertLocalOnly } from "../vault/git.ts";
import {
  createNote, createTicketFile, fileView, markSeen, overview, rawFilePath, renderOne, saveFile,
  setFrontmatter, setStatus, ticketHistory, ticketView,
} from "./api.ts";
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
  log?: (line: string) => void;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
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

  constructor(vault: string, say: (line: string) => void) {
    try {
      const watcher = fs.watch(vault, { recursive: true }, (_event, name) => {
        const rel = String(name ?? "");
        if (rel === ".git" || rel.startsWith(".git/") || rel.endsWith(".tmp")) return;
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

export function startServer(vault: string, opts: ServeOptions = {}): Promise<http.Server> {
  assertLocalOnly(vault);
  // Replaced by the real port once listening, so that port 0 (ephemeral) passes the Host check.
  let port = opts.port ?? DEFAULT_PORT;
  const say = opts.log ?? (() => {});
  const changes = new ChangeFeed(vault, say);

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
        return json(res, 200, await api(vault, method, url, method === "GET" ? {} : parseJson(await readBody(req))));
      }
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
      if (url.pathname.startsWith("/raw/")) return serveRaw(res, rawFilePath(vault, decodeURIComponent(url.pathname.slice(5))));
      if (url.pathname === "/") return serveUi(res, path.join(UI_DIR, "app.html"));
      if (/^\/app\.(css|js)$/.test(url.pathname)) return serveUi(res, path.join(UI_DIR, url.pathname.slice(1)));
      throw new HttpError(404, "Not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof UserError ? 400 : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status === 500) say(`error: ${message}`);
      json(res, status, { error: message });
    }
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

async function api(vault: string, method: string, url: URL, body: Record<string, unknown>): Promise<unknown> {
  const p = url.pathname;
  const route = `${method} ${p}`;
  if (route === "GET /api/overview") return overview(vault);
  const ticket = /^GET \/api\/ticket\/([A-Za-z][A-Za-z0-9_]*-\d+)$/.exec(route);
  if (ticket) return ticketView(vault, ticket[1]);
  const history = /^GET \/api\/ticket\/([A-Za-z][A-Za-z0-9_]*-\d+)\/history$/.exec(route);
  if (history) return { events: ticketHistory(vault, loadState(vault), history[1].toUpperCase()) };
  if (route === "GET /api/file") return fileView(vault, url.searchParams.get("path") ?? "");
  if (route === "POST /api/render") return { html: renderOne(str(body, "src"), str(body, "path")) };
  if (route === "PUT /api/file") {
    saveFile(vault, str(body, "path"), str(body, "body"), str(body, "head", false));
    return { ok: true };
  }
  if (route === "POST /api/frontmatter") {
    const updates = body.updates;
    if (!updates || typeof updates !== "object") throw new HttpError(400, 'Missing "updates"');
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(updates as Record<string, unknown>)) if (typeof v === "string" && /^[A-Za-z_][\w-]*$/.test(k) && !["__proto__", "constructor", "prototype"].includes(k)) clean[k] = v;
    setFrontmatter(vault, str(body, "path"), clean);
    return { ok: true };
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
  if (route === "POST /api/note") return { path: createNote(vault, str(body, "folder", false), str(body, "name")) };
  throw new HttpError(404, `No such API: ${route}`);
}
