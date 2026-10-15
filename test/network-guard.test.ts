// Guards the "nothing leaves this machine" promise at the source level:
// network and process-spawning APIs may appear only in the modules listed here.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { JiraClient } from "../src/jira/client.ts";
import { FakeJira, TEST_TOKEN } from "./fake-jira.ts";

const SRC = path.join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

function filesMatching(re: RegExp): string[] {
  return sourceFiles(SRC)
    .filter((f) => re.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f))
    .sort();
}

test("fetch is used only by the Jira client", () => {
  assert.deepEqual(filesMatching(/\bfetch\s*\(/), ["jira/client.ts"]);
});

test("no other network APIs are imported anywhere in src", () => {
  // node:http is allowed only in the local web UI server (it binds loopback, see the next test).
  assert.deepEqual(filesMatching(/node:http\b/), ["serve/server.ts"]);
  const re = /node:(https|http2|net|tls|dgram|dns)\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon/;
  assert.deepEqual(filesMatching(re), []);
});

test("the web UI server listens on the loopback interface only", () => {
  const server = fs.readFileSync(path.join(SRC, "serve", "server.ts"), "utf8");
  assert.match(server, /LOOPBACK_HOST\s*=\s*"127\.0\.0\.1"/);
  const listens = server.match(/\.listen\([^)]*\)/g) ?? [];
  assert.equal(listens.length, 1);
  assert.match(listens[0], /\.listen\(port,\s*LOOPBACK_HOST\b/);
  // Nothing else in src may open a listening socket.
  assert.deepEqual(filesMatching(/\.listen\(/), ["serve/server.ts"]);
});

test("processes are spawned only for git, the editor, the token command and local notifications", () => {
  assert.deepEqual(filesMatching(/node:child_process/), ["notify.ts", "open.ts", "secret.ts", "vault/git.ts"]);
});

test("notifications run osascript only, without a shell", () => {
  const notify = fs.readFileSync(path.join(SRC, "notify.ts"), "utf8");
  const spawns = notify.match(/spawnSync\([^,]+/g) ?? [];
  assert.deepEqual(spawns, ['spawnSync("osascript"']);
  assert.doesNotMatch(notify, /shell\s*:\s*true|execSync|exec\(|\bsh\b/);
});

test("the token command runs without a shell; captured stderr is never shown", () => {
  const secret = fs.readFileSync(path.join(SRC, "secret.ts"), "utf8");
  assert.doesNotMatch(secret, /shell\s*:\s*true|execSync|exec\(/);
  // A terminal keeps stderr for the password prompt; without one, stderr is captured (not shown).
  assert.doesNotMatch(secret, /\.stderr\b(?!\.isTTY)/, "the password manager's stderr is never printed or put into an error");
  assert.match(secret, /interactive \? \(\["inherit", "pipe", "inherit"\] as const\) : \(\["inherit", "pipe", "pipe"\] as const\)/);
});

test("the Jira client contains no write methods", () => {
  const client = fs.readFileSync(path.join(SRC, "jira", "client.ts"), "utf8");
  assert.doesNotMatch(client, /["'`](POST|PUT|PATCH|DELETE)["'`]/);
});

let jira: FakeJira;
before(async () => {
  jira = new FakeJira();
  await jira.start();
});
after(() => jira.stop());

test("client refuses hosts other than the configured Jira", async () => {
  const client = new JiraClient(jira.baseUrl, { kind: "bearer", token: TEST_TOKEN }, "test");
  await assert.rejects(client.download("https://example.invalid/file.png"), /only .* is allowed/);
});

test("client refuses a redirect that leaves the Jira host", async () => {
  const client = new JiraClient(jira.baseUrl, { kind: "bearer", token: TEST_TOKEN }, "test");
  await assert.rejects(client.download(`${jira.baseUrl}/redirect-out`), /only .* is allowed/);
});

test("import transport refuses any non-loopback host outright", () => {
  assert.throws(
    () => new JiraClient("https://example.atlassian.net", { kind: "basic", token: "t", email: "e@x" }, "test", true),
    /opens no outbound connections/,
  );
  // Loopback stays allowed so the fake-Jira tests can exercise the same code path.
  new JiraClient(jira.baseUrl, { kind: "bearer", token: TEST_TOKEN }, "test", true);
});

test("client rejects a non-https base URL for non-loopback hosts", () => {
  assert.throws(() => new JiraClient("http://jira.example.com", { kind: "bearer", token: TEST_TOKEN }, "test"), /must be https/);
});

test("an extra host (Cloud media) is reachable via redirect, without the Jira credentials", async () => {
  const http = await import("node:http");
  const seen: Array<string | undefined> = [];
  const media = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end("MEDIA-BYTES");
  });
  await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));
  const mediaHost = `127.0.0.1:${(media.address() as { port: number }).port}`;
  try {
    const client = new JiraClient(jira.baseUrl, { kind: "bearer", token: TEST_TOKEN }, "test", false, [mediaHost]);
    jira.redirectTarget = `http://${mediaHost}/file.png`;
    const bytes = Buffer.from(await client.download(`${jira.baseUrl}/redirect-media`));
    assert.equal(bytes.toString(), "MEDIA-BYTES");
    assert.deepEqual(seen, [undefined]);
    // Without the allowance the same redirect is refused.
    const strict = new JiraClient(jira.baseUrl, { kind: "bearer", token: TEST_TOKEN }, "test");
    await assert.rejects(strict.download(`${jira.baseUrl}/redirect-media`), /only .* is allowed/);
    // Import mode ignores extra hosts entirely.
    assert.throws(
      () => new JiraClient("https://example.atlassian.net", { kind: "basic", token: "t", email: "e@x" }, "test", true, ["api.media.atlassian.com"]),
      /opens no outbound connections/,
    );
  } finally {
    media.close();
  }
});

test("the web UI loads nothing from other origins; its CSP keeps every request on this server", () => {
  const ui = path.join(SRC, "serve", "ui");
  for (const f of fs.readdirSync(ui)) {
    const text = fs.readFileSync(path.join(ui, f), "utf8");
    assert.doesNotMatch(text, /(?:src|href)\s*=\s*["']https?:\/\//i, `${f}: an external script, style or link`);
    assert.doesNotMatch(text, /(?:fetch|import)\(\s*["'`]https?:\/\//, `${f}: a request to another origin`);
    assert.doesNotMatch(text, /@import|url\(\s*["']?https?:\/\//i, `${f}: an external stylesheet or image`);
    assert.doesNotMatch(text, /XMLHttpRequest|WebSocket|EventSource|sendBeacon/, `${f}: another network API`);
  }
  const server = fs.readFileSync(path.join(SRC, "serve", "server.ts"), "utf8");
  assert.match(server, /"content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'"/);
});
