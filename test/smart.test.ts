// Smart groups: activity in my and tracked tickets, mine, tracking, waiting on people.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCommit, cmdCreate, cmdInbox, cmdInit, cmdLog, cmdSeen, cmdTrack } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import { fileView, overview, saveFile } from "../src/serve/api.ts";
import { runSync } from "../src/sync/run.ts";
import { addLoop } from "../src/vault/loops.ts";
import { findTicket } from "../src/vault/store.ts";
import { FakeJira, TEST_TOKEN, makeComment, makeIssue } from "./fake-jira.ts";

let jira: FakeJira;
let tmp: string;
let vault: string;
const printed: string[] = [];
const inbox = (): string => fs.readFileSync(path.join(vault, "INBOX.md"), "utf8");
const run = (fn: () => void): string => {
  printed.length = 0;
  fn();
  return printed.join("\n");
};

before(async () => {
  jira = new FakeJira();
  await jira.start();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-smart-")));
  vault = path.join(tmp, "vault");
  console.log = (line = "") => void printed.push(String(line));
  cmdInit(vault, { jiraUrl: jira.baseUrl, project: "DEMO", localPrefix: "WORK" });
  const file = path.join(vault, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.tokenCommand = ["printf", "%s", TEST_TOKEN];
  raw.projects.DEMO.presets = { mine: "project = DEMO AND resolution = Unresolved" };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  cmdCommit(vault, "config");
  jira.issues.set("DEMO-1", makeIssue("DEMO-1", { summary: "Mine, gets a comment" }));
  jira.issues.set("DEMO-2", makeIssue("DEMO-2", { summary: "Someone else's, tracked", assignee: { displayName: "Anna Other", name: "anna" } }));
  jira.issues.set("DEMO-3", makeIssue("DEMO-3", { summary: "Someone else's, not followed", assignee: { displayName: "Anna Other", name: "anna" } }));
  const config = loadConfig(vault);
  await runSync(vault, config);
  cmdSeen(vault, [], true);
  cmdTrack(vault, "DEMO-2", true);
  for (const key of ["DEMO-1", "DEMO-2", "DEMO-3"]) {
    const issue = jira.issues.get(key)!;
    issue.fields.comment.comments.push(makeComment(Number(key.slice(5)) * 10, "Tom Reviewer", `Looked at ${key}.`, "2026-09-03T09:05:00.000+0000"));
    issue.fields.updated = "2026-09-03T09:05:00.000+0000";
  }
  await runSync(vault, config);
  addLoop(vault, { text: "PR #41 review", key: "DEMO-1", owner: "Tom", by: "+4h" }, new Date());
});

after(async () => {
  await jira.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("INBOX.md: activity in followed tickets first, then other unread, waiting, mine, tracking", () => {
  cmdInbox(vault);
  const text = inbox();
  const order = ["## Activity (2)", "## Other unread (1)", "## Waiting on people (1)", "## Mine (1)", "## Tracking (1)"].map((h) => text.indexOf(h));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), text);
  assert.match(text, /## Activity \(2\)\n\n- \[DEMO-1\]\([^)]+\) — Mine, gets a comment\n    - 03\.09 \d\d:05 · Tom Reviewer commented: «Looked at DEMO-1\.»\n- \[DEMO-2\]/);
  assert.match(text, /## Other unread \(1\)\n\n- \[DEMO-3\]/);
  assert.match(text, /## Waiting on people \(1\)\n\n- \[DEMO-1\]\([^)]+\) — Mine, gets a comment\n    - Tom: PR #41 review · by \d\d:\d\d|## Waiting on people \(1\)\n\n- \[DEMO-1\]\([^)]+\) — Mine, gets a comment\n    - Tom: PR #41 review · by \d+ \w+ \d\d:\d\d/);
  assert.match(text, /## Tracking \(1\)\n\n- \[DEMO-2\]/);
  assert.doesNotMatch(text.slice(text.indexOf("## Tracking")), /\[DEMO-1\]|\[DEMO-2\].*\n[\s\S]*\[DEMO-2\]/, "a followed ticket is not repeated in the rest");
  assert.match(text, /## Inbox \(1\)\n\n- \[DEMO-3\]/);
});

test("lf inbox --group lists one smart group", () => {
  assert.match(run(() => cmdInbox(vault, "activity")), /^● DEMO-1 {2}Mine, gets a comment {2}\[inbox\]\n {6}03\.09 \d\d:05 · Tom Reviewer commented[^\n]*\n {6}⏳ Tom: PR #41 review[^\n]*\n● DEMO-2/);
  assert.doesNotMatch(run(() => cmdInbox(vault, "activity")), /DEMO-3/);
  assert.match(run(() => cmdInbox(vault, "waiting")), /^● DEMO-1 .*\n.*\n {6}⏳ Tom: PR #41 review/);
  assert.equal(run(() => cmdInbox(vault, "tracking")).split("\n").filter((l) => /^[● ] DEMO-\d/.test(l)).length, 2, "DEMO-1 is tracked by its loop");
  assert.throws(() => cmdInbox(vault, "nope"), /Unknown group/);
  cmdSeen(vault, [], true);
  assert.equal(run(() => cmdInbox(vault, "activity")), 'Nothing in "activity".');
});

test("the web UI rows carry tracked and waiting; a first notes edit tracks, an explicit untrack sticks", () => {
  const rows = new Map(overview(vault).tickets.map((r) => [r.key, r]));
  assert.equal(rows.get("DEMO-2")!.tracked, true);
  assert.equal(rows.get("DEMO-3")!.tracked, false);
  assert.match(rows.get("DEMO-1")!.waiting[0], /^Tom: PR #41 review · by /);

  const rel = `${findTicket(vault, "DEMO-3")!.rel}/notes.md`;
  const v = fileView(vault, rel);
  saveFile(vault, rel, "my thoughts", v.head);
  assert.match(fs.readFileSync(path.join(vault, rel), "utf8"), /^tracked: true$/m);

  cmdCreate(vault, "WORK", "Local", {});
  cmdTrack(vault, "WORK-001", false);
  const localRel = `${findTicket(vault, "WORK-001")!.rel}/notes.md`;
  saveFile(vault, localRel, "text", fileView(vault, localRel).head);
  cmdLog(vault, "WORK-001", "did a thing");
  assert.match(fs.readFileSync(path.join(vault, localRel), "utf8"), /^tracked: false$/m);
});
