// Smart groups: views across projects and the user's own groups.
//   mine     — assigned to me in Jira (local tickets are always mine)
//   tracked  — `tracked: true` in notes.md (lf track, a loop, lf start, a first note)
//   activity — mine or tracked, with unread changes from Jira
//   waiting  — has an open loop where someone else owes the next move

import type { Loop } from "./loops.ts";
import { ME } from "./loops.ts";
import { isTracked } from "./notes.ts";
import type { Ticket } from "./store.ts";

export const SMART_GROUPS = ["activity", "mine", "tracked", "waiting"] as const;
export type SmartGroup = (typeof SMART_GROUPS)[number];
const CLOSED = ["done", "archived"];

export const isMine = (t: Ticket): boolean => t.fm.mine !== false;
export const isOpen = (t: Ticket): boolean => !CLOSED.includes(t.status);

/** Ticket key -> its open loops waiting on someone else, earliest first as in loops.md. */
export function waitingByKey(loops: Loop[]): Map<string, Loop[]> {
  const out = new Map<string, Loop[]>();
  for (const l of loops) if (l.key && l.owner !== ME) out.set(l.key, [...(out.get(l.key) ?? []), l]);
  return out;
}

export function inSmartGroup(group: SmartGroup, t: Ticket, unread: boolean, waiting: Map<string, Loop[]>): boolean {
  switch (group) {
    case "mine":
      return isMine(t) && isOpen(t);
    case "tracked":
      return isTracked(t) && isOpen(t);
    case "activity":
      return unread && (isMine(t) || isTracked(t));
    case "waiting":
      return waiting.has(t.key);
  }
}

// ---------- smart folders ----------
// Self-contained views over the whole vault, defined in localflow.json ("smartFolders") on top of
// built-in defaults. A filter is a plain AND of terms, each optionally negated; nothing is evaluated:
//   mine · tracked · unread · hasLoops · waiting · jira · local · jira:<category|status> ·
//   local:<status> · project:<KEY>        e.g. "mine and jira and not jira:done"

export interface SmartFolderDef {
  name: string;
  icon?: string;
  filter: string;
  /** Drops a built-in folder of the same name. */
  hidden?: boolean;
}

export const DEFAULT_SMART_FOLDERS: SmartFolderDef[] = [
  { name: "Activity", icon: "✦", filter: "unread and mine or unread and tracked" },
  { name: "My Jira", icon: "◉", filter: "mine and jira and not jira:done" },
  { name: "Tracking", icon: "☆", filter: "tracked and not local:done and not local:archived" },
  { name: "Waiting", icon: "⏳", filter: "waiting" },
  { name: "No loops", icon: "❓", filter: "tracked and not hasLoops and not local:done and not local:archived" },
];

/** What a filter term sees of a ticket. */
export interface SmartFacts {
  unread: boolean;
  /** Open loops of the ticket (any owner). */
  loops: Loop[];
}

type Term = { not: boolean; test: (t: Ticket, f: SmartFacts) => boolean };

const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");

function term(word: string): Term["test"] {
  const [head, ...rest] = word.split(":");
  const arg = rest.join(":");
  if (!arg) {
    switch (head.toLowerCase()) {
      case "mine": return (t) => isMine(t);
      case "tracked": return (t) => isTracked(t);
      case "unread": return (_t, f) => f.unread;
      case "hasloops": return (_t, f) => f.loops.length > 0;
      case "waiting": return (_t, f) => f.loops.some((l) => l.owner !== ME);
      case "jira": return (t) => t.source === "jira";
      case "local": return (t) => t.source === "local";
    }
  } else {
    const want = norm(arg);
    switch (head.toLowerCase()) {
      // Matches the status category ("todo", "inprogress", "done") or the status name ("in review").
      case "jira": return (t) => t.source === "jira" && [t.fm.jira_status_category, t.fm.jira_status].some((v) => norm(String(v ?? "")) === want);
      case "local": return (t) => t.status === want;
      case "project": return (t) => t.project.toLowerCase() === arg.toLowerCase();
    }
  }
  throw new Error(`unknown term "${word}"`);
}

/**
 * Parses "a and not b or c and d": AND binds tighter than OR, "not" negates one term. Throws on
 * anything else, so a typo in the config shows up instead of silently matching nothing.
 */
export function parseSmartFilter(filter: string): (t: Ticket, f: SmartFacts) => boolean {
  const words = filter.trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("empty filter");
  const alts: Term[][] = [[]];
  let not = false;
  let expectTerm = true;
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw === "not") {
      if (!expectTerm || not) throw new Error(`"not" in the wrong place`);
      not = true;
    } else if (lw === "and" || lw === "or") {
      if (expectTerm) throw new Error(`"${lw}" in the wrong place`);
      if (lw === "or") alts.push([]);
      expectTerm = true;
    } else {
      if (!expectTerm) throw new Error(`missing "and" before "${w}"`);
      alts[alts.length - 1].push({ not, test: term(w) });
      not = false;
      expectTerm = false;
    }
  }
  if (expectTerm) throw new Error("the filter ends with an operator");
  return (t, f) => alts.some((all) => all.every((x) => x.test(t, f) !== x.not));
}

export interface SmartFolder {
  id: string;
  name: string;
  icon: string;
  filter: string;
  /** Set when the filter does not parse; the folder then matches nothing. */
  error?: string;
  test: (t: Ticket, f: SmartFacts) => boolean;
}

const folderId = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "folder";

/** Built-ins, with config entries of the same name replacing them and new names appended. */
export function smartFolders(defs: SmartFolderDef[] | undefined): SmartFolder[] {
  const merged = [...DEFAULT_SMART_FOLDERS];
  for (const d of Array.isArray(defs) ? defs : []) {
    if (!d || typeof d.name !== "string" || !d.name.trim()) continue;
    const at = merged.findIndex((m) => m.name.toLowerCase() === d.name.trim().toLowerCase());
    const def = { ...d, name: d.name.trim(), filter: typeof d.filter === "string" ? d.filter : "" };
    if (at >= 0) merged[at] = { ...merged[at], ...def };
    else merged.push(def);
  }
  const seen = new Set<string>();
  return merged
    .filter((d) => !d.hidden)
    .map((d) => {
      let id = folderId(d.name);
      while (seen.has(id)) id += "-";
      seen.add(id);
      const base = { id, name: d.name, icon: d.icon || "◇", filter: d.filter };
      try {
        return { ...base, test: parseSmartFilter(d.filter) };
      } catch (e) {
        return { ...base, error: (e as Error).message, test: () => false };
      }
    });
}

/** Ticket key -> all its open loops. */
export function loopsByKey(loops: Loop[]): Map<string, Loop[]> {
  const out = new Map<string, Loop[]>();
  for (const l of loops) if (l.key) out.set(l.key, [...(out.get(l.key) ?? []), l]);
  return out;
}
