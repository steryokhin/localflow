// Small edits inside a user's Markdown file: appending a line to a "## Section" while leaving every
// other byte alone, and reading the dated lines of a "## Log" section back.

import path from "node:path";
import { readTextIfExists, writeFileAtomic } from "../util.ts";
import { removeFrontmatterKeys, setFrontmatterKeys } from "./frontmatter.ts";
import { NOTES_FILE, notesStub } from "./store.ts";
import type { Ticket } from "./store.ts";

export const LOG_SECTION = "Log";
export const DECISIONS_SECTION = "Decisions";

/** Appends `line` at the end of the `## title` section, creating the section at the end of the file. */
export function appendToSection(text: string, title: string, line: string): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start === -1) return `${text.replace(/\s+$/, "")}\n\n## ${title}\n\n${line}\n`;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end === -1) end = lines.length;
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  const insert = at === start + 1 ? ["", line] : [line];
  if (at < lines.length && /^#{1,2} /.test(lines[at])) insert.push("");
  lines.splice(at, 0, ...insert);
  return lines.join("\n") + "\n";
}

export interface LogLine {
  date: string;
  time: string;
  text: string;
}

const LOG_LINE_RE = /^- (\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))? — (.+)$/;

/** Dated lines (`- 2026-10-12 17:40 — text`) of the `## Log` section, in file order. */
export function readLog(text: string): LogLine[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${LOG_SECTION}`);
  if (start === -1) return [];
  const out: LogLine[] = [];
  for (let i = start + 1; i < lines.length && !/^#{1,2} /.test(lines[i]); i++) {
    const m = LOG_LINE_RE.exec(lines[i].trim());
    if (m) out.push({ date: m[1], time: m[2] ?? "", text: m[3] });
  }
  return out;
}

/** Dated lines from any Markdown file of log lines (e.g. loops-archive.md), whatever the section. */
export function readLogLines(text: string): LogLine[] {
  return text
    .split("\n")
    .map((l) => LOG_LINE_RE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ date: m[1], time: m[2] ?? "", text: m[3] }));
}

/** Reads a ticket's notes.md, or its stub when the file does not exist yet. */
export function notesText(t: Ticket): string {
  return readTextIfExists(path.join(t.dir, NOTES_FILE)) ?? notesStub(t.key, t.status);
}

/** Appends a dated line to the ticket's `## Log` (creating notes.md and the section as needed). */
export function appendTicketLog(t: Ticket, stamp: string, text: string): void {
  writeFileAtomic(path.join(t.dir, NOTES_FILE), appendToSection(notesText(t), LOG_SECTION, `- ${stamp} — ${oneLine(text)}`));
}

/** `tracked:` in notes.md: whether the ticket is on the loops board and in the "Tracking" group. */
export function setTracked(t: Ticket, tracked: boolean): void {
  writeFileAtomic(path.join(t.dir, NOTES_FILE), setFrontmatterKeys(notesText(t), { tracked }));
}

/** The ticket's `parent:` in notes.md (the ticket it sits under), or null. */
export function parentKey(t: Ticket): string | null {
  const p = t.notes.parent;
  return typeof p === "string" && p.trim() ? p.trim().toUpperCase() : null;
}

/** Sets or (with null) removes `parent:` in notes.md. */
export function setParentKey(t: Ticket, parent: string | null): void {
  const text = notesText(t);
  writeFileAtomic(path.join(t.dir, NOTES_FILE), parent ? setFrontmatterKeys(text, { parent }) : removeFrontmatterKeys(text, ["parent"]));
}

export function isTracked(t: Ticket): boolean {
  return t.notes.tracked === true;
}

export function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}
