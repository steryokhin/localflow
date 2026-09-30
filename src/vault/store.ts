import fs from "node:fs";
import path from "node:path";
import { PROJECTS_DIR } from "../config.ts";
import { compareKeys } from "../jira/mapping.ts";
import { UserError, readTextIfExists, slugify } from "../util.ts";
import { dumpFrontmatter, parseFrontmatter } from "./frontmatter.ts";
import type { Frontmatter } from "./frontmatter.ts";

export const TICKET_FILE = "ticket.md";
export const NOTES_FILE = "notes.md";
export const RAW_DIR = "raw";
export const RAW_FILE = "raw/issue.json";
/** Names inside a ticket folder owned by the sync; everything else belongs to the user. */
export const SYNC_OWNED = ["ticket.md", "attachments", "raw"];

const KEY_RE = /^([A-Z][A-Z0-9_]*-\d+)(?:-|$)/;
export const KEY_ONLY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

export interface Ticket {
  key: string;
  project: string;
  /** Absolute path of the ticket folder. */
  dir: string;
  /** Path of the ticket folder relative to the vault, with forward slashes. */
  rel: string;
  source: "jira" | "local";
  title: string;
  /** ticket.md frontmatter. */
  fm: Frontmatter;
  /** notes.md frontmatter. */
  notes: Frontmatter;
  /** The user's own workflow status (from notes.md). */
  status: string;
}

export function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

function readTicket(vault: string, project: string, dirName: string): Ticket | null {
  const m = KEY_RE.exec(dirName);
  if (!m) return null;
  const dir = path.join(vault, PROJECTS_DIR, project, dirName);
  const ticketText = readTextIfExists(path.join(dir, TICKET_FILE));
  if (ticketText === null) return null;
  const fm = parseFrontmatter(ticketText).data;
  const notes = parseFrontmatter(readTextIfExists(path.join(dir, NOTES_FILE)) ?? "").data;
  return {
    key: m[1],
    project,
    dir,
    rel: `${PROJECTS_DIR}/${project}/${dirName}`,
    source: fm.source === "local" ? "local" : "jira",
    title: String(fm.title ?? ""),
    fm,
    notes,
    status: String(notes.status ?? "inbox"),
  };
}

export function listTickets(vault: string): Ticket[] {
  const root = path.join(vault, PROJECTS_DIR);
  const out: Ticket[] = [];
  if (!fs.existsSync(root)) return out;
  for (const project of fs.readdirSync(root)) {
    const projectDir = path.join(root, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const dirName of fs.readdirSync(projectDir)) {
      const t = readTicket(vault, project, dirName);
      if (t) out.push(t);
    }
  }
  return out.sort((a, b) => compareKeys(a.key, b.key));
}

/** Locate a ticket folder by key without reading every ticket. */
export function findTicketDirName(vault: string, key: string): string | null {
  const projectDir = path.join(vault, PROJECTS_DIR, projectOf(key));
  if (!fs.existsSync(projectDir)) return null;
  return fs.readdirSync(projectDir).find((name) => name === key || name.startsWith(`${key}-`)) ?? null;
}

export function findTicket(vault: string, key: string): Ticket | null {
  const dirName = findTicketDirName(vault, key);
  return dirName ? readTicket(vault, projectOf(key), dirName) : null;
}

export function requireTicket(vault: string, rawKey: string): Ticket {
  const key = rawKey.toUpperCase();
  if (!KEY_ONLY_RE.test(key)) throw new UserError(`Not a ticket key: ${rawKey}`);
  const t = findTicket(vault, key);
  if (!t) throw new UserError(`Ticket ${key} not found in ${vault}`);
  return t;
}

/** Folder for a ticket: the existing one, or `KEY-slug` for a new ticket. The name never changes afterwards. */
export function ticketRel(vault: string, key: string, title: string): string {
  const existing = findTicketDirName(vault, key);
  const slug = slugify(title);
  return `${PROJECTS_DIR}/${projectOf(key)}/${existing ?? (slug ? `${key}-${slug}` : key)}`;
}

export function notesStub(key: string, status: string): string {
  return dumpFrontmatter({ ticket: key, status }) + `\n# ${key} — notes\n\n`;
}
