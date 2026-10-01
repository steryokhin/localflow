// End-to-end: a real vault in a temp folder, real git, a fake Jira on loopback.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCommit, cmdCreate, cmdInit, cmdNote, cmdSeen, cmdStart } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { renderReport } from "../src/report.ts";
import { runSync } from "../src/sync/run.ts";
import { loadState, unreadByTicket } from "../src/vault/state.ts";
import { findTicket, listTickets } from "../src/vault/store.ts";
import { FakeJira, TEST_TOKEN, makeComment, makeIssue } from "./fake-jira.ts";

const JQL = "project = DEMO AND resolution = Unresolved ORDER BY updated DESC";
let jira: FakeJira;
let tmp: string;
let vault: string;
let config: Config;

const gitOut = (...args: string[]): string => execFileSync("git", args, { cwd: vault, encoding: "utf8" }).trim();
const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), "utf8");
const unread = () => unreadByTicket(vault, loadState(vault));

before(async () => {
  jira = new FakeJira();
  await jira.start();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localflow-e2e-"));
  vault = path.join(tmp, "vault");

  console.log = () => {}; // commands print progress; keep test output clean
  cmdInit(vault, { jiraUrl: jira.baseUrl, project: "DEMO", localPrefix: "WORK" });
  const file = path.join(vault, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.tokenCommand = ["printf", "%s", TEST_TOKEN];
  raw.projects.DEMO.defaultPreset = "open";
  raw.projects.DEMO.presets = { open: JQL };
  raw.projects.DEMO.fields = {
    acceptanceCriteria: "customfield_100",
    stepsToReproduce: "customfield_101",
    storyPoints: "customfield_102",
    sprint: "customfield_103",
    epicLink: "customfield_104",
  };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  cmdCommit(vault, "config: test setup");
  config = loadConfig(vault);

  jira.issues.set(
    "DEMO-1",
    makeIssue("DEMO-1", {
      summary: "Swipe approval does not work",
      description: "h2. Problem\nSwipe *fails*.\n!Screen Shot.png|thumbnail!\n# open list\n# swipe",
      customfield_100: "* approve works",
      customfield_200: { value: "Mobile" },
      environment: "iOS 26",
    }),
  );
  jira.addAttachment("DEMO-1", 501, "Screen Shot.png", "PNG-BYTES-1");
  jira.issues.set("DEMO-2", makeIssue("DEMO-2", { summary: "Second ticket", assignee: null }));
});

after(async () => {
  await jira.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("first sync creates ticket folders, attachments and one commit", async () => {
  const report = await runSync(vault, config);
  assert.deepEqual(report.actions.map((a) => [a.key, a.kind]), [["DEMO-1", "create"], ["DEMO-2", "create"]]);
  assert.ok(report.commit);

  const t = findTicket(vault, "DEMO-1")!;
  assert.equal(t.rel, "projects/DEMO/DEMO-1-swipe-approval-does-not-work");
  assert.equal(read(`${t.rel}/attachments/Screen-Shot.png`), "PNG-BYTES-1");
  const ticket = read(`${t.rel}/ticket.md`);
  assert.match(ticket, /^id: DEMO-1$/m);
  assert.match(ticket, /^mine: true$/m);
  assert.match(ticket, /#### Problem/);
  assert.match(ticket, /Swipe \*\*fails\*\*\./);
  assert.match(ticket, /!\[\]\(attachments\/Screen-Shot\.png\)/);
  assert.match(ticket, /^1\. open list$/m);
  assert.match(ticket, /## Acceptance Criteria\n\n- approve works/);
  assert.match(ticket, /- \*\*Team:\*\* Mobile/);
  assert.match(ticket, /- \*\*Environment:\*\* iOS 26/);
  assert.doesNotMatch(ticket, /Rank|votes|watch/i);
  assert.match(read(`${t.rel}/notes.md`), /^status: inbox$/m);
  assert.match(read("projects/DEMO/DEMO-2-second-ticket/ticket.md"), /^mine: false$/m);
  assert.ok(JSON.parse(read(`${t.rel}/raw/issue.json`)).fields.description.startsWith("h2. Problem"));

  assert.equal(gitOut("status", "--porcelain"), "");
  assert.deepEqual([...unread().keys()], ["DEMO-1", "DEMO-2"]);
});

test("second sync without changes writes nothing", async () => {
  const before = gitOut("rev-parse", "HEAD");
  const report = await runSync(vault, config);
  assert.ok(report.actions.every((a) => a.kind === "skip"));
  assert.equal(report.commit, null);
  assert.equal(gitOut("rev-parse", "HEAD"), before);
  assert.equal(gitOut("status", "--porcelain"), "");
});

test("seen clears the unread list", () => {
  cmdSeen(vault, [], true);
  assert.equal(unread().size, 0);
});

test("Jira changes are summarized, committed, and never touch user notes", async () => {
  const rel = "projects/DEMO/DEMO-1-swipe-approval-does-not-work";
  cmdStart(vault, "DEMO-1");
  cmdNote(vault, "DEMO-1", "scratchpad");
  const myNotes = read(`${rel}/notes.md`) + "My private analysis.\n";
  fs.writeFileSync(path.join(vault, rel, "notes.md"), myNotes);

  const issue = jira.issues.get("DEMO-1")!;
  issue.fields.status = { name: "In Progress", statusCategory: { name: "In Progress", key: "indeterminate" } };
  issue.fields.description += "\nMore details.";
  issue.fields.comment.comments.push(makeComment(9001, "Olga Reporter", "Still reproducible, see [^crash.log]"));
  issue.fields.comment.total = 1;
  issue.fields.updated = "2026-09-03T08:00:00.000+0000";
  jira.addAttachment("DEMO-1", 502, "crash.log", "stack trace");

  const report = await runSync(vault, config);
  const action = report.actions.find((a) => a.key === "DEMO-1")!;
  assert.equal(action.kind, "update");
  assert.deepEqual(action.events, [
    "status Open → In Progress",
    "description changed",
    "new comment by Olga Reporter",
    "+1 attachment",
  ]);
  assert.equal(report.actions.find((a) => a.key === "DEMO-2")!.kind, "skip");

  assert.equal(read(`${rel}/notes.md`), myNotes);
  const committed = gitOut("show", "--name-only", "--format=", "HEAD").split("\n");
  assert.ok(committed.includes(`${rel}/ticket.md`));
  assert.ok(committed.includes(`${rel}/attachments/crash.log`));
  assert.ok(!committed.some((f) => f.endsWith("notes.md") || f.endsWith("scratchpad.md")));
  assert.match(gitOut("log", "-1", "--format=%B"), /DEMO-1: status Open → In Progress; description changed/);
  assert.match(read(`${rel}/ticket.md`), /\[crash\.log\]\(attachments\/crash\.log\)/);

  assert.deepEqual([...unread().keys()], ["DEMO-1"]);
  assert.equal(findTicket(vault, "DEMO-1")!.status, "inprogress");
  assert.match(read("INBOX.md"), /## Unread \(1\)/);
});

test("a ticket that left the query is still refreshed (closed in Jira)", async () => {
  const issue = jira.issues.get("DEMO-2")!;
  issue.fields.status = { name: "Closed", statusCategory: { name: "Done", key: "done" } };
  issue.fields.resolution = { name: "Fixed" };
  issue.fields.updated = "2026-09-04T08:00:00.000+0000";

  const report = await runSync(vault, config);
  const action = report.actions.find((a) => a.key === "DEMO-2")!;
  assert.equal(action.kind, "update");
  assert.deepEqual(action.events, ["status Open → Closed", "resolution none → Fixed"]);
  // The local status is the user's own and is not moved by the sync.
  assert.equal(findTicket(vault, "DEMO-2")!.status, "inbox");
});

test("an attachment removed in Jira is removed locally", async () => {
  const issue = jira.issues.get("DEMO-1")!;
  issue.fields.attachment = issue.fields.attachment.filter((a: any) => a.id !== "502");
  issue.fields.updated = "2026-09-05T08:00:00.000+0000";
  const report = await runSync(vault, config);
  assert.deepEqual(report.actions.find((a) => a.key === "DEMO-1")!.events, ["-1 attachment"]);
  assert.ok(!fs.existsSync(path.join(vault, "projects/DEMO/DEMO-1-swipe-approval-does-not-work/attachments/crash.log")));
});

test("local tickets get sequential keys and are ignored by the sync", async () => {
  cmdCreate(vault, "WORK", "Write the onboarding doc", {});
  cmdCreate(vault, "WORK", "Second local task", {});
  const keys = listTickets(vault).filter((t) => t.source === "local").map((t) => t.key);
  assert.deepEqual(keys, ["WORK-001", "WORK-002"]);
  assert.throws(() => cmdCreate(vault, "DEMO", "nope", {}), /Jira project/);
  const report = await runSync(vault, config);
  assert.ok(report.actions.every((a) => a.key.startsWith("DEMO-")));
});

test("dry run reports without writing", async () => {
  jira.issues.set("DEMO-3", makeIssue("DEMO-3", { summary: "Third" }));
  const before = gitOut("rev-parse", "HEAD");
  const report = await runSync(vault, config, { dryRun: true });
  assert.equal(report.actions.find((a) => a.key === "DEMO-3")!.kind, "create");
  assert.equal(findTicket(vault, "DEMO-3"), null);
  assert.equal(gitOut("rev-parse", "HEAD"), before);
  jira.issues.delete("DEMO-3");
});

test("daily report is built from git history and the session log", () => {
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(vault, ".localflow"), { recursive: true });
  fs.appendFileSync(
    path.join(vault, ".localflow", "sessions.jsonl"),
    JSON.stringify({ ts: `${date}T10:15:00`, cwd: "/Users/x/work/app", reason: "clear", messages: 12, prompt: "fix swipe" }) + "\n",
  );
  cmdCommit(vault, "notes: test");
  const report = renderReport(vault, date);
  assert.match(report, /## From Jira \(2\)/);
  assert.match(report, /- \*\*DEMO-1\*\* Swipe approval does not work\n(    - .*\n)*    - \d\d:\d\d status Open → In Progress; description changed/);
  assert.match(report, /## My work \(\d\)\n\n- \*\*DEMO-1\*\* .* — status inbox → inprogress; edited notes\.md, scratchpad\.md/);
  assert.match(report, /## In progress now \(1\)\n\n- \*\*DEMO-1\*\*/);
  assert.match(report, /## Claude Code sessions \(1\)\n\n- 10:15 · `~\/work\/app` · clear · msgs: 12 · fix swipe/);
  assert.match(renderReport(vault, "2020-01-01"), /_No changes came from Jira._/);
});

test("sync refuses to run when the vault has a git remote", async () => {
  gitOut("remote", "add", "origin", "https://example.invalid/repo.git");
  await assert.rejects(runSync(vault, config), /refuses to work/);
  gitOut("remote", "remove", "origin");
});

test("only GET requests ever reached Jira", () => {
  assert.ok(jira.requests.length > 0);
  assert.deepEqual([...new Set(jira.requests.map((r) => r.method))], ["GET"]);
});
