// outline.md: the format and its line operations, loops.md kept in step both ways, operations by id
// from the editor, lenses, and the history read back from the vault's git.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCreate, cmdInit } from "../src/commands.ts";
import { cmdOutlineMigrate } from "../src/commands-outline.ts";
import { renderOutline, visibleFor } from "../src/render/outline.ts";
import { git } from "../src/vault/git.ts";
import { addLoop, bumpLoop, closeLoop, readLoops } from "../src/vault/loops.ts";
import { appendToSection } from "../src/vault/notes.ts";
import {
  insertItem, moveItem, outlineText, ownHash, parseOutline, removeItem, setItem, withIds,
} from "../src/vault/outline.ts";
import { changesByDay, commitOutline, itemHistory, outlineAt, ticketHistory } from "../src/vault/outline-history.ts";
import { applyOps, normalizeTaskText } from "../src/vault/outline-ops.ts";
import { outlineHooks, readModel } from "../src/vault/outline-store.ts";
import { findTicket } from "../src/vault/store.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "docs", "outline-format", "fixtures");
let tmp: string;
let vault: string;
const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), "utf8");
const writeFile = (rel: string, text: string): void => fs.writeFileSync(path.join(vault, rel), text);
const MON = new Date(2026, 9, 12, 11, 0);

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-outline-")));
  vault = path.join(tmp, "vault");
  console.log = () => {};
  cmdInit(vault, { localPrefix: "WORK" });
  cmdCreate(vault, "WORK", "Login crash on swipe", {});
  cmdCreate(vault, "WORK", "Payments", {});
});

after(() => {
  outlineHooks.afterWrite = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- the format ----------

test("fixtures: each parses to its expected tree, and a write after a read changes no byte", () => {
  const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".md"));
  assert.ok(names.length >= 4, "fixtures exist");
  for (const name of names) {
    const text = fs.readFileSync(path.join(FIXTURES, name), "utf8");
    const o = parseOutline(text);
    const tree = o.sections.map((s) => ({
      key: s.key, title: s.title, closed: s.closed,
      items: s.items.map(function walk(it): unknown {
        return { id: it.id, check: it.check, text: it.text, ...(it.context.length ? { context: it.context } : {}), ...(it.children.length ? { children: it.children.map(walk) } : {}) };
      }),
    }));
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, name.replace(/\.md$/, ".json")), "utf8"));
    assert.deepEqual(tree, expected, name);
    if (o.items.every((it) => it.id)) assert.equal(outlineText(withIds(o)), text, `${name}: round trip`);
  }
});

test("ids: items without one get a stable derived id, written only by the next write", () => {
  const text = "## A-1 · x\n- [ ] one\n- [ ] one\n  - child\n";
  const a = parseOutline(text);
  const b = parseOutline(text);
  assert.deepEqual(a.items.map((i) => i.ref), b.items.map((i) => i.ref), "same text, same ids");
  assert.equal(new Set(a.items.map((i) => i.ref)).size, 3, "two identical lines still get two ids");
  assert.ok(a.items.every((i) => i.id === null));
  const written = outlineText(withIds(a));
  assert.equal(written, `## A-1 · x\n- [ ] one ^${a.items[0].ref}\n- [ ] one ^${a.items[1].ref}\n  - child ^${a.items[2].ref}\n`);
  const dup = parseOutline("## A-1\n- [ ] a ^k3f9\n- [ ] b ^k3f9\n");
  assert.equal(dup.items[0].ref, "k3f9");
  assert.notEqual(dup.items[1].ref, "k3f9", "a duplicate id typed by hand gets a new one");
});

test("line operations: only the lines an operation is about change", () => {
  const text = "# Outline\n\n## A-1 · x\n- [ ] a ^a2a2\n  > why\n  - [ ] a1 ^b2b2\n\t- [ ] tabbed ^c2c2\n- [ ] b ^d2d2\n\n## B-2 · y\n- [x] done ^e2e2\n";
  const o = parseOutline(text);
  assert.equal(o.byRef.get("c2c2")!.parent!.ref, "a2a2", "a tab counts as two spaces");
  const edited = outlineText(setItem(o, o.byRef.get("b2b2")!, { text: "a1 edited", check: "x" }));
  assert.equal(edited, text.replace("  - [ ] a1 ^b2b2", "  - [x] a1 edited ^b2b2"));
  const moved = parseOutline(outlineText(moveItem(o, o.byRef.get("a2a2")!, { parent: null, section: "B-2" })));
  assert.equal(outlineText(moved), "# Outline\n\n## A-1 · x\n- [ ] b ^d2d2\n\n## B-2 · y\n- [x] done ^e2e2\n- [ ] a ^a2a2\n  > why\n  - [ ] a1 ^b2b2\n  - [ ] tabbed ^c2c2\n");
  const under = parseOutline(outlineText(moveItem(o, o.byRef.get("d2d2")!, { parent: "b2b2" })));
  assert.equal(under.byRef.get("d2d2")!.parent!.ref, "b2b2");
  assert.equal(under.lines[under.byRef.get("d2d2")!.line], "    - [ ] b ^d2d2");
  assert.throws(() => moveItem(o, o.byRef.get("a2a2")!, { parent: "b2b2" }), /under itself/);
  const removed = outlineText(removeItem(o, o.byRef.get("a2a2")!));
  assert.equal(removed, "# Outline\n\n## A-1 · x\n- [ ] b ^d2d2\n\n## B-2 · y\n- [x] done ^e2e2\n");
  const inserted = outlineText(insertItem(o, { parent: null, section: "A-1", index: 1 }, { id: "f2f2", check: " ", text: "new", context: ["c"] }));
  assert.match(inserted, /\t- \[ \] tabbed \^c2c2\n- \[ \] new \^f2f2\n  > c\n- \[ \] b \^d2d2/);
  assert.equal(ownHash(o.byRef.get("a2a2")!), ownHash(parseOutline(outlineText(moveItem(o, o.byRef.get("a2a2")!, { parent: null, section: "B-2" }))).byRef.get("a2a2")!), "a move keeps the own-content hash");
});

// ---------- loops.md both ways ----------

test("loops live in the outline; loops.md follows, both ways", () => {
  const a = addLoop(vault, { text: "PR #41 review", key: "WORK-001", owner: "Tom", by: "18:00" }, MON);
  assert.match(read("outline.md"), new RegExp(`^## WORK-001 · Login crash on swipe\\n- \\[ \\] PR #41 review · from Tom · by 2026-10-12 18:00 · opened 2026-10-12 11:00 \\^${a.id}$`, "m"));
  // A hand edit in loops.md is read at once and stored in the outline by the next write.
  writeFile("loops.md", read("loops.md").replace("PR #41 review", "PR #41 review (2 files)"));
  assert.equal(readLoops(vault).find((l) => l.id === a.id)!.text, "PR #41 review (2 files)");
  assert.doesNotMatch(read("outline.md"), /2 files/, "a read never writes");
  const b = addLoop(vault, { text: "QA build", key: "WORK-002", by: "+1d" }, MON);
  assert.match(read("outline.md"), /PR #41 review \(2 files\) · from Tom/);
  // An edit in the outline goes to loops.md the same way.
  writeFile("outline.md", read("outline.md").replace("QA build", "QA build 1.0.4"));
  bumpLoop(vault, b.id, "2026-10-20", MON);
  assert.match(read("loops.md"), new RegExp(`\\^${b.id} · .* · QA build 1\\.0\\.4 · from me · by 2026-10-20`));
});

test("a loop edited in both files since the last write is a conflict: kept as is, operations refused", () => {
  const c = addLoop(vault, { text: "ask Mark", key: "WORK-002", owner: "Mark", by: "+2d" }, MON);
  writeFile("loops.md", read("loops.md").replace("ask Mark", "ask Mark (loops)"));
  writeFile("outline.md", read("outline.md").replace("ask Mark", "ask Mark (outline)"));
  assert.throws(() => closeLoop(vault, c.id, "ok", MON), /edited both in loops\.md and in outline\.md/);
  addLoop(vault, { text: "unrelated", by: "+1d" }, MON);
  assert.match(read("loops.md"), /ask Mark \(loops\)/, "the conflicting line stays in loops.md");
  assert.match(read("outline.md"), /ask Mark \(outline\)/, "and the item in outline.md");
  // Made to agree: the conflict is gone.
  writeFile("loops.md", read("loops.md").replace("ask Mark (loops)", "ask Mark (outline)"));
  closeLoop(vault, c.id, "ok", MON);
  assert.ok(!readLoops(vault).some((l) => l.id === c.id));
});

test("a loop line deleted from loops.md removes the item and its whole subtree (D6)", () => {
  const d = addLoop(vault, { text: "wait for design", key: "WORK-002", owner: "Ann", by: "+2d" }, MON);
  applyOps(vault, [{ op: "insert", place: { parent: d.id }, item: { text: "sub-step", check: " " } }], MON);
  assert.match(read("outline.md"), /  - \[ \] sub-step/);
  writeFile("loops.md", read("loops.md").split("\n").filter((l) => !l.includes(`^${d.id} `)).join("\n"));
  assert.ok(!readModel(vault).o.byRef.has(d.id));
  addLoop(vault, { text: "after the delete", by: "+1d" }, MON);
  assert.doesNotMatch(read("outline.md"), /wait for design|sub-step/);
});

// ---------- operations from the editor ----------

test("editor operations: insert with temp ids, text with loop rules, check logs like lf done, move, delete and undo", () => {
  const r = applyOps(vault, [
    { op: "insert", temp: "t1", place: { parent: null, section: "WORK-001", index: 0 }, item: { text: "research issue #123", check: " " } },
    { op: "insert", temp: "t2", place: { parent: "t1" }, item: { text: "call Jim", check: " " } },
    { op: "insert", temp: "t3", place: { after: "t2" }, item: { text: "wait for Jim's review · from Jim · by tomorrow", check: " " } },
  ], MON);
  const o = readModel(vault).o;
  const wait = o.byRef.get(r.ids.t3)!;
  assert.equal(wait.parent!.ref, r.ids.t1);
  assert.equal(wait.text, "wait for Jim's review · from Jim · by 2026-10-13 · opened 2026-10-12 11:00", "by tomorrow became a date; opened stamped");
  assert.ok(readLoops(vault).some((l) => l.id === r.ids.t3 && l.owner === "Jim"), "and it is a loop");

  assert.throws(() => applyOps(vault, [{ op: "text", id: r.ids.t2, text: "x", expect: "stale" }], MON), /changed elsewhere/);
  applyOps(vault, [{ op: "text", id: r.ids.t2, text: "call Jim about the crash", expect: ownHash(o.byRef.get(r.ids.t2)!) }], MON);

  applyOps(vault, [{ op: "check", id: r.ids.t3, check: "x", outcome: "Jim approved" }], MON);
  const notes = fs.readFileSync(path.join(findTicket(vault, "WORK-001")!.dir, "notes.md"), "utf8");
  assert.match(notes, new RegExp(`Jim approved \\(${r.ids.t3}: wait for Jim's review, from Jim\\)`));
  assert.ok(!readLoops(vault).some((l) => l.id === r.ids.t3));

  applyOps(vault, [{ op: "move", id: r.ids.t2, place: { parent: null, section: "WORK-001", index: 0 } }], MON);
  assert.equal(readModel(vault).o.byRef.get(r.ids.t2)!.parent, null);

  const del = applyOps(vault, [{ op: "delete", id: r.ids.t1 }], MON);
  assert.ok(!readModel(vault).o.byRef.has(r.ids.t3), "the subtree went with it");
  applyOps(vault, [{ op: "insert", place: { parent: null, section: "WORK-001" }, item: del.removed[r.ids.t1] }], MON);
  assert.equal(readModel(vault).o.byRef.get(r.ids.t3)!.parent!.ref, r.ids.t1, "undo puts the same ids back");

  assert.equal(normalizeTaskText("ping · by someday", " ", MON), "ping · by someday", "an unreadable by is kept as typed");
  assert.equal(normalizeTaskText("note · by tomorrow", null, MON), "note · by tomorrow", "only tasks become loops");
});

test("sections: a new one by key takes the ticket's title; one with items is not deleted", () => {
  applyOps(vault, [{ op: "section", title: "Ideas" }, { op: "insert", place: { parent: null, section: "#Ideas" }, item: { text: "dark mode", check: null } }], MON);
  assert.match(read("outline.md"), /## Ideas\n- dark mode \^/);
  assert.throws(() => applyOps(vault, [{ op: "sectionDelete", section: "#Ideas" }], MON), /still has items/);
  applyOps(vault, [{ op: "sectionSet", section: "WORK-002", closed: true }], MON);
  assert.match(read("outline.md"), /## WORK-002 · Payments ✓/);
  assert.throws(() => applyOps(vault, [{ op: "section", key: "WORK-001" }], MON), /already has a section/);
});

// ---------- lenses ----------

test("lenses keep the parents of what they show; closed sections drop out of Active", () => {
  const o = parseOutline("## A-1 · x\n- [x] done ^a2a2\n- [ ] open parent ^b2b2\n  - [x] done child ^c2c2\n  - [ ] wait · from Jim · by 2026-10-11 ^d2d2\n- [x] closed parent ^e2e2\n  - [ ] orphan open ^f2f2\n\n## B-2 · y ✓\n- [ ] in closed ^g2g2\n");
  const v = visibleFor(o, "active", MON);
  assert.deepEqual([...v.items].sort(), ["b2b2", "d2d2"]);
  assert.ok(!v.sections.has("B-2"));
  const w = visibleFor(o, "expired", MON);
  assert.deepEqual([...w.items].sort(), ["b2b2", "d2d2"], "the expired wait comes with its parent");
  assert.equal(w.matched, 1);
  assert.match(renderOutline(o, MON, { visible: w }), /## A-1 · x\n  ○ open parent  \^b2b2\n    ○ wait · from Jim · by 11 Oct  \^d2d2  ← expired/);
  assert.deepEqual([...visibleFor(o, "all", MON, { query: "orphan" }).items].sort(), ["e2e2", "f2f2"]);
});

// ---------- history ----------

test("history: every write is a commit; the outline as of a day, an item's life, changes by day", () => {
  outlineHooks.afterWrite = (v, summary) => void commitOutline(v, "lf", summary);
  const r = applyOps(vault, [{ op: "insert", temp: "h", place: { parent: null, section: "WORK-001" }, item: { text: "history root", check: " " } }], MON);
  applyOps(vault, [{ op: "insert", place: { parent: r.ids.h }, item: { text: "child step", check: " " } }], MON);
  applyOps(vault, [{ op: "text", id: r.ids.h, text: "history root, renamed" }], MON);
  applyOps(vault, [{ op: "check", id: r.ids.h, check: "x" }], MON);
  outlineHooks.afterWrite = null;
  assert.match(git(vault, ["log", "-1", "--format=%s"]), /^outline \(lf\): check /);

  const life = itemHistory(vault, r.ids.h);
  assert.doesNotThrow(() => JSON.stringify(life), "events are plain data (the web UI sends them)");
  assert.deepEqual(life.map((e) => e.kind), ["added", "added", "edited", "checked"]);
  assert.equal(life[1].text, "child step");
  assert.equal(life[2].was, "history root");
  assert.ok(ticketHistory(vault, "WORK-001").some((e) => e.ref === r.ids.h));

  const today = new Date().toISOString().slice(0, 10);
  const days = changesByDay(vault, { since: today });
  assert.ok(days.length >= 1 && days[days.length - 1].events.some((e) => e.ref === r.ids.h));
  assert.equal(outlineAt(vault, "2000-01-01"), null, "nothing before the first commit");
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  assert.equal(outlineAt(vault, yesterday), null, "the commits are all from today");
  assert.ok(outlineAt(vault, today)!.o.byRef.has(r.ids.h));
});

// ---------- migration ----------

test("migrate: open loops from loops.md and closed steps from the Logs, ids kept; idempotent", () => {
  const v2 = path.join(tmp, "v2");
  cmdInit(v2, { localPrefix: "WORK" });
  cmdCreate(v2, "WORK", "Old ticket", {});
  fs.writeFileSync(path.join(v2, "loops.md"), "# Open loops\n\n- [ ] L7 · 2026-10-10 09:00 · WORK-001 · #android · QA check · from Lena · by 2026-10-14 · after L6\n");
  const notesFile = path.join(findTicket(v2, "WORK-001")!.dir, "notes.md");
  fs.writeFileSync(notesFile, appendToSection(fs.readFileSync(notesFile, "utf8"), "Log", "- 2026-10-09 17:00 — sent to QA (L6 #android: send the build, from me)"));
  cmdOutlineMigrate(v2, {});
  const text = fs.readFileSync(path.join(v2, "outline.md"), "utf8");
  assert.match(text, /## WORK-001 · Old ticket\n- \[x\] #android send the build \^L6\n  > sent to QA \(2026-10-09 17:00\)\n- \[ \] #android QA check · from Lena · by 2026-10-14 · after L6 · opened 2026-10-10 09:00 \^L7\n/);
  cmdOutlineMigrate(v2, {});
  assert.equal(fs.readFileSync(path.join(v2, "outline.md"), "utf8"), text, "a second run changes nothing");
  assert.match(fs.readFileSync(path.join(v2, "loops.md"), "utf8"), /^- \[ \] L7 · 2026-10-10 09:00 · WORK-001 · #android · QA check · from Lena · by 2026-10-14 · after L6$/m);
});
