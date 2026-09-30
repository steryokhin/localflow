// Local, untracked state (.localflow/): who I am in Jira, field names, and what I have already seen.
// "Unread" is derived from git history: sync commits list per-ticket change lines in their body,
// and a ticket is unread when such lines exist in commits newer than its "seen" commit.

import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config.ts";
import type { JiraUser } from "../jira/api.ts";
import { readTextIfExists, writeFileAtomic } from "../util.ts";
import { log } from "./git.ts";

export interface State {
  me: JiraUser | null;
  lastSync: string | null;
  /** Ticket key -> sha of the vault commit the user has seen. */
  seen: Record<string, string>;
}

const STATE_FILE = "state.json";
const FIELDS_FILE = "fields.json";
export const SYNC_SUBJECT_PREFIX = "sync ";
const EVENT_LINE_RE = /^([A-Z][A-Z0-9_]*-\d+): (.+)$/;

function readJson<T>(vault: string, file: string, fallback: T): T {
  const text = readTextIfExists(path.join(vault, STATE_DIR, file));
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function loadState(vault: string): State {
  const s = readJson<Partial<State>>(vault, STATE_FILE, {});
  return { me: s.me ?? null, lastSync: s.lastSync ?? null, seen: s.seen ?? {} };
}

export function saveState(vault: string, state: State): void {
  fs.mkdirSync(path.join(vault, STATE_DIR), { recursive: true });
  writeFileAtomic(path.join(vault, STATE_DIR, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

export function loadFieldNames(vault: string): Record<string, string> {
  return readJson<Record<string, string>>(vault, FIELDS_FILE, {});
}

export function saveFieldNames(vault: string, names: Record<string, string>): void {
  fs.mkdirSync(path.join(vault, STATE_DIR), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)));
  writeFileAtomic(path.join(vault, STATE_DIR, FIELDS_FILE), JSON.stringify(sorted, null, 2) + "\n");
}

export interface UnreadEvent {
  sha: string;
  date: string;
  text: string;
}

/** Ticket key -> unseen change events, oldest first. */
export function unreadByTicket(vault: string, state: State): Map<string, UnreadEvent[]> {
  const commits = log(vault);
  const position = new Map(commits.map((c, i) => [c.sha, i]));
  const out = new Map<string, UnreadEvent[]>();
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i];
    if (!c.subject.startsWith(SYNC_SUBJECT_PREFIX)) continue;
    for (const line of c.body.split("\n")) {
      const m = EVENT_LINE_RE.exec(line.trim());
      if (!m) continue;
      const seenSha = state.seen[m[1]];
      const seenAt = seenSha === undefined ? undefined : position.get(seenSha);
      // Newer commits have a smaller index; an unknown sha means history was rewritten.
      if (seenAt !== undefined && i >= seenAt) continue;
      out.set(m[1], [...(out.get(m[1]) ?? []), { sha: c.sha, date: c.date.slice(0, 10), text: m[2] }]);
    }
  }
  return out;
}
