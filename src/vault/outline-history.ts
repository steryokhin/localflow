// The outline's history, read from the vault's git: every write of outline.md is committed (the CLI
// at once, the web UI after a pause, hand edits by `lf watch` and the running UI), so any day can be
// shown as it was, and an item or a ticket can be followed from its first line to now.
//
// Items are followed by their "^id", which never changes: an item that was moved, reworded,
// checked off or given children is still the same item.

import path from "node:path";
import { readTextIfExists } from "../util.ts";
import { commitPaths, fileVersions } from "./git.ts";
import { fmtDay } from "./loopfields.ts";
import { OUTLINE_FILE, ancestors, parseOutline, sectionRef } from "./outline.ts";
import type { Item, Outline, Section } from "./outline.ts";
import { LOOPS_FILE } from "./outline-store.ts";

export const OUTLINE_COMMIT_PREFIX = "outline";

/** Commits outline.md and loops.md (nothing else) if they changed. Returns the sha or null. */
export function commitOutline(vault: string, source: string, summary: string[]): string | null {
  const head = summary.length ? summary.slice(0, 3).join("; ") + (summary.length > 3 ? `; +${summary.length - 3} more` : "") : "edit";
  const body = summary.length > 3 ? `\n\n${summary.map((s) => `- ${s}`).join("\n")}` : "";
  return commitPaths(vault, [OUTLINE_FILE, LOOPS_FILE], `${OUTLINE_COMMIT_PREFIX} (${source}): ${head.slice(0, 200)}${body}`);
}

export interface Version {
  /** null for the working tree when it differs from the last commit. */
  sha: string | null;
  date: string;
  subject: string;
  o: Outline;
}

let cache: { key: string; versions: Version[] } | null = null;

/** Every committed version of outline.md, oldest first, plus the uncommitted one when it differs. */
export function versions(vault: string, now = new Date()): Version[] {
  const committed = fileVersions(vault, OUTLINE_FILE);
  const current = readTextIfExists(path.join(vault, OUTLINE_FILE));
  const last = committed[committed.length - 1];
  const key = `${vault}\0${last?.sha ?? ""}\0${committed.length}\0${current ?? ""}`;
  if (cache?.key === key) return cache.versions;
  const out: Version[] = committed.map((v) => ({ sha: v.sha, date: v.date, subject: v.subject, o: parseOutline(v.text) }));
  if (current !== null && current !== (last?.text ?? null)) {
    out.push({ sha: null, date: localIso(now), subject: "not committed yet", o: parseOutline(current) });
  }
  cache = { key, versions: out };
  return out;
}

function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${fmtDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

/** The outline as it was at the end of `day` (YYYY-MM-DD); today and later is the current file. */
export function outlineAt(vault: string, day: string, now = new Date()): Version | null {
  const all = versions(vault, now);
  if (day >= fmtDay(now)) {
    const current = readTextIfExists(path.join(vault, OUTLINE_FILE));
    return current === null ? null : { sha: null, date: localIso(now), subject: "now", o: parseOutline(current) };
  }
  let found: Version | null = null;
  for (const v of all) if (v.sha && v.date.slice(0, 10) <= day) found = v;
  return found;
}

// ---------- changes between two versions ----------

export type EventKind = "added" | "removed" | "checked" | "unchecked" | "edited" | "moved" | "note" | "task" | "section-added" | "section-closed" | "section-reopened" | "section-removed" | "section-renamed";

export interface OutlineEvent {
  date: string;
  sha: string | null;
  subject: string;
  kind: EventKind;
  /** The item's id, or the section's ref for section events. */
  ref: string;
  key: string | null;
  /** The section's heading text. */
  section: string;
  text: string;
  /** The text before an edit, the old place before a move. */
  was?: string;
  /** Ids of the item's parents, outermost first (as of the newer version). */
  parents: string[];
  /** Texts of the item's parents. */
  path: string[];
}

const where = (it: Item): string => [it.section.key ?? it.section.title, ...ancestors(it).map((a) => a.text)].join(" › ");
const heading = (s: Section): string => (s.key ? `${s.key}${s.title ? ` · ${s.title}` : ""}` : s.title);

/** What changed from `a` to `b`, item by item. */
export function diffOutlines(a: Outline | null, b: Outline, at: { date: string; sha: string | null; subject: string }): OutlineEvent[] {
  const out: OutlineEvent[] = [];
  const ev = (kind: EventKind, it: Item, extra: Partial<OutlineEvent> = {}): void => {
    const anc = ancestors(it);
    out.push({
      ...at, kind, ref: it.ref, key: it.section.key, section: heading(it.section), text: it.text,
      parents: anc.map((p) => p.ref), path: anc.map((p) => p.text), ...extra,
    });
  };
  const sec = (kind: EventKind, s: Section, was?: string): void => {
    out.push({ ...at, kind, ref: sectionRef(s), key: s.key, section: heading(s), text: heading(s), parents: [], path: [], ...(was ? { was } : {}) });
  };
  const oldSections = new Map((a?.sections ?? []).map((s) => [sectionRef(s), s] as const));
  for (const s of b.sections) {
    const old = oldSections.get(sectionRef(s));
    if (!old) sec("section-added", s);
    else {
      if (old.closed !== s.closed) sec(s.closed ? "section-closed" : "section-reopened", s);
      if (old.title !== s.title && s.key) sec("section-renamed", s, old.title);
    }
  }
  const newSections = new Set(b.sections.map(sectionRef));
  for (const s of a?.sections ?? []) if (!newSections.has(sectionRef(s))) sec("section-removed", s);

  for (const it of b.items) {
    const old = a?.byRef.get(it.ref);
    if (!old) {
      ev("added", it);
      continue;
    }
    if (old.check !== it.check) {
      if (it.check === "x") ev("checked", it);
      else if (old.check === "x" && it.check === " ") ev("unchecked", it);
      else ev("task", it, { was: old.check === null ? "note" : "task" });
    }
    if (old.text !== it.text) ev("edited", it, { was: old.text });
    if (old.context.join("\n") !== it.context.join("\n")) ev("note", it, { was: old.context.join("\n") });
    if ((old.parent?.ref ?? null) !== (it.parent?.ref ?? null) || sectionRef(old.section) !== sectionRef(it.section)) ev("moved", it, { was: where(old) });
  }
  for (const it of a?.items ?? []) {
    if (!b.byRef.has(it.ref)) {
      const anc = ancestors(it);
      out.push({ ...at, kind: "removed", ref: it.ref, key: it.section.key, section: heading(it.section), text: it.text, parents: anc.map((p) => p.ref), path: anc.map((p) => p.text) });
    }
  }
  return out;
}

/** Every change, oldest first. */
export function allEvents(vault: string, now = new Date()): OutlineEvent[] {
  const vs = versions(vault, now);
  const out: OutlineEvent[] = [];
  let prev: Outline | null = null;
  for (const v of vs) {
    out.push(...diffOutlines(prev, v.o, { date: v.date, sha: v.sha, subject: v.subject }));
    prev = v.o;
  }
  return out;
}

/** The life of one item: its own changes and, with `children`, everything that happened under it. */
export function itemHistory(vault: string, ref: string, opts: { children?: boolean } = {}, now = new Date()): OutlineEvent[] {
  const id = ref.replace(/^\^/, "");
  return allEvents(vault, now).filter((e) => e.ref === id || (opts.children !== false && e.parents.includes(id)));
}

/** The life of a ticket's part of the outline. */
export function ticketHistory(vault: string, key: string, now = new Date()): OutlineEvent[] {
  const k = key.toUpperCase();
  return allEvents(vault, now).filter((e) => e.key === k);
}

/** Changes grouped by day (local date of the commit), oldest first; `since`/`until` are YYYY-MM-DD. */
export function changesByDay(vault: string, opts: { since?: string; until?: string } = {}, now = new Date()): Array<{ day: string; events: OutlineEvent[] }> {
  const days = new Map<string, OutlineEvent[]>();
  for (const e of allEvents(vault, now)) {
    const day = e.date.slice(0, 10);
    if ((opts.since && day < opts.since) || (opts.until && day > opts.until)) continue;
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return [...days.entries()].map(([day, events]) => ({ day, events }));
}

/** Ids of items checked off on or after `since` (YYYY-MM-DD), for the standup lens. */
export function checkedSince(vault: string, since: string, now = new Date()): Set<string> {
  return new Set(allEvents(vault, now).filter((e) => e.kind === "checked" && e.date.slice(0, 10) >= since).map((e) => e.ref));
}
