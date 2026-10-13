// Smart folders over the whole vault, the two statuses (Jira's and mine) with align, loops in the
// web UI API, and `lf done --next`.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdAlign, cmdCommit, cmdCreate, cmdDone, cmdInit, cmdLs, cmdTrack } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import { overview, setTicketGroup, ticketView } from "../src/serve/api.ts";
import { startServer } from "../src/serve/server.ts";
import { runSync } from "../src/sync/run.ts";
import { addLoop, readLoops } from "../src/vault/loops.ts";
import { parseSmartFilter, smartFolders } from "../src/vault/smart.ts";
import { findTicket } from "../src/vault/store.ts";
import { FakeJira, TEST_TOKEN, makeIssue } from "./fake-jira.ts";

let jira: FakeJira;
let tmp: string;
let vault: string;
let server: http.Server;
let base: string;
const printed: string[] = [];
const run = async (fn: () => unknown): Promise<string> => {
  printed.length = 0;
  await fn();
  return printed.join("\n");
};
const notes = (key: string): string => fs.readFileSync(path.join(findTicket(vault, key)!.dir, "notes.md"), "utf8");
const folder = (id: string): string[] => overview(vault).smartFolders.find((f) => f.id === id)!.keys;
const post = async (p: string, body: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}${p}`, { method: "POST", headers: { "x-localflow": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

before(async () => {
  jira = new FakeJira();
  await jira.start();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-statuses-")));
  vault = path.join(tmp, "vault");
  console.log = (line = "") => void printed.push(String(line));
  cmdInit(vault, { jiraUrl: jira.baseUrl, project: "DEMO", localPrefix: "WORK" });
  const file = path.join(vault, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.tokenCommand = ["printf", "%s", TEST_TOKEN];
  raw.projects.DEMO.presets = { mine: "project = DEMO AND resolution = Unresolved" };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  cmdCommit(vault, "config");
  jira.issues.set("DEMO-1", makeIssue("DEMO-1", { summary: "Mine, to do" }));
  jira.issues.set("DEMO-2", makeIssue("DEMO-2", { summary: "Mine, started in Jira" }));
  jira.issues.set("DEMO-3", makeIssue("DEMO-3", { summary: "Someone else's", assignee: { displayName: "Anna Other", name: "anna" } }));
  await runSync(vault, loadConfig(vault));
  // Jira moves on; the user's own status stays where it was.
  jira.issues.get("DEMO-2")!.fields.status = { name: "In Progress", statusCategory: { name: "In Progress", key: "indeterminate" } };
  jira.issues.get("DEMO-2")!.fields.updated = "2026-09-02T10:00:00.000+0000";
  await runSync(vault, loadConfig(vault));
  cmdCreate(vault, "WORK", "Local chore", {});
  server = await startServer(vault, { port: 0 });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await jira.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("smart filter: and / or / not, Jira category or status name, unknown terms refused", () => {
  const demo2 = findTicket(vault, "DEMO-2")!;
  const facts = { unread: false, loops: [] };
  assert.equal(parseSmartFilter("mine and jira:inprogress")(demo2, facts), true);
  assert.equal(parseSmartFilter("jira:in-progress and local:inbox")(demo2, facts), true);
  assert.equal(parseSmartFilter("not jira:done and not local:done")(demo2, facts), true);
  assert.equal(parseSmartFilter("unread or hasLoops")(demo2, facts), false);
  assert.equal(parseSmartFilter("local or project:demo")(demo2, facts), true);
  assert.throws(() => parseSmartFilter("mine and"), /ends with an operator/);
  assert.throws(() => parseSmartFilter("mine tracked"), /missing "and"/);
  assert.throws(() => parseSmartFilter("assignee:me"), /unknown term/);
});

test("config folders replace, hide or extend the built-ins; a broken filter matches nothing", () => {
  const f = smartFolders([
    { name: "My Jira", filter: "mine and jira" },
    { name: "No loops", filter: "", hidden: true },
    { name: "Demo open", icon: "D", filter: "project:DEMO and not local:done" },
    { name: "Broken", filter: "mine and and" },
  ]);
  assert.deepEqual(f.map((x) => x.id), ["activity", "my-jira", "tracking", "waiting", "demo-open", "broken"]);
  assert.equal(f[1].filter, "mine and jira");
  assert.match(f[5].error ?? "", /wrong place/);
  assert.equal(f[5].test(findTicket(vault, "DEMO-1")!, { unread: true, loops: [] }), false);
});

test("smart folders cover the whole vault whatever group a ticket is in", () => {
  fs.writeFileSync(path.join(vault, "groups.json"), JSON.stringify({ groups: ["Elsewhere"] }));
  setTicketGroup(vault, "DEMO-2", "Elsewhere");
  const o = overview(vault);
  assert.equal(o.tickets.find((t) => t.key === "DEMO-2")!.group, "Elsewhere");
  assert.deepEqual(folder("my-jira"), ["DEMO-1", "DEMO-2"], "local tickets and other people's are not in My Jira");
  const row = o.tickets.find((t) => t.key === "DEMO-2")!;
  assert.equal(row.status, "inbox");
  assert.equal(row.jiraLocal, "inprogress");
  assert.equal(row.mismatch, true);
  assert.equal(o.tickets.find((t) => t.key === "DEMO-1")!.mismatch, false);
  assert.equal(o.tickets.find((t) => t.key === "WORK-001")!.jiraLocal, null);
});

test("lf ls --by jira puts a ticket under Jira's status before any alignment", async () => {
  const byJira = await run(() => cmdLs(vault, { by: "jira", status: "inprogress" }));
  assert.match(byJira, /DEMO-2 .*≠ mine: inbox, Jira: inprogress/);
  const byMine = await run(() => cmdLs(vault, { status: "inprogress" }));
  assert.equal(byMine, "No tickets match.");
  assert.throws(() => cmdLs(vault, { by: "status" }), /--by is jira or local/);
});

test("lf align: --dry-run changes nothing, then Jira's status is copied into notes.md", async () => {
  assert.throws(() => cmdAlign(vault, [], {}), /Usage/);
  const dry = await run(() => cmdAlign(vault, [], { all: true, dryRun: true }));
  assert.match(dry, /would set DEMO-2: inbox → inprogress/);
  assert.match(notes("DEMO-2"), /^status: inbox$/m);
  assert.match(await run(() => cmdAlign(vault, ["DEMO-1"], {})), /Already aligned/);
  assert.match(await run(() => cmdAlign(vault, ["demo-2"], {})), /set DEMO-2: inbox → inprogress/);
  assert.match(notes("DEMO-2"), /^status: inprogress$/m);
  assert.equal(overview(vault).tickets.find((t) => t.key === "DEMO-2")!.mismatch, false);
  assert.match(await run(() => cmdAlign(vault, [], { all: true })), /Nothing to align/);
});

test("POST /api/align: dry run, then real; bad input is a 400", async () => {
  fs.writeFileSync(path.join(findTicket(vault, "DEMO-2")!.dir, "notes.md"), notes("DEMO-2").replace(/^status: inprogress$/m, "status: inreview"));
  const dry = await post("/api/align", { keys: ["DEMO-2"], dryRun: true });
  assert.deepEqual(dry.json.changes, [{ key: "DEMO-2", from: "inreview", to: "inprogress" }]);
  assert.match(notes("DEMO-2"), /^status: inreview$/m);
  assert.equal((await post("/api/align", { keys: "all" })).json.changes.length, 1);
  assert.match(notes("DEMO-2"), /^status: inprogress$/m);
  assert.equal((await post("/api/align", { keys: 3 })).status, 400);
});

test("lf done --next closes a loop and opens the next one on the same ticket in one call", async () => {
  const l = addLoop(vault, { text: "send the build to QA", key: "WORK-001", by: "+2h" }, new Date());
  await assert.rejects(cmdDone(vault, l.id, "sent", { text: "QA verdict", by: "someday" }), /Cannot read "someday"/);
  assert.ok(readLoops(vault).some((x) => x.id === l.id), "a bad --by leaves the first loop open");
  const outText = await run(() => cmdDone(vault, l.id, "sent to QA", { text: "QA verdict", by: "+1d", from: "Lena", else: "ping in #qa" }));
  assert.match(outText, new RegExp(`closed ${l.id}`));
  assert.match(outText, /waiting for Lena/);
  const next = readLoops(vault).find((x) => x.text === "QA verdict")!;
  assert.equal(next.key, "WORK-001");
  assert.equal(next.owner, "Lena");
  assert.equal(next.onExpiry, "ping in #qa");
  assert.match(notes("WORK-001"), new RegExp(`sent to QA \\(${l.id}: send the build to QA\\)`));
});

test("loops API: board, add, done with an explicit next or skip, bump; files match the CLI", async () => {
  cmdTrack(vault, "DEMO-1", true);
  const added = await post("/api/loop", { text: "PR #41 review", key: "DEMO-1", from: "Tom", by: "+4h", else: "ping in #ios" });
  assert.equal(added.status, 200);
  const id = added.json.id;
  assert.match(fs.readFileSync(path.join(vault, "loops.md"), "utf8"), new RegExp(`${id} · .* · DEMO-1 · PR #41 review · from Tom · by .* · else: ping in #ios`));
  const board = await (await fetch(`${base}/api/loops`)).json();
  const all = [...board.expired, ...board.today, ...board.mine, ...board.waiting];
  assert.equal(all.find((x: any) => x.id === id).title, "Mine, to do");
  assert.ok(fs.existsSync(path.join(vault, "ACTIONS.md")));
  assert.equal((await post("/api/loop", { key: "DEMO-1", by: "+1h" })).status, 400);

  const bumped = await post("/api/loop/bump", { id, by: "tomorrow" });
  assert.match(bumped.json.loop.due, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(notes("DEMO-1"), new RegExp(`${id} moved to`));

  assert.equal((await post("/api/loop/done", { id, outcome: "approved" })).status, 400, "next must be given or explicitly null");
  const done = await post("/api/loop/done", { id, outcome: "Tom approved", next: { text: "merge after CI", by: "+2h" } });
  assert.equal(done.json.closed.id, id);
  assert.equal(done.json.next.key, "DEMO-1", "the next loop inherits the ticket");
  assert.match(notes("DEMO-1"), new RegExp(`Tom approved \\(${id}: PR #41 review, from Tom\\)`));
  const view = ticketView(vault, "DEMO-1");
  assert.deepEqual(view.loops.map((l) => l.text), ["merge after CI"]);
  assert.ok(view.log.some((l) => l.text.includes("Tom approved")));

  const skipped = await post("/api/loop/done", { id: done.json.next.id, outcome: "merged", next: null });
  assert.equal(skipped.json.next, null);
  assert.equal(ticketView(vault, "DEMO-1").loops.length, 0);
  assert.deepEqual(folder("no-loops"), ["DEMO-1"], "tracked, no loops: a prompt for the next loop or untrack");
  assert.equal((await post("/api/loop/done", { id: "L999", outcome: "", next: null })).status, 400);
});

test("overview counts expired and due-today loops; GET /api/standup is the CLI text", async () => {
  const now = new Date();
  addLoop(vault, { text: "overdue thing", by: "2020-01-01" }, now);
  const o = overview(vault);
  assert.ok(o.loopCounts.expired >= 1);
  const day = await (await fetch(`${base}/api/standup`)).json();
  assert.match(day.text, /^Standup — /);
  assert.match(day.text, /Doing today:/);
  const week = await (await fetch(`${base}/api/standup?week=1`)).json();
  assert.match(week.text, /^Week — /);
});
