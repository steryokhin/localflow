// Round 2 of loops: compare-and-swap on loops.md and files saved from the UI, branch tags and
// "after" links in the ladder of steps, editing one line, bump with a new "else".

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdBump, cmdCreate, cmdDone, cmdInit, cmdLoop, cmdLoops } from "../src/commands.ts";
import { fileView, saveFile, ticketView } from "../src/serve/api.ts";
import { startServer } from "../src/serve/server.ts";
import { addLoop, closeLoop, formatLoop, loopsTestHooks, readLoops, replaceLoopLine } from "../src/vault/loops.ts";
import { findTicket } from "../src/vault/store.ts";

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
const loopsFile = (): string => path.join(vault, "loops.md");
const notes = (key: string): string => fs.readFileSync(path.join(findTicket(vault, key)!.dir, "notes.md"), "utf8");
const byText = (text: string) => readLoops(vault).find((l) => l.text === text)!;
const send = async (method: string, p: string, body: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}${p}`, { method, headers: { "x-localflow": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-branches-")));
  vault = path.join(tmp, "vault");
  console.log = (line = "") => void printed.push(String(line));
  cmdInit(vault, { localPrefix: "WORK" });
  cmdCreate(vault, "WORK", "Settings crash", {}); // WORK-001: three branches
  cmdCreate(vault, "WORK", "Other", {});
  server = await startServer(vault, { port: 0 });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("tags and after: written as fields, read back from hand-written lines, old lines still parse", () => {
  const now = new Date();
  const l = addLoop(vault, { text: "#android QA check", key: "WORK-001", by: "+4h", owner: "Lena" }, now);
  assert.equal(l.tag, "android");
  assert.equal(l.text, "QA check");
  assert.match(fs.readFileSync(loopsFile(), "utf8"), new RegExp(`${l.id} · .* · WORK-001 · #android · QA check · from Lena · by `));
  fs.appendFileSync(loopsFile(), "- [ ] WORK-001 · #web-scope agree the web scope · до 2026-12-01 · после L1 · иначе: ask PM\n- [ ] old style line · from Tom · by 2026-12-02\n");
  const hand = byText("agree the web scope");
  assert.equal(hand.tag, "web-scope");
  assert.equal(hand.after, "L1");
  assert.equal(hand.onExpiry, "ask PM");
  const old = byText("old style line");
  assert.equal(old.tag, null);
  assert.equal(old.after, null);
  assert.equal(old.owner, "Tom");
  assert.match(formatLoop({ ...hand, id: "L9" }), /^- \[ \] L9 · .*WORK-001 · #web-scope · agree the web scope · from me · by 2026-12-01 · after L1 · else: ask PM$/);
  assert.throws(() => addLoop(vault, { text: "x", by: "+1h", tag: "two words" }, now), /Not a branch tag/);
});

test("lf done --next keeps the branch and writes after; the card's history reads L3 (outcome) -> next", async () => {
  await run(() => cmdLoop(vault, "a11y ticket filed", { key: "WORK-001", by: "+1d", tag: "a11y" }));
  const qa = byText("QA check");
  const outText = await run(() => cmdDone(vault, qa.id, "Lena: passes on Pixel", { text: "fix the Samsung edge case", by: "+2d" }));
  assert.match(outText, new RegExp(`#android \\(after ${qa.id}\\)`));
  const next = byText("fix the Samsung edge case");
  assert.equal(next.tag, "android");
  assert.equal(next.after, qa.id);
  assert.match(notes("WORK-001"), new RegExp(`Lena: passes on Pixel \\(${qa.id} #android: QA check, from Lena\\)`));

  const view = ticketView(vault, "WORK-001");
  assert.deepEqual(view.branches.map((b) => b.tag), ["a11y", "android", "web-scope", ""].filter((t) => view.branches.some((b) => b.tag === t)));
  const android = view.branches.find((b) => b.tag === "android")!;
  assert.deepEqual(android.closed.map((c) => [c.id, c.outcome]), [[qa.id, "Lena: passes on Pixel"]]);
  assert.deepEqual(android.open.map((o) => [o.id, o.after]), [[next.id, qa.id]]);

  const ladder = await run(() => cmdLoops(vault, { key: "WORK-001", tag: "android" }));
  assert.match(ladder, new RegExp(`#android\\n  ✓ ${qa.id} · QA check → Lena: passes on Pixel`));
  assert.match(ladder, new RegExp(`○ ${next.id} after ${qa.id} · fix the Samsung edge case`));
  assert.doesNotMatch(ladder, /a11y/);
  assert.throws(() => cmdLoops(vault, { tag: "android" }), /--tag goes with --key/);
});

test("a second done on the same id fails clearly; a done between read and write is re-applied", () => {
  const now = new Date();
  const a = addLoop(vault, { text: "first", key: "WORK-002", by: "+1h" }, now);
  closeLoop(vault, a.id, "ok", now);
  assert.throws(() => closeLoop(vault, a.id, "again", now), new RegExp(`No open loop ${a.id}`));

  // Someone adds a line by hand while lf is closing another loop: both survive.
  const b = addLoop(vault, { text: "second", key: "WORK-002", by: "+1h" }, now);
  loopsTestHooks.beforeWrite = () => fs.appendFileSync(loopsFile(), "- [ ] typed by hand meanwhile · by 2026-12-03\n");
  closeLoop(vault, b.id, "ok", now);
  assert.ok(readLoops(vault).some((l) => l.text === "typed by hand meanwhile"), "the concurrent edit is kept");
  assert.ok(!readLoops(vault).some((l) => l.id === b.id), "and the close went through on the re-read");

  // The same loop's line edited in between: refused, nothing changed.
  const c = addLoop(vault, { text: "third", key: "WORK-002", by: "+1h" }, now);
  loopsTestHooks.beforeWrite = () => {
    const text = fs.readFileSync(loopsFile(), "utf8").replace(" · third · ", " · third, reworded · ");
    fs.writeFileSync(loopsFile(), text);
  };
  assert.throws(() => closeLoop(vault, c.id, "ok", now), /edited in loops\.md meanwhile/);
  assert.equal(byText("third, reworded").id, c.id);
});

test("the UI's stale copy of loops.md is refused after an lf done; the done is kept", async () => {
  const now = new Date();
  const l = addLoop(vault, { text: "ping design", key: "WORK-002", by: "+3h" }, now);
  const stale = fileView(vault, "loops.md");
  await run(() => cmdDone(vault, l.id, "pinged"));
  const save = await send("PUT", "/api/file", { path: "loops.md", body: stale.blocks.map((b) => b.src).join("\n\n"), head: stale.head, hash: stale.hash });
  assert.equal(save.status, 409);
  assert.match(save.json.error, /changed on disk/);
  assert.ok(!readLoops(vault).some((x) => x.id === l.id), "the done stays");
  assert.throws(() => saveFile(vault, "loops.md", "x", "", stale.hash), /changed on disk/);
  const fresh = fileView(vault, "loops.md");
  assert.equal(saveFile(vault, "loops.md", fresh.blocks.map((b) => b.src).join("\n\n"), fresh.head, fresh.hash).length, 16);
});

test("API done/bump with a stale line (expect) are refused; frontmatter writes are CAS too", async () => {
  const l = addLoop(vault, { text: "review PR", key: "WORK-002", by: "+3h", owner: "Tom" }, new Date());
  const seen = l.raw ?? readLoops(vault).find((x) => x.id === l.id)!.raw!;
  replaceLoopLine(vault, l.id, seen.replace("review PR", "review PR #7"), seen);
  const done = await send("POST", "/api/loop/done", { id: l.id, outcome: "ok", next: null, expect: seen });
  assert.equal(done.status, 409);
  const bump = await send("POST", "/api/loop/bump", { id: l.id, by: "tomorrow", expect: seen });
  assert.equal(bump.status, 409);
  assert.equal(byText("review PR #7").id, l.id);

  const n = fileView(vault, `${findTicket(vault, "WORK-002")!.rel}/notes.md`);
  const ok = await send("POST", "/api/frontmatter", { path: n.rel, updates: { priority: "P1" }, hash: n.hash });
  assert.equal(ok.status, 200);
  const again = await send("POST", "/api/frontmatter", { path: n.rel, updates: { priority: "P3" }, hash: n.hash });
  assert.equal(again.status, 409);
  assert.equal((await send("POST", "/api/frontmatter", { path: n.rel, updates: { priority: "P3" }, hash: ok.json.hash })).status, 200);
});

test("PUT /api/loop/line: a good edit applies (same parser as lf); a broken line is refused and nothing is saved", async () => {
  const l = addLoop(vault, { text: "check web scope", key: "WORK-001", by: "+5h", tag: "web" }, new Date());
  const raw = readLoops(vault).find((x) => x.id === l.id)!.raw!;
  const good = await send("PUT", "/api/loop/line", { id: l.id, line: `${l.id} · WORK-001 · #web · check web scope with PM · from Anna · by 2026-12-05 · else: ask in #web`, expect: raw });
  assert.equal(good.status, 200);
  const now = byText("check web scope with PM");
  assert.equal(now.owner, "Anna");
  assert.equal(now.due, "2026-12-05");
  assert.equal(now.tag, "web");
  const before = fs.readFileSync(loopsFile(), "utf8");
  for (const [line, err] of [
    [`${l.id} · WORK-001 · something · by someday`, /Cannot read the deadline/],
    [`${l.id} · WORK-404 · something · by 2026-12-05`, /WORK-404 not found/],
    [`L999 · WORK-001 · something · by 2026-12-05`, /The id stays/],
    [`${l.id} · WORK-001 · no deadline`, /needs a deadline/],
  ] as const) {
    const bad = await send("PUT", "/api/loop/line", { id: l.id, line, expect: now.raw });
    assert.equal(bad.status, 400, line);
    assert.match(bad.json.error, err);
  }
  assert.equal(fs.readFileSync(loopsFile(), "utf8"), before, "nothing saved");
  assert.equal((await send("PUT", "/api/loop/line", { id: l.id, line: `${l.id} · x · by 2026-12-06`, expect: raw })).status, 409, "stale expect");
});

test("lf bump --else replaces else and logs the old deadline and the old else", async () => {
  const l = addLoop(vault, { text: "Mark's answer", key: "WORK-002", by: "2026-12-01", owner: "Mark", onExpiry: "ask in standup" }, new Date());
  const outText = await run(() => cmdBump(vault, l.id, "2026-12-03", "escalate to the lead"));
  assert.match(outText, /else: escalate to the lead \(was: ask in standup\)/);
  const now = byText("Mark's answer");
  assert.equal(now.onExpiry, "escalate to the lead");
  assert.equal(now.due, "2026-12-03");
  assert.match(notes("WORK-002"), new RegExp(`${l.id} moved to 2026-12-03 \\(was 2026-12-01\\); else: escalate to the lead \\(was: ask in standup\\): Mark's answer`));
  const api = await send("POST", "/api/loop/bump", { id: l.id, by: "2026-12-04", else: "drop it" });
  assert.equal(api.json.wasElse, "escalate to the lead");
  assert.equal(byText("Mark's answer").onExpiry, "drop it");
});
