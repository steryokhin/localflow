// Open loops: loops.md format, deadlines, closing into the ticket Log, the board, watch, standup.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCreate, cmdInit } from "../src/commands.ts";
import { bucket, idleTickets, lastWorkingDay, renderActions, renderStandup } from "../src/render/loops.ts";
import { addLoop, bumpLoop, closeLoop, dueAt, parseWhen, readLoops, syncLoops } from "../src/vault/loops.ts";
import { appendToSection, readLog, setTracked } from "../src/vault/notes.ts";
import { findTicket, listTickets } from "../src/vault/store.ts";
import { isQuiet, watchOnce } from "../src/watch.ts";
import { loadConfig } from "../src/config.ts";

let tmp: string;
let vault: string;
const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), "utf8");
const notes = (key: string): string => fs.readFileSync(path.join(findTicket(vault, key)!.dir, "notes.md"), "utf8");
// Monday 12 Oct 2026, 11:00 local time.
const MON = new Date(2026, 9, 12, 11, 0);
const idOf = (text: string): string => readLoops(vault).find((l) => l.text === text)!.id;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-loops-")));
  vault = path.join(tmp, "vault");
  console.log = () => {};
  cmdInit(vault, { localPrefix: "WORK" });
  cmdCreate(vault, "WORK", "Swipe fix", {});
  cmdCreate(vault, "WORK", "Docs", {});
  cmdCreate(vault, "WORK", "Quiet one", {});
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("parseWhen reads relative, clock, keyword and date deadlines", () => {
  assert.equal(parseWhen("+4h", MON), "2026-10-12 15:00");
  assert.equal(parseWhen("+30m", MON), "2026-10-12 11:30");
  assert.equal(parseWhen("+2d", MON), "2026-10-14 11:00");
  assert.equal(parseWhen("18:00", MON), "2026-10-12 18:00");
  assert.equal(parseWhen("9:15", MON), "2026-10-13 09:15", "a time already past today means tomorrow");
  assert.equal(parseWhen("eod", MON), "2026-10-12 18:00");
  assert.equal(parseWhen("eod", MON, "17:30"), "2026-10-12 17:30");
  assert.equal(parseWhen("tomorrow", MON), "2026-10-13");
  assert.equal(parseWhen("2026-10-14", MON), "2026-10-14");
  assert.equal(parseWhen("2026-10-14 9:05", MON), "2026-10-14 09:05");
  assert.throws(() => parseWhen("next week", MON), /Cannot read/);
  assert.throws(() => parseWhen("25:00", MON), /Not a time/);
  assert.equal(dueAt("2026-10-14")!.getHours(), 23, "a date alone lasts the whole day");
});

test("appendToSection adds to the end of a section and leaves the rest alone", () => {
  const text = "---\nticket: A-1\n---\n\n# A-1 — notes\n\nfree text\n\n## Log\n\n- 2026-10-01 — first\n\n## Decisions\n\n- keep it\n";
  assert.equal(
    appendToSection(text, "Log", "- 2026-10-02 — second"),
    "---\nticket: A-1\n---\n\n# A-1 — notes\n\nfree text\n\n## Log\n\n- 2026-10-01 — first\n- 2026-10-02 — second\n\n## Decisions\n\n- keep it\n",
  );
  assert.equal(appendToSection("# T\n\nbody\n", "Log", "- x"), "# T\n\nbody\n\n## Log\n\n- x\n");
  assert.equal(appendToSection("## Log\n## Decisions\n", "Log", "- x"), "## Log\n\n- x\n\n## Decisions\n");
  assert.deepEqual(readLog("## Log\n\n- 2026-10-02 09:00 — a\n- not dated\n- 2026-10-03 — b\n\n## Other\n- 2026-10-04 — c\n"), [
    { date: "2026-10-02", time: "09:00", text: "a" },
    { date: "2026-10-03", time: "", text: "b" },
  ]);
});

test("lf loop writes one line per loop, tracks the ticket, and closing logs it", () => {
  const a = addLoop(vault, { text: "PR #41 review", key: "work-001", owner: "Tom", by: "18:00", onExpiry: "ping in #ios-reviews" }, MON);
  assert.match(a.id, /^[a-z][2-9][a-z][2-9]$/, "new ids are short and random, like Bike's");
  assert.match(read("loops.md"), new RegExp(`^- \\[ \\] \\^${a.id} · 2026-10-12 11:00 · WORK-001 · PR #41 review · from Tom · by 2026-10-12 18:00 · else: ping in #ios-reviews$`, "m"));
  assert.match(read("outline.md"), new RegExp(`^## WORK-001 · Swipe fix\n- \\[ \\] PR #41 review · from Tom · by 2026-10-12 18:00 · else: ping in #ios-reviews · opened 2026-10-12 11:00 \\^${a.id}$`, "m"));
  assert.match(notes("WORK-001"), /^tracked: true$/m);
  const b = addLoop(vault, { text: "Istio docs · onboarding", by: "2026-10-15" }, MON);
  assert.equal(b.owner, "me");
  assert.match(read("loops.md"), new RegExp(`\\^${b.id} · 2026-10-12 11:00 · — · Istio docs - onboarding · from me · by 2026-10-15$`, "m"), "the separator never leaks into text");

  const closed = closeLoop(vault, a.id, "Tom approved, 2 comments", new Date(2026, 9, 12, 17, 40));
  assert.equal(closed.loggedTo, `${findTicket(vault, "WORK-001")!.rel}/notes.md`);
  assert.doesNotMatch(read("loops.md"), new RegExp(`${a.id} ·`));
  assert.match(read("outline.md"), new RegExp(`^- \\[x\\] PR #41 review .*\\^${a.id}$`, "m"), "a closed loop stays in the outline, checked off");
  assert.match(notes("WORK-001"), new RegExp(`## Log\\n\\n- 2026-10-12 17:40 — Tom approved, 2 comments \\(${a.id}: PR #41 review, from Tom\\)\\n$`));

  closeLoop(vault, "istio", "", new Date(2026, 9, 12, 18, 0));
  assert.match(read("loops-archive.md"), new RegExp(`^# Closed loops without a ticket\\n\\n- 2026-10-12 18:00 — done \\(${b.id}: Istio docs - onboarding\\)\\n$`));
  const c = addLoop(vault, { text: "next", by: "+1h" }, MON);
  assert.ok(![a.id, b.id].includes(c.id), "closed ids are not reused: they stay in the outline");
  closeLoop(vault, c.id, "", MON);
});

test("loops are found by id or by a word; ambiguous and too-short queries are refused", () => {
  addLoop(vault, { text: "QA feedback on build 1.0.4", key: "WORK-001", owner: "Lena", by: "tomorrow" }, MON);
  addLoop(vault, { text: "QA sign-off", key: "WORK-002", owner: "Lena", by: "+2d" }, MON);
  assert.throws(() => closeLoop(vault, "qa", "", MON), /at least 3 letters/);
  assert.throws(() => closeLoop(vault, "lena", "", MON), /matches 2 loops/);
  assert.throws(() => closeLoop(vault, "L99", "", MON), /at least 3 letters|No open loop/);
  const r = bumpLoop(vault, "sign-off", "2026-10-20 12:00", MON);
  assert.equal(r.was, "2026-10-14 11:00");
  assert.match(notes("WORK-002"), new RegExp(`- 2026-10-12 11:00 — ${idOf("QA sign-off")} moved to 2026-10-20 12:00 \\(was 2026-10-14 11:00\\): QA sign-off`));
});

test("hand-written lines are understood (Russian markers too); reads never write, the next write stores the id", () => {
  fs.appendFileSync(path.join(vault, "loops.md"), "- [ ] 2026-10-12 · — · написал Mark про BFF-кэш · от Mark · до 2026-10-14 · иначе: поднять на дейли\n- [x] done by hand, ignored\n");
  const before = read("loops.md");
  const loops = syncLoops(vault);
  const mark = loops.find((l) => l.owner === "Mark")!;
  assert.match(mark.id, /^[a-z][2-9][a-z][2-9]$/);
  assert.equal(mark.due, "2026-10-14");
  assert.equal(mark.onExpiry, "поднять на дейли");
  assert.equal(read("loops.md"), before, "a read writes nothing");
  assert.equal(syncLoops(vault).find((l) => l.owner === "Mark")!.id, mark.id, "the same id on every read");
  closeLoop(vault, addLoop(vault, { text: "any write", by: "+1h" }, MON).id, "", MON);
  assert.match(read("loops.md"), new RegExp(`^- \\[ \\] \\^${mark.id} · 2026-10-12 · — · написал Mark про BFF-кэш · from Mark · by 2026-10-14 · else: поднять на дейли$`, "m"));
  assert.match(read("loops.md"), /^- \[x\] done by hand, ignored$/m);
  assert.match(read("outline.md"), new RegExp(`^## No ticket\n(- .*\n)*- \\[ \\] написал Mark про BFF-кэш · from Mark · by 2026-10-14 · else: поднять на дейли · opened 2026-10-12 \\^${mark.id}$`, "m"));
});

test("the board puts expired loops first and lists tracked tickets that have nothing going on", () => {
  const loops = readLoops(vault);
  const later = new Date(2026, 9, 14, 12, 0); // Wed: the QA feedback (13 Oct) and Mark (14 Oct, all day) are due
  const b = bucket(loops, later);
  assert.deepEqual(b.expired.map((l) => l.id), [idOf("QA feedback on build 1.0.4")]);
  assert.deepEqual(b.today.map((l) => l.id), [idOf("написал Mark про BFF-кэш")]);
  assert.deepEqual(b.waiting.map((l) => l.id), [idOf("QA sign-off")]);

  setTracked(findTicket(vault, "WORK-003")!, true);
  assert.deepEqual(idleTickets(listTickets(vault), loops).map((t) => t.key), ["WORK-003"]);
  fs.writeFileSync(path.join(findTicket(vault, "WORK-003")!.dir, "actions.md"), "# Plan\n\n- [ ] step one\n");
  assert.deepEqual(idleTickets(listTickets(vault), loops).map((t) => t.key), ["WORK-003"], "a plan is not a loop: the ticket still needs one");

  const board = renderActions(loops, listTickets(vault), later);
  assert.match(board, new RegExp(`## 🐸 Expired \\(1\\)\\n\\n- ${idOf("QA feedback on build 1.0.4")} · WORK-001 · QA feedback on build 1\.0\.4 · from Lena · was due 13 Oct, \\d+h ago`));
  assert.ok(board.indexOf("Expired") < board.indexOf("Due today") && board.indexOf("Due today") < board.indexOf("Waiting on people"));
});

test("watch writes NUDGES.md and notifies once per loop and deadline, never in quiet hours", () => {
  const calls: string[] = [];
  const notifier = (_t: string, m: string): boolean => (calls.push(m), true);
  const wed = new Date(2026, 9, 14, 12, 0);
  const r = watchOnce(vault, wed, { notifier });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^Expired — Lena: QA feedback on build 1\.0\.4 \(WORK-001\)$/m);
  assert.match(read("NUDGES.md"), /## Expired \(1\)/);
  assert.match(read("ACTIONS.md"), /# Loops — Wed 14 Oct 2026/);
  assert.deepEqual(r.fresh.expired.map((l) => l.id), [idOf("QA feedback on build 1.0.4")]);

  watchOnce(vault, new Date(2026, 9, 14, 12, 15), { notifier });
  assert.equal(calls.length, 1, "already announced");

  const night = new Date(2026, 9, 14, 23, 30); // Mark's all-day deadline has passed, but it is quiet hours
  const q = watchOnce(vault, night, { notifier });
  assert.ok(q.quiet);
  assert.equal(calls.length, 1);
  watchOnce(vault, new Date(2026, 9, 15, 9, 0), { notifier });
  assert.equal(calls.length, 2, "announced once the quiet hours are over");
  assert.match(calls[1], /Mark/);

  bumpLoop(vault, idOf("QA feedback on build 1.0.4"), "2026-10-15 09:30", new Date(2026, 9, 15, 9, 0));
  watchOnce(vault, new Date(2026, 9, 15, 9, 5), { notifier });
  assert.equal(calls.length, 3, "a moved deadline is announced again");
  assert.match(calls[2], /^Soon — Lena/);
  assert.match(read(".gitignore"), /^\/ACTIONS\.md$/m);
});

test("quiet hours wrap past midnight and cover weekends", () => {
  const config = loadConfig(vault);
  assert.equal(isQuiet(new Date(2026, 9, 12, 7, 59), config), true);
  assert.equal(isQuiet(new Date(2026, 9, 12, 8, 0), config), false);
  assert.equal(isQuiet(new Date(2026, 9, 12, 20, 0), config), true);
  assert.equal(isQuiet(new Date(2026, 9, 17, 12, 0), config), true, "Saturday");
  assert.equal(isQuiet(new Date(2026, 9, 17, 12, 0), { ...config, loops: { quietWeekends: false } }), false);
});

test("standup: done since the last working day, my loops for today, waiting and blockers", () => {
  assert.equal(lastWorkingDay(MON).getDate(), 9, "Monday looks back to Friday");
  const thu = new Date(2026, 9, 15, 9, 30);
  const text = renderStandup(vault, readLoops(vault), listTickets(vault), thu, false);
  assert.match(text, new RegExp(`^Standup — Thu 15 Oct\\n\\nDone \\(since Wed 14 Oct\\):\\n- WORK-001: ${idOf("QA feedback on build 1.0.4")} moved to 2026-10-15 09:30`));
  assert.match(text, /Doing today:\n- no loops of mine due today\n/);
  const fri = new Date(2026, 9, 16, 9, 30);
  const week = renderStandup(vault, readLoops(vault), listTickets(vault), fri, true);
  assert.match(week, /- WORK-001 Swipe fix\n    - 10-12 Tom approved, 2 comments/);
  assert.match(week, /Waiting on:\n- Lena: QA sign-off \(WORK-002\) — due 20 Oct 12:00, waiting \d+d/);
  assert.match(week, /Blockers:\n(- .*\n)*- Lena: QA feedback on build 1\.0\.4 \(WORK-001\) — overdue \d+h/);
  assert.match(week, /- Mark: написал Mark про BFF-кэш — overdue/);
});
