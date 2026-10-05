// Web UI data layer (src/serve/api.ts) and the local HTTP server (src/serve/server.ts).

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCommit, cmdCreate, cmdInit } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import {
  createNote, createTicketFile, fileView, markSeen, overview, rawFilePath, safeRel, saveFile, setStatus, ticketHistory, ticketView,
} from "../src/serve/api.ts";
import { startServer } from "../src/serve/server.ts";
import { runImport } from "../src/sync/import.ts";
import { runSync } from "../src/sync/run.ts";
import { FakeJira, TEST_TOKEN, makeIssue } from "./fake-jira.ts";
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
  assert.throws(() => safeRel("localflow.json"), /Not a valid vault path/);
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

test("GET /api/changes answers immediately when behind and after a file change when current", async () => {
  const first = await (await fetch(`${base}/api/changes?since=0`)).json();
  assert.ok(first.version >= 1);
  // Current version: the request waits; a new file under the vault releases it.
  const waiting = fetch(`${base}/api/changes?since=${first.version}`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 150));
  fs.writeFileSync(path.join(vault, "notes", "live.md"), "# live\n");
  const next = await waiting;
  assert.ok(next.version > first.version);
});

const readNotes = (key: string): string => fs.readFileSync(path.join(findTicket(vault, key)!.dir, "notes.md"), "utf8");
const groupNames = (): string[] => overview(vault).groups.map((g) => g.name);

test("groups: implied by project prefix, created, listed with counts, moved and deleted without touching tickets", async () => {
  assert.deepEqual(groupNames(), ["CLD"]);
  const implied = overview(vault).groups[0];
  assert.equal(implied.removable, false);
  assert.equal(overview(vault).tickets.find((t) => t.key === "CLD-7")!.group, "CLD");

  assert.equal((await post("/api/group", { name: "  Review  " })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vault, "groups.json"), "utf8")), { groups: ["Review"] });
  // File order first, then groups implied by tickets.
  assert.deepEqual(groupNames(), ["Review", "CLD"]);
  const empty = overview(vault).groups.find((g) => g.name === "Review")!;
  assert.deepEqual([empty.open, empty.unread, empty.removable], [0, 0, true]);
  assert.equal((await post("/api/group", { name: "Review" })).status, 400, "duplicate");
  assert.equal((await post("/api/group", { name: "CLD" })).status, 400, "implied group already exists");

  assert.equal((await post("/api/ticket-group", { key: "CLD-7", group: "Review" })).status, 200);
  assert.match(readNotes("CLD-7"), /^group: Review$/m);
  const o = overview(vault);
  assert.equal(o.tickets.find((t) => t.key === "CLD-7")!.group, "Review");
  const review = o.groups.find((g) => g.name === "Review")!;
  assert.equal(review.open, 1);
  assert.ok(review.unread >= 0);
  assert.equal((await post("/api/ticket-group", { key: "CLD-7", group: "Nope" })).status, 400, "unknown group");

  // Moving back to the project's own group clears the key; null does too.
  assert.equal((await post("/api/ticket-group", { key: "CLD-7", group: "CLD" })).status, 200);
  assert.doesNotMatch(readNotes("CLD-7"), /^group:/m);
  await post("/api/ticket-group", { key: "CLD-7", group: "Review" });
  assert.equal((await post("/api/ticket-group", { key: "CLD-7", group: null })).status, 200);
  assert.doesNotMatch(readNotes("CLD-7"), /^group:/m);

  // Deleting a group clears `group:` from its tickets; the tickets stay and fall back to the prefix.
  await post("/api/ticket-group", { key: "CLD-7", group: "Review" });
  const before = readNotes("CLD-7");
  assert.equal((await fetch(`${base}/api/group`, { method: "DELETE", headers: { "x-localflow": "1", "content-type": "application/json" }, body: JSON.stringify({ name: "Review" }) })).status, 200);
  assert.deepEqual(groupNames(), ["CLD"]);
  assert.equal(readNotes("CLD-7"), before.replace(/^group: Review\n/m, ""));
  assert.equal(overview(vault).tickets.find((t) => t.key === "CLD-7")!.group, "CLD");
  assert.ok(findTicket(vault, "CLD-7"));
  assert.equal((await post("/api/group/delete", { name: "Review" })).status, 400, "already gone");
  assert.equal((await post("/api/group/delete", { name: "CLD" })).status, 400, "implied groups cannot be deleted");
});

test("group names are validated; group/parent cannot be set through the generic frontmatter endpoint", async () => {
  for (const name of ["", "   ", "x".repeat(65), "a\nb", "a\u0000b", "__proto__", "constructor"]) {
    assert.equal((await post("/api/group", { name })).status, 400, JSON.stringify(name));
  }
  assert.equal((await post("/api/group", {})).status, 400);
  assert.equal((await post("/api/group", { name: "x".repeat(64) })).status, 200);
  await post("/api/group/delete", { name: "x".repeat(64) });

  // Names that need YAML quoting survive a round trip through notes.md.
  assert.equal((await post("/api/group", { name: 'Q3: "big" #1' })).status, 200);
  assert.equal((await post("/api/ticket-group", { key: "CLD-8", group: 'Q3: "big" #1' })).status, 200);
  assert.equal(overview(vault).tickets.find((t) => t.key === "CLD-8")!.group, 'Q3: "big" #1');
  await post("/api/group/delete", { name: 'Q3: "big" #1' });
  assert.equal(overview(vault).tickets.find((t) => t.key === "CLD-8")!.group, "CLD");

  const rel = `${findTicket(vault, "CLD-8")!.rel}/notes.md`;
  assert.equal((await post("/api/frontmatter", { path: rel, updates: { group: "X" } })).status, 400);
  assert.equal((await post("/api/frontmatter", { path: rel, updates: { parent: "CLD-7" } })).status, 400);
});

test("parent: set, clear, self and cycles are refused, unknown parents are refused", async () => {
  assert.equal((await post("/api/ticket-parent", { key: "CLD-8", parent: "CLD-7" })).status, 200);
  assert.match(readNotes("CLD-8"), /^parent: CLD-7$/m);
  const row8 = overview(vault).tickets.find((t) => t.key === "CLD-8")!;
  assert.equal(row8.parent, "CLD-7");
  assert.equal(overview(vault).tickets.find((t) => t.key === "CLD-7")!.parent, null);

  assert.equal((await post("/api/ticket-parent", { key: "CLD-7", parent: "CLD-7" })).status, 400, "self");
  const cycle = await post("/api/ticket-parent", { key: "CLD-7", parent: "CLD-8" });
  assert.equal(cycle.status, 400);
  assert.match(((await cycle.json()) as { error: string }).error, /cycle/);
  assert.doesNotMatch(readNotes("CLD-7"), /^parent:/m, "nothing written on refusal");
  assert.equal((await post("/api/ticket-parent", { key: "CLD-8", parent: "CLD-99" })).status, 400, "unknown parent");
  assert.equal((await post("/api/ticket-parent", { key: "CLD-8", parent: 5 })).status, 400);

  // A longer chain: CLD-7 <- CLD-8 <- CLD-9, then CLD-7 under CLD-9 is a cycle too.
  await importIssues(cloudIssue("CLD-9"));
  assert.equal((await post("/api/ticket-parent", { key: "CLD-9", parent: "CLD-8" })).status, 200);
  assert.equal((await post("/api/ticket-parent", { key: "CLD-7", parent: "CLD-9" })).status, 400);

  // Clearing, and notes.md keeps its other frontmatter and body.
  assert.equal((await post("/api/ticket-parent", { key: "CLD-8", parent: null })).status, 200);
  assert.doesNotMatch(readNotes("CLD-8"), /^parent:/m);
  assert.match(readNotes("CLD-8"), /^status: /m);
  assert.equal(overview(vault).tickets.find((t) => t.key === "CLD-8")!.parent, null);
});

test("+ File: new Markdown file in the ticket folder; sync-owned names and notes.md are refused", async () => {
  const ok = await post("/api/ticket-file", { key: "CLD-7", name: "note-2026-10-02.md" });
  assert.equal(ok.status, 200);
  const { path: rel } = (await ok.json()) as { path: string };
  assert.ok(rel.endsWith("/note-2026-10-02.md"));
  assert.ok(ticketView(vault, "CLD-7").files.includes("note-2026-10-02.md"));
  assert.equal(fileView(vault, rel).editable, true);
  for (const name of ["ticket.md", "ticket", "raw", "attachments", "notes.md", "notes", "NOTES.md"]) {
    assert.equal((await post("/api/ticket-file", { key: "CLD-7", name })).status, 400, name);
  }
  assert.equal((await post("/api/ticket-file", { key: "CLD-7", name: "note-2026-10-02" })).status, 400, "duplicate");
});

test("linked folders over HTTP: link validates, the ticket lists the files, linked-file renders them, unlink clears", async () => {
  const ext = path.join(tmp, "ext-docs");
  fs.mkdirSync(ext);
  fs.writeFileSync(path.join(ext, "plan.md"), "---\nowner: me\n---\n# Plan\n\n**bold**\n");
  assert.equal((await post("/api/link", { key: "CLD-7", path: ext }, {})).status, 403, "needs X-LocalFlow");
  assert.equal((await post("/api/link", { key: "CLD-7", path: path.join(tmp, "missing") })).status, 400);
  assert.equal(findTicket(vault, "CLD-7")!.notes.linked_folders, undefined, "a broken path is not persisted");

  const ok = await post("/api/link", { key: "CLD-7", path: ext });
  assert.deepEqual(await ok.json(), { key: "CLD-7", path: ext, added: true });
  const tv = (await (await fetch(`${base}/api/ticket/CLD-7`)).json()) as { linked: Array<{ name: string; files: Array<{ name: string; path: string }> }> };
  assert.equal(tv.linked[0].name, "ext-docs");
  assert.deepEqual(tv.linked[0].files.map((f) => f.name), ["plan.md"]);

  const q = (key: string, file: string) => `${base}/api/linked-file?key=${key}&path=${encodeURIComponent(file)}`;
  const fv = await fetch(q("CLD-7", tv.linked[0].files[0].path));
  assert.equal(fv.status, 200);
  const view = (await fv.json()) as { editable: boolean; fm: Record<string, unknown>; blocks: Array<{ html: string }> };
  assert.equal(view.editable, false);
  assert.deepEqual(view.fm, { owner: "me" });
  assert.ok(view.blocks.some((b) => b.html.includes("<strong>bold</strong>")));
  assert.equal((await fetch(q("CLD-8", tv.linked[0].files[0].path))).status, 400, "only via the ticket it is linked to");
  assert.equal((await fetch(q("CLD-7", path.join(vault, "localflow.json")))).status, 400, "nothing outside linked folders");

  assert.equal((await post("/api/unlink", { key: "CLD-7", path: ext })).status, 200);
  assert.equal(findTicket(vault, "CLD-7")!.notes.linked_folders, undefined);
  assert.equal((await post("/api/unlink", { key: "CLD-7", path: ext })).status, 400);
});

test("overview: canSync follows the transport", () => {
  assert.equal(overview(vault).canSync, true);
  const file = path.join(vault, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.transport = "import";
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(overview(vault).canSync, false);
  raw.jira.transport = "rest";
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(overview(vault).canSync, true);
});

test("POST /api/sync: 409 while one runs, one at a time, needs X-LocalFlow", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const calls: string[] = [];
  const held = await startServer(vault, {
    port: 0,
    syncRunner: async (_v, key) => {
      calls.push(key);
      started();
      await gate;
      return { key, result: "unchanged", events: [], warnings: [] };
    },
  });
  try {
    const heldBase = `http://127.0.0.1:${(held.address() as { port: number }).port}`;
    const send = (headers: Record<string, string> = { "x-localflow": "1" }) =>
      fetch(`${heldBase}/api/sync`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ key: "CLD-7" }) });
    assert.equal((await send({})).status, 403);
    const first = send();
    await running;
    const second = await send();
    assert.equal(second.status, 409);
    release();
    const done = await first;
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { key: "CLD-7", result: "unchanged", events: [], warnings: [] });
    assert.deepEqual(calls, ["CLD-7"]);
    // The gate is free again.
    assert.equal((await send()).status, 200);
  } finally {
    held.closeAllConnections();
    await new Promise<void>((r) => held.close(() => r()));
  }
});

test("POST /api/sync end to end against the fake Jira; local tickets and failing token commands are reported", async () => {
  const jira = new FakeJira();
  await jira.start();
  const dir = fs.mkdtempSync(path.join(tmp, "sync-"));
  const v = path.join(dir, "vault");
  cmdInit(v, { jiraUrl: jira.baseUrl, project: "DEMO", localPrefix: "WORK" });
  const file = path.join(v, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.tokenCommand = ["printf", "%s", TEST_TOKEN];
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  cmdCommit(v, "config");
  jira.issues.set("DEMO-1", makeIssue("DEMO-1", { summary: "First" }));
  await runSync(v, loadConfig(v), { keys: ["DEMO-1"] });
  cmdCreate(v, "WORK", "Local one", {});
  const srv = await startServer(v, { port: 0 });
  const b = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const sync = (key: string) =>
    fetch(`${b}/api/sync`, { method: "POST", headers: { "x-localflow": "1", "content-type": "application/json" }, body: JSON.stringify({ key }) });
  try {
    const same = await sync("DEMO-1");
    assert.equal(same.status, 200);
    assert.equal(((await same.json()) as { result: string }).result, "unchanged");

    jira.issues.get("DEMO-1")!.fields.summary = "First, renamed";
    jira.issues.get("DEMO-1")!.fields.updated = "2026-09-05T10:00:00.000+0000";
    const changed = await sync("DEMO-1");
    assert.equal(changed.status, 200);
    const body = (await changed.json()) as { result: string; events: string[] };
    assert.equal(body.result, "updated");
    assert.ok(body.events.length > 0);
    const ov = (await (await fetch(`${b}/api/overview`)).json()) as { tickets: Array<{ key: string; title: string; unread: number }> };
    assert.equal(ov.tickets.find((t) => t.key === "DEMO-1")!.title, "First, renamed");
    assert.ok(ov.tickets.find((t) => t.key === "DEMO-1")!.unread > 0, "sync does not mark the ticket seen");

    assert.equal((await sync("WORK-1")).status, 400, "local ticket");
    assert.equal((await sync("DEMO-99")).status, 400, "unknown ticket");

    // A failing token command is an ordinary error message; the token never shows up in it.
    raw.jira.tokenCommand = ["false"];
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const bad = await sync("DEMO-1");
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /Token command/);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    await jira.stop();
  }
});
