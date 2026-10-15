// The Outline page's API over HTTP: the tree, operations with compare-and-swap, history, the
// migration, and the commits the server makes for edits from the page and from other editors.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCreate, cmdInit } from "../src/commands.ts";
import { startServer } from "../src/serve/server.ts";
import { git } from "../src/vault/git.ts";
import { addLoop } from "../src/vault/loops.ts";

let tmp: string;
let vault: string;
let server: http.Server;
let base: string;
const get = async (p: string): Promise<any> => (await fetch(`${base}${p}`)).json();
const post = async (p: string, body: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}${p}`, { method: "POST", headers: { "x-localflow": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const subjects = (): string[] => git(vault, ["log", "--format=%s"]).trim().split("\n");
const lastMessage = (): string => git(vault, ["log", "-1", "--format=%B"]);
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-outline-serve-")));
  vault = path.join(tmp, "vault");
  console.log = () => {};
  cmdInit(vault, { localPrefix: "WORK" });
  cmdCreate(vault, "WORK", "Login crash", {});
  server = await startServer(vault, { port: 0, commitDelayMs: 50 });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("GET /api/outline before anything exists; migrate brings loops.md in", async () => {
  const empty = await get("/api/outline");
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.sections, []);
  assert.ok(empty.tickets.some((t: any) => t.key === "WORK-001"));
  addLoop(vault, { text: "QA check", key: "WORK-001", owner: "Lena", by: "+1d" }, new Date());
  const m = await post("/api/outline/migrate", {});
  assert.equal(m.status, 200);
  assert.match(m.json.message, /1 sections, 1 items/);
  const v = await get("/api/outline");
  assert.equal(v.sections[0].key, "WORK-001");
  assert.equal(v.sections[0].ticket.title, "Login crash");
  assert.equal(v.sections[0].items[0].loop.owner, "Lena");
});

test("operations: a batch is one write; a stale expect is a 409 and changes nothing", async () => {
  const r = await post("/api/outline/op", { ops: [
    { op: "insert", place: { parent: null, section: "WORK-001", index: 0 }, item: { id: "a2b3", text: "research", check: " " } },
    { op: "insert", place: { parent: "a2b3" }, item: { id: "c4d5", text: "ask Jim · from Jim · by tomorrow", check: " " } },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.json.ids.a2b3, "a2b3", "the client's ids are kept");
  await until(() => /add c4d5/.test(lastMessage()));
  const item = r.json.view.sections[0].items[0];
  assert.equal(item.children[0].loop.owner, "Jim");
  const before = fs.readFileSync(path.join(vault, "outline.md"), "utf8");
  const stale = await post("/api/outline/op", { ops: [{ op: "text", id: "a2b3", text: "x", expect: "000000000000" }] });
  assert.equal(stale.status, 409);
  assert.equal(fs.readFileSync(path.join(vault, "outline.md"), "utf8"), before);
  const bad = await post("/api/outline/op", { ops: [{ op: "nope" }] });
  assert.equal(bad.status, 400);
  const ok = await post("/api/outline/op", { ops: [{ op: "text", id: "a2b3", text: "research the crash", expect: item.own }] });
  assert.equal(ok.status, 200);
});

test("the page's edits are committed after a pause, and so are edits made in another editor", async () => {
  await until(() => /edit a2b3/.test(lastMessage()));
  assert.match(lastMessage(), /^outline \(ui\): edit a2b3: research the crash/);
  fs.appendFileSync(path.join(vault, "outline.md"), "- [ ] typed in another editor\n");
  await until(() => subjects()[0].startsWith("outline (hand):"));
  assert.match(subjects()[0], /^outline \(hand\): edited outside lf$/);
});

test("history: an item's life, days with changes, a day as it was", async () => {
  const h = await get("/api/outline/history?id=a2b3");
  assert.deepEqual(h.events.map((e: any) => e.kind), ["added", "added", "edited"]);
  const days = await get("/api/outline/days");
  const today = days.days[0];
  assert.ok(today.changes >= 4);
  const day = await get(`/api/outline/day?day=${today.day}`);
  assert.ok(day.sections[0].items.some((i: any) => i.id === "a2b3"));
  assert.ok(day.events.length >= 4);
  const k = await get("/api/outline/history?key=WORK-001");
  assert.ok(k.events.some((e: any) => e.ref === "c4d5"));
});
