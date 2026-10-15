// Dates typed in words (src/serve/ui/when.js, the Outline editor's Todoist-like date reading).
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../src/serve/ui/when.js");
const W = (globalThis as unknown as { LFWhen: {
  find(text: string, now?: Date, opts?: { skip?: string[] }): { start: number; end: number; phrase: string; due: string } | null;
  parse(text: string, now?: Date): string | null;
  cut(text: string, f: { start: number; end: number }): string;
  label(due: string, now?: Date): string;
} }).LFWhen;

// Thursday 15 October 2026, 14:30.
const now = new Date(2026, 9, 15, 14, 30);
const due = (text: string): string | null => W.find(text, now)?.due ?? null;

test("days and times in words, English and Russian", () => {
  assert.equal(due("call Jim today"), "2026-10-15");
  assert.equal(due("call Jim tomorrow 18:00"), "2026-10-16 18:00");
  assert.equal(due("call Jim tomorrow at 9:05"), "2026-10-16 09:05");
  assert.equal(due("позвонить завтра в 10:00"), "2026-10-16 10:00");
  assert.equal(due("послезавтра"), "2026-10-17");
  assert.equal(due("ревью сегодня"), "2026-10-15");
  assert.equal(due("demo fri"), "2026-10-16");
  assert.equal(due("demo thursday"), "2026-10-22", "the same weekday is next week's");
  assert.equal(due("демо в пятницу"), "2026-10-16");
  assert.equal(due("демо в понедельник 11:00"), "2026-10-19 11:00");
  assert.equal(due("ship next week"), "2026-10-19");
  assert.equal(due("ping in 3 days"), "2026-10-18");
  assert.equal(due("ping in 2 hours"), "2026-10-15 16:30");
  assert.equal(due("пинг через неделю"), "2026-10-22");
  assert.equal(due("пинг через 3 дня"), "2026-10-18");
  assert.equal(due("пинг через час"), "2026-10-15 15:30");
  assert.equal(due("ping +2d"), "2026-10-17");
  assert.equal(due("ping eod"), "2026-10-15 18:00");
  assert.equal(due("standup 6pm"), "2026-10-15 18:00");
  assert.equal(due("standup 18:00"), "2026-10-15 18:00");
  assert.equal(due("standup 9:00"), "2026-10-16 09:00", "a time already past is tomorrow's");
});

test("written dates", () => {
  assert.equal(due("release 24.03.2027"), "2027-03-24");
  assert.equal(due("release 24.03.27 18:00"), "2027-03-24 18:00");
  assert.equal(due("release 24.10"), "2026-10-24");
  assert.equal(due("release 24.03"), "2027-03-24", "already past this year: next year");
  assert.equal(due("release 2026-11-02"), "2026-11-02");
  assert.equal(due("release 24 March"), "2027-03-24");
  assert.equal(due("релиз 5 ноября"), "2026-11-05");
  assert.equal(due("release Nov 5, 2027"), "2027-11-05");
});

test("what is not a date", () => {
  for (const t of ["iOS 26.1 crash", "bump to 2.1.10", "v24.03.1", "1.5 points", "today's build", "sat with Tom",
    "the sun is out", "31.02", "build 25:00", "18:00-19:00 call", ""]) {
    assert.equal(due(t), null, t);
  }
  assert.equal(due("demo on sat"), "2026-10-17");
  assert.equal(W.find("tomorrow and fri", now, { skip: ["tomorrow"] })?.due, "2026-10-16");
});

test("the phrase is cut out of the text", () => {
  const f = W.find("call Jim tomorrow 18:00 about the build", now)!;
  assert.equal(f.phrase, "tomorrow 18:00");
  assert.equal(W.cut("call Jim tomorrow 18:00 about the build", f), "call Jim about the build");
  const g = W.find("call Jim, by tomorrow", now)!;
  assert.equal(W.cut("call Jim, by tomorrow", g), "call Jim");
});

test("the picker reads the whole input as a date", () => {
  assert.equal(W.parse("tomorrow 18:00", now), "2026-10-16 18:00");
  assert.equal(W.parse("sat", now), "2026-10-17");
  assert.equal(W.parse("2026-10-20 9:00", now), "2026-10-20 09:00");
  assert.equal(W.parse("call tomorrow", now), null);
  assert.equal(W.parse("", now), null);
  assert.equal(W.label("2026-10-16 18:00", now), "tomorrow 18:00");
  assert.equal(W.label("2026-10-20", now), "Tue 20 Oct");
  assert.equal(W.label("2027-03-24", now), "Wed 24 Mar 2027");
});
