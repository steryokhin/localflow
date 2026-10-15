// Lenses over the outline: one tree, several ways to look at it. A lens picks items; every picked
// item is shown with all its parents, the rest is hidden. Plus the terminal
// rendering of the tree and of its history.

import { ME, dueAt, fmtDay } from "../vault/loopfields.ts";
import { ancestors } from "../vault/outline.ts";
import type { Item, Outline } from "../vault/outline.ts";
import type { OutlineEvent } from "../vault/outline-history.ts";
import { loopOf } from "../vault/outline-store.ts";
import { fmtDue, fmtSpan, lastWorkingDay } from "./loops.ts";

export const LENSES = ["all", "active", "today", "waiting", "expired", "standup"] as const;
export type Lens = (typeof LENSES)[number];

export interface LensOptions {
  /** Items checked off since the last working day (from the history), for "standup". */
  checkedSince?: Set<string>;
  /** Only this ticket: its item and everything under it. */
  key?: string;
  /** Text search: items whose text or context contains it (case-insensitive). */
  query?: string;
}

const endOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();

/** Done, or under something done (a checked task or a closed ticket). */
function doneish(it: Item): boolean {
  for (let p: Item | null = it; p; p = p.parent) if (p.check === "x" || p.ticket?.closed) return true;
  return false;
}

/** The item is the ticket's or under it (nested tickets included). */
export function under(it: Item, key: string): boolean {
  const k = key.toUpperCase();
  for (let p: Item | null = it; p; p = p.parent) if (p.ticket?.key === k) return true;
  return false;
}

export function lensMatch(it: Item, lens: Lens, now: Date, opts: LensOptions = {}): boolean {
  const loop = loopOf(it);
  const at = loop ? dueAt(loop.due)?.getTime() ?? Infinity : Infinity;
  switch (lens) {
    case "all":
      return true;
    case "active":
      return !doneish(it);
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
  /** How many items matched the lens itself (not counting the parents shown with them). */
  matched: number;
}

/** What a lens shows: the matches and their parents. */
export function visibleFor(o: Outline, lens: Lens, now: Date, opts: LensOptions = {}): Visible {
  const items = new Set<string>();
  const q = opts.query?.trim().toLowerCase();
  let matched = 0;
  for (const it of o.items) {
    if (opts.key && !under(it, opts.key)) continue;
    if (!lensMatch(it, lens, now, opts)) continue;
    if (q && !`${it.text}\n${it.context.join("\n")}`.toLowerCase().includes(q)) continue;
    matched++;
    items.add(it.ref);
    for (const a of ancestors(it)) items.add(a.ref);
  }
  return { items, matched };
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
  if (l.onExpiry && it.check !== "x") parts.push(`else: ${l.onExpiry}`);
  if (l.done) parts.push(`done ${l.done}`);
  return parts.join(" · ");
}

const GLYPH: Record<string, string> = { " ": "○", x: "✓", null: "•" };

function glyph(it: Item): string {
  return it.ticket ? (it.ticket.closed ? "◇" : "◆") : GLYPH[String(it.check)];
}

export function renderOutline(o: Outline, now: Date, opts: { visible?: Visible; ids?: boolean; context?: boolean } = {}): string {
  const out: string[] = [];
  const show = (it: Item): boolean => !opts.visible || opts.visible.items.has(it.ref);
  const walk = (items: Item[], depth: number): void => {
    for (const it of items) {
      if (!show(it)) continue;
      const pad = "  ".repeat(depth);
      // A top-level item starts a block: a blank line before it reads better.
      if (depth === 0 && out.length) out.push("");
      out.push(`${pad}${glyph(it)} ${displayText(it, now)}${opts.ids !== false ? `  ^${it.ref}` : ""}${loopNote(it, now)}`);
      if (opts.context !== false) for (const c of it.context) out.push(`${pad}    > ${c}`);
      walk(it.children, depth + 1);
    }
  };
  walk(o.roots, 0);
  return out.join("\n").trimEnd() + "\n";
}

const KIND_MARK: Record<string, string> = {
  added: "+", removed: "−", checked: "✓", unchecked: "↺", edited: "✎", moved: "→", note: ">", task: "○", closed: "◇", reopened: "◆",
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
    case "closed":
      return `${mark} ${e.text.replace(/ ✓$/, "")} closed`;
    case "reopened":
      return `${mark} ${e.text} reopened`;
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

/** Where an item is, for a one-line answer: its ticket (or its top item) and its parent. */
export function placeLine(it: Item): string {
  const anc = ancestors(it);
  return anc.length ? anc.map((a) => a.text).join(" › ") : "the top level";
}
