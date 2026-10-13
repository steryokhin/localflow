// Ticket structure: the notes.md stub, files created when work starts, shared repository notes.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCommit, cmdCreate, cmdInit, cmdStart } from "../src/commands.ts";
import { setFrontmatter, setStatus, ticketView } from "../src/serve/api.ts";
import { idleTickets } from "../src/render/loops.ts";
import { appendTicketLog } from "../src/vault/notes.ts";
import { setRepo } from "../src/vault/scaffold.ts";
import { findTicket, listTickets } from "../src/vault/store.ts";

let tmp: string;
let vault: string;
const dir = (key: string): string => findTicket(vault, key)!.dir;
const read = (key: string, name: string): string => fs.readFileSync(path.join(dir(key), name), "utf8");

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-scaffold-")));
  vault = path.join(tmp, "vault");
  console.log = () => {};
  cmdInit(vault, { localPrefix: "WORK" });
  cmdCreate(vault, "WORK", "First", {});
  cmdCreate(vault, "WORK", "Second", {});
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a new notes.md has Decisions and an append-only Log at the bottom", () => {
  assert.equal(read("WORK-001", "notes.md"), "---\nticket: WORK-001\nstatus: inbox\n---\n\n# WORK-001 — notes\n\n## Decisions\n\n## Log\n");
  appendTicketLog(findTicket(vault, "WORK-001")!, "2026-10-12 10:00", "first");
  appendTicketLog(findTicket(vault, "WORK-001")!, "2026-10-12 11:00", "second");
  assert.match(read("WORK-001", "notes.md"), /## Decisions\n\n## Log\n\n- 2026-10-12 10:00 — first\n- 2026-10-12 11:00 — second\n$/);
});

test("lf start tracks the ticket and creates ai-summary.md and actions.md once", () => {
  cmdStart(vault, "WORK-001");
  assert.match(read("WORK-001", "notes.md"), /^tracked: true$/m);
  assert.match(read("WORK-001", "ai-summary.md"), /^ticket: WORK-001$/m);
  assert.match(read("WORK-001", "ai-summary.md"), /## Open questions/);
  assert.match(read("WORK-001", "actions.md"), /# WORK-001 — plan/);
  // No loop yet: the ticket shows up as idle on the board.
  assert.deepEqual(idleTickets(listTickets(vault), []).map((t) => t.key), ["WORK-001"]);

  fs.writeFileSync(path.join(dir("WORK-001"), "actions.md"), "mine\n");
  cmdStart(vault, "WORK-001");
  assert.equal(read("WORK-001", "actions.md"), "mine\n", "never overwritten");
});

test("a template in <vault>/templates replaces the built-in one; the web UI start does the same", () => {
  fs.mkdirSync(path.join(vault, "templates"));
  fs.writeFileSync(path.join(vault, "templates", "actions.md"), "# {{key}} plan from {{date}}\n");
  setStatus(vault, "WORK-002", "inprogress");
  assert.match(read("WORK-002", "actions.md"), /^# WORK-002 plan from \d{4}-\d{2}-\d{2}\n$/);
  assert.ok(fs.existsSync(path.join(dir("WORK-002"), "ai-summary.md")));
  assert.match(read("WORK-002", "notes.md"), /^tracked: true$/m);
  assert.throws(() => setFrontmatter(vault, `${findTicket(vault, "WORK-002")!.rel}/notes.md`, { tracked: "false" }), /lf untrack/);
});

test("a ticket's actions.md is committed: the root-anchored ignores do not hide it", () => {
  cmdCommit(vault, "test");
  const tracked = execFileSync("git", ["ls-files"], { cwd: vault, encoding: "utf8" });
  assert.match(tracked, /WORK-001-first\/actions\.md/);
  fs.writeFileSync(path.join(vault, "ACTIONS.md"), "generated\n");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: vault, encoding: "utf8" }), "");
});

test("repo notes are shared per repository and linked with repo: in notes.md", () => {
  const r = setRepo(vault, findTicket(vault, "WORK-001")!, "experience-api-home");
  assert.deepEqual(r, { name: "experience-api-home", rel: "notes/repos/experience-api-home.md", created: true });
  assert.match(fs.readFileSync(path.join(vault, r.rel), "utf8"), /^# experience-api-home$/m);
  fs.appendFileSync(path.join(vault, r.rel), "- needs Java 21\n");
  assert.equal(setRepo(vault, findTicket(vault, "WORK-002")!, "experience-api-home").created, false);
  assert.match(fs.readFileSync(path.join(vault, r.rel), "utf8"), /needs Java 21/, "the second ticket reuses it");
  assert.deepEqual(ticketView(vault, "WORK-002").repo, { name: "experience-api-home", rel: "notes/repos/experience-api-home.md", exists: true });
  assert.throws(() => setRepo(vault, findTicket(vault, "WORK-001")!, "../etc"), /Not a repository name/);
  assert.equal(ticketView(vault, "WORK-001").repo!.name, "experience-api-home");
});
