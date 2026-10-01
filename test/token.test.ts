// jira.tokenCommand: the token comes from a command's stdout (a password manager), never a file.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdInit } from "../src/commands.ts";
import { loadConfig, readToken, tokenSource } from "../src/config.ts";
import type { Config } from "../src/config.ts";

let tmp: string;
let config: Config;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localflow-token-"));
  console.log = () => {};
  cmdInit(tmp, { jiraUrl: "https://example.atlassian.net", project: "CLD", cloud: true });
  config = loadConfig(tmp);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function withCommand(argv: string[]): Config {
  return { ...config, jira: { ...config.jira, tokenCommand: argv } };
}

test("token is the trimmed stdout of the command", () => {
  const c = withCommand(["sh", "-c", "printf '  secret-123\\n'"]);
  assert.equal(readToken(c), "secret-123");
  assert.equal(tokenSource(c), "command: sh -c printf '  secret-123\\n'");
});

test("the command is run as argv, not through a shell", () => {
  // A shell would expand the variable; argv keeps it literal and the file is absent.
  const c = withCommand(["printf", "%s", "$HOME"]);
  assert.equal(readToken(c), "$HOME");
});

test("failures are reported without the token value", () => {
  assert.throws(() => readToken(withCommand(["sh", "-c", "echo oops >&2; exit 3"])), /exited with status 3/);
  assert.throws(() => readToken(withCommand(["sh", "-c", "exit 0"])), /printed nothing/);
  assert.throws(() => readToken(withCommand(["no-such-binary-xyz"])), /not found/);
  assert.throws(() => readToken(withCommand([])), /non-empty array/);
  assert.throws(() => readToken({ ...config, jira: { ...config.jira, tokenCommand: undefined } }), /No "jira.tokenCommand"/);
});

test("a legacy tokenFile in the config is refused", () => {
  const file = path.join(tmp, "localflow.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.jira.tokenFile = "~/.config/localflow/jira-token";
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => loadConfig(tmp), /no longer supported/);
});
