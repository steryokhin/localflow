// Jira Cloud shapes: issues fetched by an agent (Rovo-style JSON) and imported from a file.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCommit, cmdInit } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { adfToMarkdown } from "../src/jira/adf.ts";
import { runImport } from "../src/sync/import.ts";
import { findTicket } from "../src/vault/store.ts";

let tmp: string;
let vault: string;
let config: Config;

const cloudUser = (name: string, id: string) => ({ accountId: id, emailAddress: `${id}@example.com`, displayName: name });

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
      parent: { key: "CLD-1", fields: { summary: "Epic: swiping" } },
      attachment: [
        {
          id: "9001",
          filename: "shot.png",
          size: 1234,
          author: cloudUser("Olga Reporter", "acc-2"),
          created: "2026-09-10T10:05:00.000+0000",
          content: "https://example.atlassian.net/rest/api/3/attachment/content/9001",
        },
      ],
      comment: {
        comments: [
          {
            id: "c1",
            author: cloudUser("Olga Reporter", "acc-2"),
            created: "2026-09-11T09:00:00.000+0000",
            updated: "2026-09-11T09:00:00.000+0000",
            body: {
              type: "doc",
              version: 1,
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Still " }, { type: "text", text: "broken", marks: [{ type: "strong" }] }] },
                { type: "codeBlock", attrs: { language: "swift" }, content: [{ type: "text", text: "let x = 1" }] },
              ],
            },
          },
        ],
        total: 1,
      },
      customfield_10020: [{ id: 5, name: "Sprint 42", state: "active" }],
      customfield_10031: { value: "Mobile" },
      ...fields,
    },
  };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localflow-import-"));
  vault = path.join(tmp, "vault");
  console.log = () => {};
  cmdInit(vault, { jiraUrl: "https://example.atlassian.net", project: "CLD", cloud: true });
  const file = path.join(vault, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.me = "acc-1";
  raw.jira.fieldNames = { customfield_10031: "Team" };
  raw.projects.CLD.fields = { sprint: "customfield_10020" };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  cmdCommit(vault, "config");
  config = loadConfig(vault);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("ADF renders lists, marks, tables and media", () => {
  const md = adfToMarkdown(
    {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one", marks: [{ type: "em" }] }] }] },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "two" }] },
                { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }] },
              ],
            },
          ],
        },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] }, { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] }] },
            { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] }, { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x.test" } }] }] }] }] },
          ],
        },
        { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m1", alt: "shot.png" } }] },
        { type: "paragraph", content: [{ type: "mention", attrs: { text: "@Olga" } }, { type: "text", text: " look" }] },
      ],
    },
    { headingShift: 2, resolveAttachment: (n) => `attachments/${n}` },
  );
  assert.equal(
    md,
    "### Title\n\n- *one*\n- two\n    1. nested\n\n| A | B |\n| --- | --- |\n| 1 | [link](https://x.test) |\n\n![shot.png](attachments/shot.png)\n\n@Olga look",
  );
});

test("import renders Cloud issues with markdown text and ADF comments", async () => {
  const file = path.join(tmp, "issues.json");
  fs.writeFileSync(file, JSON.stringify({ issues: [cloudIssue("CLD-7"), cloudIssue("CLD-8", { assignee: null })], nextPageToken: null }));
  const report = await runImport(vault, config, [file]);
  assert.deepEqual(report.actions.map((a) => [a.key, a.kind]), [["CLD-7", "create"], ["CLD-8", "create"]]);
  assert.ok(report.commit);
  assert.deepEqual(report.warnings, []);

  const t = findTicket(vault, "CLD-7")!;
  const ticket = fs.readFileSync(path.join(t.dir, "ticket.md"), "utf8");
  assert.match(ticket, /^mine: true$/m);
  assert.match(ticket, /^sprint: Sprint 42$/m);
  assert.match(ticket, /^parent: CLD-1$/m);
  assert.match(ticket, /#### Problem\n\nSwipe \*\*fails\*\* on iOS\.\n\n- step one/);
  assert.match(ticket, /- \*\*Team:\*\* Mobile/);
  assert.match(ticket, /- shot\.png — Olga Reporter, 2026-09-10 10:05, 1\.2 KB _\(not downloaded: imported without Jira access\)_/);
  assert.match(ticket, /### Olga Reporter — 2026-09-11 09:00\n\nStill \*\*broken\*\*\n\n```swift\nlet x = 1\n```/);
  assert.match(fs.readFileSync(path.join(findTicket(vault, "CLD-8")!.dir, "ticket.md"), "utf8"), /^mine: false$/m);
});

test("re-import with changes is summarized like a sync", async () => {
  const issue = cloudIssue("CLD-7", {
    status: { name: "In Progress", statusCategory: { name: "In Progress", key: "indeterminate" } },
    description: "## Problem\n\nSwipe **fails** on iOS and iPadOS.",
    updated: "2026-09-12T10:00:00.000+0000",
  });
  const file = path.join(tmp, "one.json");
  fs.writeFileSync(file, JSON.stringify(issue));
  const report = await runImport(vault, config, [file]);
  assert.deepEqual(report.actions.find((a) => a.key === "CLD-7")!.events, ["status To Do → In Progress", "description changed"]);
  assert.equal(findTicket(vault, "CLD-7")!.status, "inbox");
});

test("malformed input is rejected before anything is written", async () => {
  const file = path.join(tmp, "bad.json");
  fs.writeFileSync(file, JSON.stringify({ hello: "world" }));
  await assert.rejects(runImport(vault, config, [file]), /expected an issue object/);
  fs.writeFileSync(file, "{not json");
  await assert.rejects(runImport(vault, config, [file]), /not valid JSON/);
});
