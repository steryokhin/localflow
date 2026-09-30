// Daily report assembled from the vault's git history and the optional session log.
// No model involved: this is the cheap, deterministic half of "what did I do today".

import path from "node:path";
import { STATE_DIR } from "./config.ts";
import { compareKeys } from "./jira/mapping.ts";
import { readTextIfExists } from "./util.ts";
import { git, head } from "./vault/git.ts";
import { SYNC_SUBJECT_PREFIX } from "./vault/state.ts";
import { NOTES_FILE, listTickets } from "./vault/store.ts";
import type { Ticket } from "./vault/store.ts";

export const SESSIONS_FILE = "sessions.jsonl";

export interface SessionRecord {
  ts: string;
  cwd?: string;
  reason?: string;
  messages?: number;
  prompt?: string;
}

interface DayCommit {
  sha: string;
  time: string;
  subject: string;
  body: string;
  files: string[];
}

function commitsOfDay(vault: string, date: string): DayCommit[] {
  if (!head(vault)) return [];
  const out = git(vault, [
    "log", "--reverse", `--since=${date}T00:00:00`, `--until=${date}T23:59:59`,
    "--name-only", "--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f",
  ]);
  return out
    .split("\x1e")
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [sha, time, subject, body, files] = rec.split("\x1f");
      return { sha, time: time.slice(11, 16), subject, body: body ?? "", files: (files ?? "").split("\n").map((f) => f.trim()).filter(Boolean) };
    });
}

/** Status transitions of notes.md within the day, from the commits' patches. */
function statusChanges(vault: string, date: string): Map<string, string[]> {
  if (!head(vault)) return new Map();
  const patch = git(vault, [
    "log", "--reverse", `--since=${date}T00:00:00`, `--until=${date}T23:59:59`,
    "-p", "--format=", "--", `*/${NOTES_FILE}`,
  ]);
  const out = new Map<string, string[]>();
  let key = "";
  let from = "";
  for (const line of patch.split("\n")) {
    const file = /^\+\+\+ b\/projects\/[^/]+\/([A-Z][A-Z0-9_]*-\d+)[^/]*\/notes\.md$/.exec(line);
    if (file) {
      key = file[1];
      from = "";
      continue;
    }
    const minus = /^-status:\s*(\S+)/.exec(line);
    if (minus) from = minus[1];
    const plus = /^\+status:\s*(\S+)/.exec(line);
    // A "+status" without a "-status" is the stub being created, not a move.
    if (plus && key && from) out.set(key, [...(out.get(key) ?? []), `${from} → ${plus[1]}`]);
  }
  return out;
}

export function readSessions(vault: string, date: string): SessionRecord[] {
  const text = readTextIfExists(path.join(vault, STATE_DIR, SESSIONS_FILE));
  if (!text) return [];
  const out: SessionRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SessionRecord;
      if (rec.ts?.startsWith(date)) out.push(rec);
    } catch {
      // A damaged line must not break the report.
    }
  }
  return out;
}

export function renderReport(vault: string, date: string): string {
  const commits = commitsOfDay(vault, date);
  const tickets = new Map(listTickets(vault).map((t) => [t.key, t]));
  const title = (key: string): string => tickets.get(key)?.title ?? "";
  const lines: string[] = [`# Local Flow — ${date}`, ""];

  // Jira activity: change lines from sync commits, grouped per ticket.
  const jira = new Map<string, string[]>();
  for (const c of commits) {
    if (!c.subject.startsWith(SYNC_SUBJECT_PREFIX)) continue;
    for (const line of c.body.split("\n")) {
      const m = /^([A-Z][A-Z0-9_]*-\d+): (.+)$/.exec(line.trim());
      if (m) jira.set(m[1], [...(jira.get(m[1]) ?? []), `${c.time} ${m[2]}`]);
    }
  }
  lines.push(`## From Jira (${jira.size})`, "");
  if (jira.size === 0) lines.push("_No changes came from Jira._");
  for (const key of [...jira.keys()].sort(compareKeys)) {
    lines.push(`- **${key}** ${title(key)}`);
    for (const e of jira.get(key)!) lines.push(`    - ${e}`);
  }
  lines.push("");

  // My work: status moves, and user files touched by non-sync commits.
  const moves = statusChanges(vault, date);
  const touched = new Map<string, Set<string>>();
  for (const c of commits) {
    if (c.subject.startsWith(SYNC_SUBJECT_PREFIX)) continue;
    for (const f of c.files) {
      const m = /^projects\/[^/]+\/([A-Z][A-Z0-9_]*-\d+)[^/]*\/(.+)$/.exec(f);
      if (m) touched.set(m[1], new Set([...(touched.get(m[1]) ?? []), m[2]]));
    }
  }
  const mine = [...new Set([...moves.keys(), ...touched.keys()])].sort(compareKeys);
  lines.push(`## My work (${mine.length})`, "");
  if (mine.length === 0) lines.push("_No notes or status changes were committed. Uncommitted edits are not counted: run \`lf commit\`._");
  for (const key of mine) {
    const parts = [
      ...(moves.get(key) ?? []).map((m) => `status ${m}`),
      ...(touched.has(key) ? [`edited ${[...touched.get(key)!].sort().join(", ")}`] : []),
    ];
    lines.push(`- **${key}** ${title(key)} — ${parts.join("; ")}`);
  }
  lines.push("");

  const open = [...tickets.values()].filter((t: Ticket) => t.status === "inprogress").sort((a, b) => compareKeys(a.key, b.key));
  lines.push(`## In progress now (${open.length})`, "");
  for (const t of open) lines.push(`- **${t.key}** ${t.title}${t.notes.taken ? ` (since ${t.notes.taken})` : ""}`);
  if (open.length === 0) lines.push("_Nothing in progress._");
  lines.push("");

  const sessions = readSessions(vault, date);
  lines.push(`## Claude Code sessions (${sessions.length})`, "");
  if (sessions.length === 0) lines.push("_No session records (the SessionEnd hook is not installed, or no session ended today)._");
  for (const s of sessions) {
    const when = s.ts.slice(11, 16);
    const cwd = (s.cwd ?? "?").replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
    lines.push(`- ${when} · \`${cwd}\` · ${s.reason ?? "end"} · msgs: ${s.messages ?? "?"} · ${s.prompt ?? "—"}`);
  }
  lines.push("");

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
