// Lenses over the outline: one tree, several ways to look at it. A lens picks items; every picked
// item is shown with all its parents and its section heading, the rest is hidden. Plus the terminal
// rendering of the tree and of its history.

import { ME, dueAt, fmtDay } from "../vault/loopfields.ts";
import { ancestors, sectionRef } from "../vault/outline.ts";
import type { Item, Outline, Section } from "../vault/outline.ts";
import type { OutlineEvent } from "../vault/outline-history.ts";
import { loopOf } from "../vault/outline-store.ts";
import { fmtDue, fmtSpan, lastWorkingDay } from "./loops.ts";

export const LENSES = ["all", "active", "today", "waiting", "expired", "standup"] as const;
export type Lens = (typeof LENSES)[number];

export interface LensOptions {
  /** Items checked off since the last working day (from the history), for "standup". */
  checkedSince?: Set<string>;
  /** Only this ticket's section. */
  key?: string;
  /** Text search: items whose text or context contains it (case-insensitive). */
  query?: string;
}

const endOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();

/** Done, or under something done. */
function doneish(it: Item): boolean {
  for (let p: Item | null = it; p; p = p.parent) if (p.check === "x") return true;
  return false;
}

export function lensMatch(it: Item, lens: Lens, now: Date, opts: LensOptions = {}): boolean {
  const loop = loopOf(it);
  const at = loop ? dueAt(loop.due)?.getTime() ?? Infinity : Infinity;
  switch (lens) {
    case "all":
      return true;
    case "active":
      return !doneish(it) && !it.section.closed;
    case "today":
      return !!loop && at <= endOfDay(now);
    case "waiting":
      return !!loop && loop.owner !== ME;
    case "expired":
      return !!loop && at <= now.getTime();
    case "standup":
      return (opts.checkedSince?.has(it.ref) ?? false) || (!!loop && ((loop.owner === ME && at <= endOfDay(now)) || loop.owner !== ME));
  }
}

export interface Visible {
  items: Set<string>;
  sections: Set<string>;
  /** How many items matched the lens itself (not counting the parents shown with them). */
  matched: number;
}

/** What a lens shows: the matches, their parents and their sections. */
export function visibleFor(o: Outline, lens: Lens, now: Date, opts: LensOptions = {}): Visible {
  const items = new Set<string>();
  const sections = new Set<string>();
  const q = opts.query?.trim().toLowerCase();
  let matched = 0;
  for (const it of o.items) {
    if (opts.key && it.section.key !== opts.key.toUpperCase()) continue;
    if (!lensMatch(it, lens, now, opts)) continue;
    if (q && !`${it.text}\n${it.context.join("\n")}`.toLowerCase().includes(q)) continue;
    matched++;
    items.add(it.ref);
    for (const a of ancestors(it)) items.add(a.ref);
    sections.add(sectionRef(it.section));
  }
  // Empty sections (a ticket with nothing written yet) show in the views that are about open work.
  if (!q && (lens === "all" || lens === "active")) {
    for (const s of o.sections) {
      if (opts.key && s.key !== opts.key.toUpperCase()) continue;
      if (lens === "active" && s.closed) continue;
      if (lens === "all" || !s.items.length) sections.add(sectionRef(s));
    }
  }
  return { items, sections, matched };
}

export function standupSince(now: Date): string {
  return fmtDay(lastWorkingDay(now));
}

// ---------- terminal ----------

function loopNote(it: Item, now: Date): string {
  const l = loopOf(it, { closed: true });
  if (!l) return "";
  if (it.check === "x") return "";
  const at = dueAt(l.due);
  if (at && at.getTime() <= now.getTime()) return `  ← expired ${fmtSpan(now.getTime() - at.getTime())} ago`;
  return "";
}

function displayText(it: Item, now: Date): string {
  const l = loopOf(it, { closed: true });
  if (!l) return it.text;
  const parts = [l.tag && l.tag !== null && it.text.startsWith(`#${l.tag} `) ? `#${l.tag} ${l.text}` : l.text];
  if (l.owner !== ME) parts.push(`from ${l.owner}`);
  if (l.due) parts.push(`by ${fmtDue(l.due, now)}`);
  if (l.onExpiry) parts.push(`else: ${l.onExpiry}`);
  return parts.join(" · ");
}

const GLYPH: Record<string, string> = { " ": "○", x: "✓", null: "•" };

export function renderOutline(o: Outline, now: Date, opts: { visible?: Visible; ids?: boolean; context?: boolean } = {}): string {
  const out: string[] = [];
  const show = (it: Item): boolean => !opts.visible || opts.visible.items.has(it.ref);
  const walk = (items: Item[], depth: number): void => {
    for (const it of items) {
      if (!show(it)) continue;
      const pad = "  ".repeat(depth + 1);
      out.push(`${pad}${GLYPH[String(it.check)]} ${displayText(it, now)}${opts.ids !== false ? `  ^${it.ref}` : ""}${loopNote(it, now)}`);
      if (opts.context !== false) for (const c of it.context) out.push(`${pad}    > ${c}`);
      walk(it.children, depth + 1);
    }
  };
  for (const s of o.sections) {
    if (opts.visible && !opts.visible.sections.has(sectionRef(s))) continue;
    out.push(`## ${s.key ? `${s.key}${s.title ? ` · ${s.title}` : ""}` : s.title}${s.closed ? " ✓" : ""}`);
    const before = out.length;
    walk(s.items, 0);
    if (out.length === before) out.push("  (nothing yet)");
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

const KIND_MARK: Record<string, string> = {
  added: "+", removed: "−", checked: "✓", unchecked: "↺", edited: "✎", moved: "→", note: ">", task: "○",
  "section-added": "#", "section-closed": "✓", "section-reopened": "↺", "section-removed": "−", "section-renamed": "✎",
};

export function eventLine(e: OutlineEvent): string {
  const mark = KIND_MARK[e.kind] ?? "·";
  const under = e.path.length ? `   (under: ${e.path[e.path.length - 1]})` : "";
  switch (e.kind) {
    case "edited":
      return `${mark} ${e.text}   (was: ${e.was})`;
    case "moved":
      return `${mark} ${e.text}   (moved from: ${e.was})`;
    case "note":
      return `${mark} note on "${e.text}": ${e.was ? "edited" : "added"}`;
    case "added":
      return `${mark} ${e.text}${under}`;
    case "section-renamed":
      return `${mark} ${e.text}   (was: ${e.was})`;
    default:
      return `${mark} ${e.text}`;
  }
}

/** A history as days, times and changes, oldest first. */
export function renderHistory(title: string, events: OutlineEvent[]): string {
  if (!events.length) return `${title}\n\nNo changes recorded yet (the history starts with the first commit of outline.md).\n`;
  const out = [`${title} — ${events.length} change${events.length === 1 ? "" : "s"}, ${events[0].date.slice(0, 10)} → ${events[events.length - 1].date.slice(0, 10)}`];
  let day = "";
  for (const e of events) {
    const d = e.date.slice(0, 10);
    if (d !== day) {
      out.push("", d);
      day = d;
    }
    out.push(`  ${e.sha ? e.date.slice(11, 16) : "now  "}  ${eventLine(e)}`);
  }
  return out.join("\n") + "\n";
}

export function sectionTitle(s: Section): string {
  return s.key ? `${s.key}${s.title ? ` · ${s.title}` : ""}` : s.title;
}
