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
  insertItem, moveItem, outlineText, ownHash, parseOutline, removeItem, setItem, ticketItem, ticketsAbove, withIds,
} from "../src/vault/outline.ts";
import { changesByDay, commitOutline, itemHistory, outlineAt, ticketHistory } from "../src/vault/outline-history.ts";
import { applyOps, normalizeTaskText } from "../src/vault/outline-ops.ts";
import { doneOf, withDone } from "../src/vault/loopfields.ts";
import { loopOf, outlineHooks, readModel } from "../src/vault/outline-store.ts";
import { findTicket } from "../src/vault/store.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "docs", "outline-format", "fixtures");
let tmp: string;
let vault: string;
const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), "utf8");
const writeFile = (rel: string, text: string): void => fs.writeFileSync(path.join(vault, rel), text);
const MON = new Date(2026, 9, 12, 11, 0);
/** The id of a ticket's item in the main test vault. */
const tk = (key: string, v = vault): string => ticketItem(readModel(v).o, key)!.ref;

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
  assert.ok(names.length >= 5, "fixtures exist");
  for (const name of names) {
    const text = fs.readFileSync(path.join(FIXTURES, name), "utf8");
    const o = parseOutline(text);
    const tree = o.roots.map(function walk(it): unknown {
      return {
        id: it.id, check: it.check, text: it.text, ...(it.ticket ? { ticket: it.ticket } : {}), ...(it.context.length ? { context: it.context } : {}),
        ...(it.children.length ? { children: it.children.map(walk) } : {}),
      };
    });
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, name.replace(/\.md$/, ".json")), "utf8"));
    assert.deepEqual(tree, expected, name);
    if (o.items.every((it) => it.id) && !/^## /m.test(text)) assert.equal(outlineText(withIds(o)), text, `${name}: round trip`);
  }
});

test("a file from before one tree: headings become top items, what was under them moves one level in", () => {
  const legacy = "# Outline\n\n## A-1 · First\n- [ ] a ^a2a2\n  > why\n\n## Inbox ✓\n- note ^b2b2\n";
  const o = parseOutline(legacy);
  const written = outlineText(withIds(o));
  const [t, inbox] = o.roots;
  assert.equal(written, `# Outline\n\n- A-1 · First ^${t.ref}\n  - [ ] a ^a2a2\n    > why\n\n- [x] Inbox ^${inbox.ref}\n  - note ^b2b2\n`);
  assert.equal(o.byRef.get("a2a2")!.key, "A-1", "an item belongs to the ticket above it");
  assert.equal(parseOutline(legacy).roots[0].ref, t.ref, "the heading's id is the same on every read (history of old commits)");
  assert.equal(parseOutline(written).byRef.get(t.ref)!.ticket!.title, "First");
});

test("ids: items without one get a stable derived id, written only by the next write", () => {
  const text = "- A-1 · x\n  - [ ] one\n  - [ ] one\n    - child\n";
  const a = parseOutline(text);
  const b = parseOutline(text);
  assert.deepEqual(a.items.map((i) => i.ref), b.items.map((i) => i.ref), "same text, same ids");
  assert.equal(new Set(a.items.map((i) => i.ref)).size, 4, "two identical lines still get two ids");
  assert.ok(a.items.every((i) => i.id === null));
  const [t, one, two, child] = a.items.map((i) => i.ref);
  assert.equal(outlineText(withIds(a)), `- A-1 · x ^${t}\n  - [ ] one ^${one}\n  - [ ] one ^${two}\n    - child ^${child}\n`);
  const dup = parseOutline("- A-1\n  - [ ] a ^k3f9\n  - [ ] b ^k3f9\n");
  assert.equal(dup.items[1].ref, "k3f9");
  assert.notEqual(dup.items[2].ref, "k3f9", "a duplicate id typed by hand gets a new one");
});

test("tickets nest like any item; an item belongs to the nearest ticket above it", () => {
  const o = parseOutline("- Mobile ^p2p2\n  - A-1 · Crash ^a2a2\n    - [ ] step ^s2s2\n    - A-2 · Cache ^b2b2\n      - [ ] inner ^i2i2\n  - [ ] A-3 · not a ticket: a task ^t2t2\n");
  assert.equal(o.byRef.get("p2p2")!.key, null);
  assert.equal(o.byRef.get("s2s2")!.key, "A-1");
  assert.equal(o.byRef.get("i2i2")!.key, "A-2");
  assert.equal(o.byRef.get("b2b2")!.home, o.byRef.get("b2b2"));
  assert.equal(o.byRef.get("t2t2")!.ticket, null, "only a bullet stands for a ticket");
  assert.deepEqual(ticketsAbove(o.byRef.get("i2i2")!).map((x) => x.ticket!.key), ["A-2", "A-1"]);
  assert.equal(ticketItem(o, "a-2")!.ref, "b2b2");
});

test("line operations: only the lines an operation is about change", () => {
  const text = "# Outline\n\n- A-1 · x ^t2t2\n  - [ ] a ^a2a2\n    > why\n    - [ ] a1 ^b2b2\n  \t- [ ] tabbed ^c2c2\n  - [ ] b ^d2d2\n\n- B-2 · y ^u2u2\n  - [x] done ^e2e2\n";
  const o = parseOutline(text);
  assert.equal(o.byRef.get("c2c2")!.parent!.ref, "a2a2", "a tab counts as two spaces");
  const edited = outlineText(setItem(o, o.byRef.get("b2b2")!, { text: "a1 edited", check: "x" }));
  assert.equal(edited, text.replace("    - [ ] a1 ^b2b2", "    - [x] a1 edited ^b2b2"));
  const moved = parseOutline(outlineText(moveItem(o, o.byRef.get("a2a2")!, { parent: "u2u2" })));
  assert.equal(outlineText(moved), "# Outline\n\n- A-1 · x ^t2t2\n  - [ ] b ^d2d2\n\n- B-2 · y ^u2u2\n  - [x] done ^e2e2\n  - [ ] a ^a2a2\n    > why\n    - [ ] a1 ^b2b2\n    - [ ] tabbed ^c2c2\n");
  const ticketIn = parseOutline(outlineText(moveItem(o, o.byRef.get("u2u2")!, { parent: "t2t2", index: 0 })));
  assert.equal(ticketIn.byRef.get("e2e2")!.key, "B-2");
  assert.equal(ticketIn.byRef.get("u2u2")!.parent!.ref, "t2t2", "a ticket moves under another ticket with what is under it");
  assert.equal(ticketIn.lines[ticketIn.byRef.get("e2e2")!.line], "    - [x] done ^e2e2");
  const top = parseOutline(outlineText(moveItem(o, o.byRef.get("d2d2")!, { parent: null, index: 0 })));
  assert.equal(top.roots[0].ref, "d2d2", "anything can go to the top level");
  assert.throws(() => moveItem(o, o.byRef.get("a2a2")!, { parent: "b2b2" }), /under itself/);
  const removed = outlineText(removeItem(o, o.byRef.get("a2a2")!));
  assert.equal(removed, "# Outline\n\n- A-1 · x ^t2t2\n  - [ ] b ^d2d2\n\n- B-2 · y ^u2u2\n  - [x] done ^e2e2\n");
  const inserted = outlineText(insertItem(o, { parent: "t2t2", index: 1 }, { id: "f2f2", check: " ", text: "new", context: ["c"] }));
  assert.match(inserted, /\t- \[ \] tabbed \^c2c2\n  - \[ \] new \^f2f2\n    > c\n  - \[ \] b \^d2d2/);
  const first = outlineText(insertItem(parseOutline("# Outline\n"), { parent: null }, { id: "g2g2", check: " ", text: "first" }));
  assert.equal(first, "# Outline\n\n- [ ] first ^g2g2\n");
  assert.equal(ownHash(o.byRef.get("a2a2")!), ownHash(moved.byRef.get("a2a2")!), "a move keeps the own-content hash");
});

// ---------- loops.md both ways ----------

test("loops live in the outline; loops.md follows, both ways", () => {
  const a = addLoop(vault, { text: "PR #41 review", key: "WORK-001", owner: "Tom", by: "18:00" }, MON);
  assert.match(read("outline.md"), new RegExp(`^- WORK-001 · Login crash on swipe \\^[a-z0-9]{4}\\n  - \\[ \\] PR #41 review · from Tom · by 2026-10-12 18:00 · opened 2026-10-12 11:00 \\^${a.id}$`, "m"));
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
    { op: "insert", temp: "t1", place: { parent: tk("WORK-001"), index: 0 }, item: { text: "research issue #123", check: " " } },
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

  applyOps(vault, [{ op: "move", id: r.ids.t2, place: { parent: tk("WORK-001"), index: 0 } }], MON);
  assert.equal(readModel(vault).o.byRef.get(r.ids.t2)!.parent!.ref, tk("WORK-001"));

  const del = applyOps(vault, [{ op: "delete", id: r.ids.t1 }], MON);
  assert.ok(!readModel(vault).o.byRef.has(r.ids.t3), "the subtree went with it");
  applyOps(vault, [{ op: "insert", place: { parent: tk("WORK-001") }, item: del.removed[r.ids.t1] }], MON);
  assert.equal(readModel(vault).o.byRef.get(r.ids.t3)!.parent!.ref, r.ids.t1, "undo puts the same ids back");

  assert.equal(normalizeTaskText("ping · by someday", " ", MON), "ping · by someday", "an unreadable by is kept as typed");
  assert.equal(normalizeTaskText("note · by tomorrow", null, MON), "note · by tomorrow", "only tasks become loops");
});

test("tickets are items: made from the outline as local tickets, closed by a check, nested with parent: in notes.md", () => {
  const vt = path.join(tmp, "vtickets");
  cmdInit(vt, { localPrefix: "WORK" });
  cmdCreate(vt, "WORK", "Existing", {});
  const notesOf = (key: string): string => fs.readFileSync(path.join(findTicket(vt, key)!.dir, "notes.md"), "utf8");
  const a = applyOps(vt, [{ op: "ticket", key: "work-001", temp: "a" }, { op: "ticket", title: "Brand new", temp: "b" }], MON);
  assert.deepEqual(a.created, ["WORK-002"], "a ticket by title is a new local ticket");
  assert.equal(findTicket(vt, "WORK-002")!.title, "Brand new");
  assert.match(fs.readFileSync(path.join(vt, "outline.md"), "utf8"), /^- WORK-001 · Existing \^\w+\n- WORK-002 · Brand new \^\w+$/m);
  assert.throws(() => applyOps(vt, [{ op: "ticket", key: "WORK-001" }], MON), /in the outline already/);

  // Nesting: under another ticket sets parent:, out of it removes it.
  applyOps(vt, [{ op: "move", id: a.ids.b, place: { parent: a.ids.a } }], MON);
  assert.match(notesOf("WORK-002"), /^parent: WORK-001$/m);
  applyOps(vt, [{ op: "move", id: a.ids.b, place: { parent: null } }], MON);
  assert.doesNotMatch(notesOf("WORK-002"), /^parent:/m);

  // An item turned into a ticket keeps what is under it; a folder between tickets does not break the chain.
  const f = applyOps(vt, [
    { op: "insert", temp: "folder", place: { parent: a.ids.a }, item: { text: "iOS", check: null } },
    { op: "insert", temp: "step", place: { parent: "folder" }, item: { text: "split the cache fix", check: " " } },
    { op: "insert", place: { parent: "step" }, item: { text: "child", check: " " } },
  ], MON);
  const made = applyOps(vt, [{ op: "ticket", id: f.ids.step }], MON);
  assert.deepEqual(made.created, ["WORK-003"]);
  const o = readModel(vt).o;
  const t3 = o.byRef.get(f.ids.step)!;
  assert.equal(t3.text, "WORK-003 · split the cache fix");
  assert.equal(t3.children[0].key, "WORK-003");
  assert.match(notesOf("WORK-003"), /^parent: WORK-001$/m, "the nearest ticket above, through a folder");

  // A check on a ticket closes it; a bullet typed as a known key gets its title.
  applyOps(vt, [{ op: "check", id: a.ids.a, check: "x" }], MON);
  assert.equal(readModel(vt).o.byRef.get(a.ids.a)!.ticket!.closed, true);
  assert.match(fs.readFileSync(path.join(vt, "outline.md"), "utf8"), /^- WORK-001 · Existing ✓ \^/m);
  const k = applyOps(vt, [{ op: "insert", temp: "k", place: { parent: null }, item: { text: "WORK-002", check: null } }], MON);
  assert.equal(readModel(vt).o.byRef.get(k.ids.k)!.text, "WORK-002 · Brand new");
});

// ---------- lenses ----------

test("lenses keep the parents of what they show; closed tickets drop out of Active", () => {
  const o = parseOutline("- A-1 · x ^t2t2\n  - [x] done ^a2a2\n  - [ ] open parent ^b2b2\n    - [x] done child ^c2c2\n    - [ ] wait · from Jim · by 2026-10-11 ^d2d2\n  - [x] closed parent ^e2e2\n    - [ ] orphan open ^f2f2\n\n- B-2 · y ✓ ^u2u2\n  - [ ] in closed ^g2g2\n");
  const v = visibleFor(o, "active", MON);
  assert.deepEqual([...v.items].sort(), ["b2b2", "d2d2", "t2t2"], "nothing of the closed ticket");
  const w = visibleFor(o, "expired", MON);
  assert.deepEqual([...w.items].sort(), ["b2b2", "d2d2", "t2t2"], "the expired wait comes with its parents");
  assert.equal(w.matched, 1);
  assert.match(renderOutline(o, MON, { visible: w }), /^◆ A-1 · x  \^t2t2\n  ○ open parent  \^b2b2\n    ○ wait · from Jim · by 11 Oct  \^d2d2  ← expired/);
  assert.deepEqual([...visibleFor(o, "all", MON, { query: "orphan" }).items].sort(), ["e2e2", "f2f2", "t2t2"]);
  assert.deepEqual([...visibleFor(o, "all", MON, { key: "B-2" }).items].sort(), ["g2g2", "u2u2"]);
});

// ---------- history ----------

test("history: every write is a commit; the outline as of a day, an item's life, changes by day", () => {
  outlineHooks.afterWrite = (v, summary) => void commitOutline(v, "lf", summary);
  const r = applyOps(vault, [{ op: "insert", temp: "h", place: { parent: tk("WORK-001") }, item: { text: "history root", check: " " } }], MON);
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
  assert.match(text, /- WORK-001 · Old ticket \^\w+\n  - \[x\] #android send the build · done 2026-10-09 17:00 \^L6\n    > sent to QA\n  - \[ \] #android QA check · from Lena · by 2026-10-14 · after L6 · opened 2026-10-10 09:00 \^L7\n/);
  cmdOutlineMigrate(v2, {});
  assert.equal(fs.readFileSync(path.join(v2, "outline.md"), "utf8"), text, "a second run changes nothing");
  assert.match(fs.readFileSync(path.join(v2, "loops.md"), "utf8"), /^- \[ \] L7 · 2026-10-10 09:00 · WORK-001 · #android · QA check · from Lena · by 2026-10-14 · after L6$/m);
});

// ---------- found in review ----------

test("checking off stamps done with the date on the line; unchecking takes it away; history sees a check, not a rewording", () => {
  const v4 = path.join(tmp, "vdone");
  cmdInit(v4, { localPrefix: "WORK" });
  cmdCreate(v4, "WORK", "Done dates", {});
  const r = applyOps(v4, [
    { op: "ticket", key: "WORK-001", temp: "t" },
    { op: "insert", temp: "s", place: { parent: "t" }, item: { text: "plain step", check: " " } },
    { op: "insert", temp: "w", place: { parent: "t" }, item: { text: "wait · from Tom · by tomorrow", check: " " } },
  ], MON);
  commitOutline(v4, "test", ["two items"]);
  const TUE = new Date(2026, 9, 13, 9, 30);
  applyOps(v4, [{ op: "check", id: r.ids.s, check: "x" }], TUE);
  const item = (id: string) => readModel(v4).o.byRef.get(id)!;
  assert.equal(item(r.ids.s).text, "plain step · done 2026-10-13 09:30");
  assert.equal(doneOf(item(r.ids.s).text).text, "plain step");
  commitOutline(v4, "test", ["check"]);
  const kinds = itemHistory(v4, r.ids.s).map((e) => e.kind);
  assert.deepEqual(kinds, ["added", "checked"], "the stamp is part of the check");

  applyOps(v4, [{ op: "check", id: r.ids.s, check: " " }], TUE);
  assert.equal(item(r.ids.s).text, "plain step", "unchecked: no done date");

  closeLoop(v4, r.ids.w, "Tom said yes", new Date(2026, 9, 14, 16, 5));
  const w = item(r.ids.w);
  assert.match(w.text, / · done 2026-10-14 16:05$/);
  const l = loopOf(w, { closed: true })!;
  assert.equal(l.text, "wait", "done is a field, not part of the loop's text");
  assert.equal(l.done, "2026-10-14 16:05");
  assert.equal(withDone("сделать · сделано 2026-10-01", null), "сделать", "the Russian marker is read too");
});

test("loops.md by hand: [x] checks the item off and keeps its children; a dropped id is the same loop; an outline edit beats a deletion", () => {
  const v3 = path.join(tmp, "v3");
  cmdInit(v3, { localPrefix: "WORK" });
  cmdCreate(v3, "WORK", "Hand", {});
  const lf = (rel: string): string => path.join(v3, rel);
  const a = addLoop(v3, { text: "close me by hand", key: "WORK-001", by: "+1d" }, MON);
  applyOps(v3, [{ op: "insert", place: { parent: a.id }, item: { text: "child kept", check: " " } }], MON);
  fs.writeFileSync(lf("loops.md"), fs.readFileSync(lf("loops.md"), "utf8").replace(`- [ ] ^${a.id}`, `- [x] ^${a.id}`));
  const m = readModel(v3);
  assert.equal(m.o.byRef.get(a.id)!.check, "x", "checked off, not deleted");
  assert.ok(m.o.items.some((i) => i.text === "child kept"));

  const b = addLoop(v3, { text: "lost its id", key: "WORK-001", by: "+1d" }, MON);
  fs.writeFileSync(lf("loops.md"), fs.readFileSync(lf("loops.md"), "utf8").replace(`^${b.id} · `, ""));
  assert.ok(readModel(v3).o.byRef.has(b.id), "the line without its id is still that loop");
  assert.equal(readLoops(v3).filter((l) => l.text === "lost its id").length, 1);

  const c = addLoop(v3, { text: "edited in outline", key: "WORK-001", by: "+1d" }, MON);
  fs.writeFileSync(lf("outline.md"), fs.readFileSync(lf("outline.md"), "utf8").replace("edited in outline", "edited in outline, then"));
  fs.writeFileSync(lf("loops.md"), fs.readFileSync(lf("loops.md"), "utf8").split("\n").filter((l) => !l.includes(`^${c.id} `)).join("\n"));
  assert.ok(readModel(v3).o.byRef.has(c.id), "changed in the outline since the last write: the deletion does not apply");
});

test("operations validate what they write: no new lines from context, ids and checks are checked", () => {
  const before = read("outline.md");
  applyOps(vault, [{ op: "insert", place: { parent: tk("WORK-001") }, item: { text: "safe", check: " ", context: ["c\n## PROJ-9 · evil\n- [ ] sneaky ^s2s2"] } }], MON);
  assert.doesNotMatch(read("outline.md"), /^ *- PROJ-9/m);
  assert.notEqual(read("outline.md"), before);
  assert.throws(() => applyOps(vault, [{ op: "insert", place: { parent: tk("WORK-001") }, item: { id: "a b\n", text: "x", check: " " } }], MON), /Not an id/);
  assert.throws(() => applyOps(vault, [{ op: "insert", place: { parent: tk("WORK-001") }, item: { text: "x", check: "foo" as never } }], MON), /check is/);
  const r = applyOps(vault, [{ op: "insert", temp: "n", place: { parent: tk("WORK-001") }, item: { text: "[x] typed as a note", check: null } }], MON);
  assert.equal(readModel(vault).o.byRef.get(r.ids.n)!.check, "x", "a note typed with a box becomes that task");
  assert.throws(() => applyOps(vault, [{ op: "move", id: r.ids.n, place: { after: r.ids.n } }], MON), /after itself/);
  assert.throws(() => applyOps(vault, [{ op: "ticket", title: "  " }], MON), /needs a title/);
  assert.throws(() => applyOps(vault, [{ op: "ticket", key: "not a key" }], MON), /Not a ticket key/);
});

test("format edge cases: CRLF files, hand-indented siblings, a by that is not a date, an id-less item moved to another ticket", () => {
  const crlf = parseOutline("# Outline\r\n\r\n- A-1 · T ^t2t2\r\n  - [ ] foo ^f2f2\r\n");
  assert.equal(crlf.items.length, 2);
  assert.equal(crlf.items[1].text, "foo");
  const odd = parseOutline("## A-1\n- [ ] p ^a2a2\n    - [ ] deep ^b2b2\n  - [ ] shallow ^c2c2\n");
  const added = parseOutline(outlineText(insertItem(odd, { parent: "a2a2" }, { id: "d2d2", check: " ", text: "new" })));
  assert.equal(added.byRef.get("d2d2")!.parent!.ref, "a2a2", "appended at the last sibling's indentation");
  const notLoop = parseOutline("- A-1\n  - [ ] foo · by tomorrow ^f2f2\n");
  assert.equal(loopOf(notLoop.items[1]), null, "an unreadable by typed by hand is not a loop");

  const v4 = path.join(tmp, "v4");
  cmdInit(v4, { localPrefix: "WORK" });
  fs.writeFileSync(path.join(v4, "outline.md"), "- A-1 · one\n  - [ ] no id yet\n\n- B-2 · two\n  - [ ] other\n");
  const id = readModel(v4).o.items[1].ref;
  applyOps(v4, [{ op: "move", id, place: { parent: tk("B-2", v4) } }, { op: "text", id, text: "no id yet, moved" }], MON);
  const after = readModel(v4).o;
  assert.equal(after.byRef.get(id)!.text, "no id yet, moved", "the id survives the move to another ticket");
  assert.equal(after.byRef.get(id)!.key, "B-2");
});
