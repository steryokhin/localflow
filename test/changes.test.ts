// "What exactly changed": fields was → now, comments with author and text, attachments and text
// blocks, from the vault history — in INBOX.md, `lf inbox`, `lf diff` and the web UI views.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCommit, cmdDiff, cmdInbox, cmdInit, cmdSeen } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { overview, ticketView } from "../src/serve/api.ts";
import { changeLine, plainText, resolveSince, ticketChanges } from "../src/sync/changes.ts";
import { runSync } from "../src/sync/run.ts";
import { loadState } from "../src/vault/state.ts";
import { findTicket } from "../src/vault/store.ts";
import { FakeJira, TEST_TOKEN, makeComment, makeIssue } from "./fake-jira.ts";

let jira: FakeJira;
let tmp: string;
let vault: string;
let config: Config;
const printed: string[] = [];

before(async () => {
  jira = new FakeJira();
  await jira.start();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-changes-")));
  vault = path.join(tmp, "vault");
  console.log = (line = "") => void printed.push(String(line));
  cmdInit(vault, { jiraUrl: jira.baseUrl, project: "DEMO", localPrefix: "WORK" });
  const file = path.join(vault, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.tokenCommand = ["printf", "%s", TEST_TOKEN];
  raw.projects.DEMO.presets = { mine: "project = DEMO AND resolution = Unresolved" };
  raw.projects.DEMO.fields = { acceptanceCriteria: "customfield_100" };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  cmdCommit(vault, "config");
  config = loadConfig(vault);
  jira.issues.set("DEMO-1", makeIssue("DEMO-1", {
    summary: "Swipe approval does not work",
    description: "Swipe fails.\n\nSecond paragraph stays.",
    customfield_100: "* approve works",
    customfield_200: { value: "Mobile" },
    comment: { comments: [makeComment(1, "Olga Reporter", "First look.")], total: 1 },
  }));
  await runSync(vault, config);
  cmdSeen(vault, ["DEMO-1"], false);

  const issue = jira.issues.get("DEMO-1")!;
  issue.fields.status = { name: "In Review", statusCategory: { name: "In Progress", key: "indeterminate" } };
  issue.fields.labels = ["ios", "swipe"];
  issue.fields.description = "Swipe fails on iOS 26 only.\n\nSecond paragraph stays.";
  issue.fields.customfield_200 = { value: "Platform" };
  issue.fields.comment.comments[0].body = "First look, edited.";
  issue.fields.comment.comments[0].updated = "2026-09-03T08:30:00.000+0000";
  issue.fields.comment.comments.push(makeComment(2, "Tom Reviewer", "*Approved* — but please split the [PR|https://example.invalid/pr/41] into two parts so the review is easier to follow for everyone.", "2026-09-03T09:05:00.000+0000"));
  issue.fields.comment.total = 2;
  issue.fields.updated = "2026-09-03T09:05:00.000+0000";
  jira.addAttachment("DEMO-1", 700, "crash.log", "trace");
  await runSync(vault, config);
});

after(async () => {
  await jira.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("changes since the seen mark: fields, comments with author and text, attachments", () => {
  const t = findTicket(vault, "DEMO-1")!;
  const c = ticketChanges(vault, t, loadState(vault).seen["DEMO-1"], { text: true });
  const lines = c.items.map((x) => x.text);
  assert.deepEqual(lines.slice(0, 3), ["status: Open → In Review", "labels: ios → ios, swipe", "description changed"]);
  assert.ok(lines.includes("Olga Reporter edited a comment: «First look, edited.»"));
  const tom = c.items.find((x) => x.who === "Tom Reviewer")!;
  assert.equal(tom.body, "Approved — but please split the PR into two parts so the review is easier to follow for everyone.");
  assert.match(tom.text, /^Tom Reviewer commented: «Approved — but please split the PR into two parts so the review is easier to fo…»$/);
  assert.ok(lines.includes("+ attachment crash.log"));
  assert.ok(lines.includes("Team: Mobile → Platform"));
  assert.match(changeLine(tom), /^03\.09 \d\d:05 · Tom Reviewer commented/);

  assert.deepEqual(c.blocks.map((b) => [b.section, b.state]), [["Description", "changed"]]);
  assert.equal(c.blocks[0].was, "Swipe fails.");
  assert.equal(c.blocks[0].now, "Swipe fails on iOS 26 only.");
});

test("INBOX.md and lf inbox show up to three change lines per ticket, not just that it changed", () => {
  const inbox = fs.readFileSync(path.join(vault, "INBOX.md"), "utf8");
  assert.match(inbox, /- \[DEMO-1\]\([^)]+\) — Swipe approval does not work\n    - status: Open → In Review\n    - labels: ios → ios, swipe\n    - description changed\n    - … \d+ more\n/);
  printed.length = 0;
  cmdInbox(vault);
  assert.equal(printed[0], "DEMO-1  Swipe approval does not work");
  assert.equal(printed[1], "    status: Open → In Review");
});

test("lf diff prints fields, full comments, attachments and the changed text", () => {
  printed.length = 0;
  cmdDiff(vault, "DEMO-1", {});
  const text = printed.join("\n");
  assert.match(text, /^DEMO-1  Swipe approval does not work\nChanges since you last marked it seen:\n\nFields\n  status: Open → In Review\n/);
  assert.match(text, /Comments\n  .* Olga Reporter \(edited\):\n      First look, edited\.\n  .* Tom Reviewer:\n      Approved — but please split/);
  assert.match(text, /Attachments\n  \d\d\.09 \d\d:\d\d · \+ attachment crash\.log/);
  assert.match(text, /Description\n  - Swipe fails\.\n  \+ Swipe fails on iOS 26 only\./);
  assert.doesNotMatch(text, /Second paragraph/);
});

test("lf diff --since takes a date or a commit; before the first sync everything is new", () => {
  assert.equal(resolveSince(vault, "2000-01-01"), null);
  printed.length = 0;
  cmdDiff(vault, "DEMO-1", { since: "2000-01-01" });
  assert.match(printed.join("\n"), /Fields\n  .*new ticket — Swipe approval does not work/);
  const head = resolveSince(vault, "HEAD")!;
  printed.length = 0;
  cmdDiff(vault, "DEMO-1", { since: head });
  assert.match(printed.join("\n"), /Changes since [0-9a-f]+:\n  nothing/);
  assert.throws(() => resolveSince(vault, "no-such-ref"), /Not a commit or a date/);
});

test("the web UI gets the changes for the open ticket and a one-line summary in the list", () => {
  const view = ticketView(vault, "DEMO-1");
  assert.equal(view.changes[0].text, "status: Open → In Review");
  const row = overview(vault).tickets.find((r) => r.key === "DEMO-1")!;
  assert.match(row.change!, /^status: Open → In Review · \+\d+ more$/);
  cmdSeen(vault, ["DEMO-1"], false);
  assert.deepEqual(ticketView(vault, "DEMO-1").changes, []);
  assert.equal(overview(vault).tickets.find((r) => r.key === "DEMO-1")!.change, null);
});

test("plainText flattens wiki and Markdown to one line", () => {
  assert.equal(plainText("h3. Title\n* one\n* two [link|https://x.invalid]", "wiki"), "Title one two link");
  assert.equal(plainText("**bold** and `code`\n\n![](a.png)", "markdown"), "bold and code [image]");
});
