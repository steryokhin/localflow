// Jira Cloud over REST: v3 endpoints, token-paginated search, field names from /field, Basic auth.
// Cloud answers 410 to the v2 search this used to rely on.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCommit, cmdInit } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { runSync } from "../src/sync/run.ts";
import { findTicket } from "../src/vault/store.ts";
import { FakeJira, TEST_TOKEN, makeIssue } from "./fake-jira.ts";

let jira: FakeJira;
let tmp: string;
let vault: string;
let config: Config;

before(async () => {
  jira = new FakeJira();
  jira.cloud = true;
  await jira.start();
  for (let i = 1; i <= 3; i++) jira.issues.set(`CLD-${i}`, makeIssue(`CLD-${i}`));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localflow-cloud-"));
  vault = path.join(tmp, "vault");
  console.log = () => {};
  cmdInit(vault, { jiraUrl: jira.baseUrl, project: "CLD", localPrefix: "WORK", cloud: true });
  const file = path.join(vault, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.tokenCommand = ["printf", "%s", TEST_TOKEN];
  raw.jira.email = "me@example.com";
  raw.projects.CLD.defaultPreset = "open";
  raw.projects.CLD.presets = { open: "project = CLD AND resolution = Unresolved" };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  cmdCommit(vault, "config: test setup");
  config = loadConfig(vault);
});

after(() => {
  jira.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cloud sync uses /rest/api/3/search/jql with token pagination and never the removed v2 search", async () => {
  const report = await runSync(vault, config);
  assert.deepEqual(report.actions.map((a) => a.kind), ["create", "create", "create"]);
  const urls = jira.requests.map((r) => r.url);
  assert.ok(urls.includes("/rest/api/3/myself"));
  assert.ok(urls.includes("/rest/api/3/search/jql"));
  assert.ok(urls.includes("/rest/api/3/field"));
  assert.ok(!urls.some((u) => u.startsWith("/rest/api/2/")));
  // Field names came from /field, not from expand=names.
  assert.match(fs.readFileSync(path.join(findTicket(vault, "CLD-1")!.dir, "ticket.md"), "utf8"), /^title: Summary of CLD-1$/m);
});

test("pagination follows nextPageToken across pages", async () => {
  jira.requests.length = 0;
  for (let i = 4; i <= 7; i++) jira.issues.set(`CLD-${i}`, makeIssue(`CLD-${i}`));
  // The fake pages by maxResults; a tiny page size forces several round trips.
  const { searchIssues } = await import("../src/jira/api.ts");
  const { JiraClient } = await import("../src/jira/client.ts");
  const client = new JiraClient(jira.baseUrl, { kind: "basic", token: TEST_TOKEN, email: "me@example.com" }, "test");
  const res = await searchIssues(client, "project = CLD AND resolution = Unresolved", "cloud", 3);
  assert.equal(res.issues.length, 7);
  assert.equal(jira.requests.filter((r) => r.url === "/rest/api/3/search/jql").length, 3);
});

test("refresh by key falls back to /rest/api/3/issue when a key is gone", async () => {
  jira.issues.delete("CLD-2");
  const report = await runSync(vault, config, { keys: ["CLD-1", "CLD-2"] });
  assert.deepEqual(report.warnings, ["CLD-2: not found in Jira"]);
  assert.ok(jira.requests.some((r) => r.url === "/rest/api/3/issue/CLD-1"));
});
