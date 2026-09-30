// Web UI data layer (src/serve/api.ts) and the local HTTP server (src/serve/server.ts).

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCommit, cmdInit } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import {
  createNote, createTicketFile, fileView, markSeen, overview, rawFilePath, safeRel, saveFile, setStatus, ticketHistory, ticketView,
} from "../src/serve/api.ts";
import { startServer } from "../src/serve/server.ts";
import { runImport } from "../src/sync/import.ts";
import { loadState } from "../src/vault/state.ts";
import { findTicket } from "../src/vault/store.ts";

let tmp: string;
let vault: string;
let config: Config;
let server: http.Server;
let base: string;
let port: number;

const cloudUser = (name: string, id: string) => ({ accountId: id, emailAddress: `${id}@example.com`, displayName: name });

function comment(id: string, created: string, text: string) {
  return {
    id,
    author: cloudUser("Olga Reporter", "acc-2"),
    created,
    updated: created,
    body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  };
}

function cloudIssue(key: string, fields: Record<string, unknown> = {}) {
  return {
    key,
    id: key.replace(/\D/g, ""),
    fields: {
      summary: `Cloud ${key}`,
      description: "## Problem\n\nSwipe **fails** on iOS.\n\n- step one\n- step two",
      issuetype: { name: "Bug" },
      status: { name: "To Do", statusCategory: { name: "To Do", key: "new" } },
      priority: { name: "High" },
      resolution: null,
      created: "2026-09-10T10:00:00.000+0000",
      updated: "2026-09-10T10:00:00.000+0000",
      assignee: cloudUser("Test User", "acc-1"),
      reporter: cloudUser("Olga Reporter", "acc-2"),
      labels: [],
      components: [],
      fixVersions: [],
      versions: [],
      issuelinks: [],
      subtasks: [],
      attachment: [],
      comment: { comments: [comment("c1", "2026-09-11T09:00:00.000+0000", "Still broken")], total: 1 },
      ...fields,
    },
  };
}

async function importIssues(...issues: unknown[]) {
  const file = path.join(tmp, `issues-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ issues, nextPageToken: null }));
  return runImport(vault, config, [file]);
}

/** Raw request so the Host header can be forged (fetch treats it as forbidden). */
function rawRequest(method: string, urlPath: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const post = (p: string, body: unknown, headers: Record<string, string> = { "x-localflow": "1" }) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localflow-serve-"));
  vault = path.join(tmp, "vault");
  console.log = () => {};
  cmdInit(vault, { jiraUrl: "https://example.atlassian.net", project: "CLD", cloud: true });
  const file = path.join(vault, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.me = "acc-1";
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  cmdCommit(vault, "config");
  config = loadConfig(vault);
  await importIssues(cloudIssue("CLD-7"), cloudIssue("CLD-8", { assignee: null }));
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("overview lists tickets with unread counts and an empty notes tree; createNote fills the tree", () => {
  const o = overview(vault);
  assert.deepEqual(o.tickets.map((t) => t.key).sort(), ["CLD-7", "CLD-8"]);
  for (const t of o.tickets) {
    assert.equal(t.status, "inbox");
    assert.equal(t.source, "jira");
    assert.ok(t.unread > 0, `${t.key} should be unread`);
  }
  assert.equal(o.tickets.find((t) => t.key === "CLD-7")!.mine, true);
  assert.equal(o.tickets.find((t) => t.key === "CLD-8")!.mine, false);
  assert.deepEqual(o.notes, []);
  assert.ok(o.statuses.includes("inprogress"));

  assert.equal(createNote(vault, "", "Journal"), "notes/Journal.md");
  const after = overview(vault);
  assert.deepEqual(after.notes, [{ name: "Journal.md", rel: "notes/Journal.md", dir: false }]);
  assert.throws(() => createNote(vault, "", "Journal"), /already exists/);
  assert.throws(() => createNote(vault, "../x", "Bad"), /Not a valid vault path|Notes live under/);
});

test("ticketView of a never-seen ticket has no highlights, strips the header, and markSeen clears unread", () => {
  const v = ticketView(vault, "cld-7");
  assert.equal(v.row.key, "CLD-7");
  assert.ok(v.unread.length > 0);
  assert.ok(v.blocks.length > 0);
  assert.ok(v.blocks.every((b) => b.state === "same"));
  const html = v.blocks.map((b) => b.html).join("\n");
  assert.doesNotMatch(html, /<h1>/);
  assert.doesNotMatch(html, /Cloud CLD-7/);
  assert.match(html, /Swipe <strong>fails<\/strong> on iOS\./);
  assert.ok(v.files.includes("notes.md"));
  assert.equal(v.seenDate, null);

  markSeen(vault, "CLD-7");
  const seen = ticketView(vault, "CLD-7");
  assert.equal(seen.unread.length, 0);
  assert.ok(seen.seenDate);
  assert.equal(overview(vault).tickets.find((t) => t.key === "CLD-7")!.unread, 0);
  assert.ok(overview(vault).tickets.find((t) => t.key === "CLD-8")!.unread > 0);
});

test("re-import with a changed description and a new comment produces changed and new blocks", async () => {
  await importIssues(
    cloudIssue("CLD-7", {
      description: "## Problem\n\nSwipe **fails** on iOS and iPadOS.\n\n- step one\n- step two",
      updated: "2026-09-12T10:00:00.000+0000",
      comment: {
        comments: [
          comment("c1", "2026-09-11T09:00:00.000+0000", "Still broken"),
          comment("c2", "2026-09-12T09:00:00.000+0000", "Reproduced on a second device"),
        ],
        total: 2,
      },
    }),
  );
  const v = ticketView(vault, "CLD-7");
  assert.ok(v.unread.length > 0);
  const changed = v.blocks.filter((b) => b.state === "changed");
  // The description paragraph and the "Comments (N)" heading (its count went 1 -> 2) both change.
  const para = changed.find((b) => /iPadOS/.test(b.html))!;
  assert.ok(para, "description paragraph is marked changed");
  assert.match(para.was!, /on iOS\./);
  assert.doesNotMatch(para.was!, /iPadOS/);
  assert.ok(changed.some((b) => /Comments \(2\)/.test(b.html) && /Comments \(1\)/.test(b.was!)));
  const fresh = v.blocks.filter((b) => b.state === "new");
  assert.ok(fresh.length >= 1);
  assert.match(fresh.map((b) => b.html).join("\n"), /Reproduced on a second device/);
  assert.ok(v.blocks.some((b) => b.state === "same"));

  const history = ticketHistory(vault, loadState(vault), "CLD-7");
  assert.ok(history.some((e) => e.unread), "new events are unread");
  assert.ok(history.some((e) => !e.unread), "older events are read");
  assert.ok(history.every((e) => e.via === "import"));
  assert.ok(history.some((e) => /comment/i.test(e.text)));
});

test("setStatus writes status and taken to notes.md and rejects unknown statuses", () => {
  setStatus(vault, "CLD-7", "inprogress");
  const t = findTicket(vault, "CLD-7")!;
  assert.equal(t.status, "inprogress");
  const notes = fs.readFileSync(path.join(t.dir, "notes.md"), "utf8");
  assert.match(notes, /^status: inprogress$/m);
  assert.match(notes, /^taken: \d{4}-\d{2}-\d{2}$/m);
  assert.equal(overview(vault).tickets.find((r) => r.key === "CLD-7")!.status, "inprogress");
  assert.throws(() => setStatus(vault, "CLD-7", "bogus"), /Unknown status/);
  assert.throws(() => setStatus(vault, "CLD-999", "done"), /CLD-999|No ticket|not found/i);
});

test("fileView/saveFile round-trip notes.md and keep the frontmatter head", () => {
  const t = findTicket(vault, "CLD-7")!;
  const rel = `${t.rel}/notes.md`;
  const v = fileView(vault, rel);
  assert.equal(v.editable, true);
  assert.match(v.head, /^---\n[\s\S]*status: inprogress[\s\S]*---\n/);
  assert.equal(v.fm.status, "inprogress");

  saveFile(vault, rel, "# Mine\r\n\r\nsome **text**\r\n\r\n\r\n", v.head);
  const text = fs.readFileSync(path.join(vault, rel), "utf8");
  assert.equal(text, v.head + "# Mine\n\nsome **text**\n");
  const again = fileView(vault, rel);
  assert.equal(again.head, v.head);
  assert.deepEqual(again.blocks.map((b) => b.src), ["# Mine", "some **text**"]);
  assert.match(again.blocks[1].html, /<strong>text<\/strong>/);
  assert.equal(findTicket(vault, "CLD-7")!.status, "inprogress");
});

test("saveFile refuses ticket.md of a Jira ticket and other non-editable files", () => {
  const t = findTicket(vault, "CLD-7")!;
  const before = fs.readFileSync(path.join(t.dir, "ticket.md"), "utf8");
  assert.equal(fileView(vault, `${t.rel}/ticket.md`).editable, false);
  assert.throws(() => saveFile(vault, `${t.rel}/ticket.md`, "hacked", ""), /not editable/);
  assert.equal(fs.readFileSync(path.join(t.dir, "ticket.md"), "utf8"), before);
  assert.throws(() => saveFile(vault, "localflow.json", "{}", ""), /not editable|Not a valid/);
});

test("safeRel rejects traversal, dot-directories and internal state", () => {
  assert.equal(safeRel("projects/CLD/x.md"), "projects/CLD/x.md");
  assert.equal(safeRel("/notes/a.md"), "notes/a.md");
  assert.throws(() => safeRel("../x"), /Not a valid vault path/);
  assert.throws(() => safeRel("notes/../../x"), /Not a valid vault path/);
  assert.throws(() => safeRel(".git/x"), /Not a valid vault path/);
  assert.throws(() => safeRel(".localflow/state.json"), /Not a valid vault path/);
  assert.throws(() => safeRel("notes/.hidden.md"), /Not a valid vault path/);
  assert.throws(() => safeRel(""), /Not a valid vault path/);
});

test("rawFilePath returns null outside the vault and for missing files", () => {
  const t = findTicket(vault, "CLD-7")!;
  assert.equal(rawFilePath(vault, `${t.rel}/notes.md`), path.join(vault, t.rel, "notes.md"));
  assert.equal(rawFilePath(vault, "../outside.txt"), null);
  assert.equal(rawFilePath(vault, ".git/config"), null);
  assert.equal(rawFilePath(vault, `${t.rel}/missing.png`), null);
  assert.equal(rawFilePath(vault, t.rel), null, "directories are not served");
});

test("createTicketFile refuses reserved names and creates a note with ticket frontmatter", () => {
  assert.throws(() => createTicketFile(vault, "CLD-7", "ticket"), /reserved/);
  assert.throws(() => createTicketFile(vault, "CLD-7", "raw"), /reserved/);
  const rel = createTicketFile(vault, "CLD-7", "Design Notes");
  const t = findTicket(vault, "CLD-7")!;
  assert.equal(rel, `${t.rel}/Design-Notes.md`);
  const text = fs.readFileSync(path.join(vault, rel), "utf8");
  assert.match(text, /^ticket: CLD-7$/m);
  assert.match(text, /# CLD-7 — Design Notes/);
  assert.throws(() => createTicketFile(vault, "CLD-7", "Design Notes"), /already exists/);
  assert.ok(ticketView(vault, "CLD-7").files.includes("Design-Notes.md"));
});

test("HTTP server binds loopback only and serves the UI and API", async () => {
  server = await startServer(vault, { port: 0 });
  const addr = server.address() as { address: string; port: number };
  assert.equal(addr.address, "127.0.0.1");
  port = addr.port;
  base = `http://127.0.0.1:${port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /text\/html/);
  assert.match(await page.text(), /<html|<!doctype html/i);
  assert.match(page.headers.get("content-security-policy")!, /default-src 'self'/);

  const o = await fetch(`${base}/api/overview`);
  assert.equal(o.status, 200);
  const data = (await o.json()) as { tickets: Array<{ key: string }> };
  assert.deepEqual(data.tickets.map((t) => t.key).sort(), ["CLD-7", "CLD-8"]);

  const tv = await fetch(`${base}/api/ticket/CLD-8`);
  assert.equal(tv.status, 200);
  assert.equal(((await tv.json()) as { row: { key: string } }).row.key, "CLD-8");
  const hist = await fetch(`${base}/api/ticket/cld-8/history`);
  assert.equal(hist.status, 200);
  assert.ok(((await hist.json()) as { events: unknown[] }).events.length > 0);

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { error: string }).error, /No such API/);
  assert.equal((await fetch(`${base}/nothing-here`)).status, 404);
});

test("requests with a foreign Host header get 421", async () => {
  const r = await rawRequest("GET", "/api/overview", { Host: "evil.example" });
  assert.equal(r.status, 421);
  const r2 = await rawRequest("GET", "/api/overview", { Host: `evil.example:${port}` });
  assert.equal(r2.status, 421);
  const ok = await rawRequest("GET", "/api/overview", { Host: `localhost:${port}` });
  assert.equal(ok.status, 200);
});

test("mutations need X-LocalFlow and a local Origin", async () => {
  assert.ok(overview(vault).tickets.find((t) => t.key === "CLD-8")!.unread > 0);

  const denied = await post("/api/seen", { key: "CLD-8" }, {});
  assert.equal(denied.status, 403);
  assert.ok(overview(vault).tickets.find((t) => t.key === "CLD-8")!.unread > 0, "nothing changed");

  const foreign = await post("/api/seen", { key: "CLD-8" }, { "x-localflow": "1", origin: "https://evil.example" });
  assert.equal(foreign.status, 403);

  const ok = await post("/api/seen", { key: "CLD-8" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(overview(vault).tickets.find((t) => t.key === "CLD-8")!.unread, 0);
});

test("API mutations: status, note, bad input", async () => {
  const s = await post("/api/status", { key: "CLD-8", status: "inreview" });
  assert.equal(s.status, 200);
  assert.equal(findTicket(vault, "CLD-8")!.status, "inreview");
  const bad = await post("/api/status", { key: "CLD-8", status: "nope" });
  assert.equal(bad.status, 400);
  const missing = await post("/api/status", { key: "CLD-8" });
  assert.equal(missing.status, 400);

  const n = await post("/api/note", { folder: "ideas", name: "First" });
  assert.equal(n.status, 200);
  assert.deepEqual(await n.json(), { path: "notes/ideas/First.md" });

  const render = await post("/api/render", { src: "**hi**", path: "notes/ideas/First.md" });
  assert.deepEqual(await render.json(), { html: "<p><strong>hi</strong></p>" });
});

test("PUT /api/file: bad JSON is 400, good body is saved", async () => {
  const badJson = await fetch(`${base}/api/file`, { method: "PUT", headers: { "x-localflow": "1", "content-type": "application/json" }, body: "{not json" });
  assert.equal(badJson.status, 400);
  const notObject = await fetch(`${base}/api/file`, { method: "PUT", headers: { "x-localflow": "1" }, body: "[1,2]" });
  assert.equal(notObject.status, 400);
  const noHeader = await fetch(`${base}/api/file`, { method: "PUT", body: "{}" });
  assert.equal(noHeader.status, 403);

  const good = await fetch(`${base}/api/file`, {
    method: "PUT",
    headers: { "x-localflow": "1", "content-type": "application/json" },
    body: JSON.stringify({ path: "notes/ideas/First.md", body: "# First\n\nhello", head: "" }),
  });
  assert.equal(good.status, 200);
  assert.equal(fs.readFileSync(path.join(vault, "notes/ideas/First.md"), "utf8"), "# First\n\nhello\n");

  const view = await fetch(`${base}/api/file?path=${encodeURIComponent("notes/ideas/First.md")}`);
  assert.equal(view.status, 200);
  assert.equal(((await view.json()) as { editable: boolean }).editable, true);
  const outside = await fetch(`${base}/api/file?path=${encodeURIComponent("../localflow.json")}`);
  assert.equal(outside.status, 400);
});

test("/raw serves vault files as text and refuses everything outside", async () => {
  const t = findTicket(vault, "CLD-7")!;
  const r = await fetch(`${base}/raw/${t.rel}/notes.md`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /^text\/plain/);
  assert.match(await r.text(), /# Mine/);

  assert.equal((await fetch(`${base}/raw/..%2Flocalflow.json`)).status, 404);
  assert.equal((await fetch(`${base}/raw/%2E%2E%2Flocalflow.json`)).status, 404);
  assert.equal((await fetch(`${base}/raw/.git%2Fconfig`)).status, 404);
  assert.equal((await fetch(`${base}/raw/.localflow%2Fstate.json`)).status, 404);
  assert.equal((await fetch(`${base}/raw/${t.rel}/missing.png`)).status, 404);
  // Raw ".." survives only if the client does not normalise; send it verbatim.
  const verbatim = await rawRequest("GET", "/raw/../localflow.json", { Host: `127.0.0.1:${port}` });
  assert.ok([404, 200].includes(verbatim.status));
  assert.doesNotMatch(verbatim.body, /jira/i);

  const post405 = await fetch(`${base}/raw/x`, { method: "POST", headers: { "x-localflow": "1" } });
  assert.equal(post405.status, 405);
});
