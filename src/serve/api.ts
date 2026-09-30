// Data layer behind the web UI: plain functions over the vault, no HTTP here.
// Everything the page shows or changes goes through these, so they are what the tests cover.

import fs from "node:fs";
import path from "node:path";
import { PROJECTS_DIR, STATE_DIR, loadConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { LOCAL_STATUSES } from "../jira/mapping.ts";
import { diffBlocks } from "../render/blockdiff.ts";
import type { DiffBlock } from "../render/blockdiff.ts";
import { jiraAhead, priorityOf, refreshInbox } from "../render/inbox.ts";
import { renderBlock, splitBlocks } from "../render/markdown.ts";
import { UserError, readTextIfExists, slugify, today, writeFileAtomic } from "../util.ts";
import { dumpFrontmatter, parseFrontmatter, setFrontmatterKeys } from "../vault/frontmatter.ts";
import type { Frontmatter } from "../vault/frontmatter.ts";
import { git, head, log } from "../vault/git.ts";
import { SYNC_SUBJECT_PREFIX, loadState, saveState, unreadByTicket } from "../vault/state.ts";
import type { State } from "../vault/state.ts";
import { NOTES_FILE, SYNC_OWNED, TICKET_FILE, listTickets, requireTicket } from "../vault/store.ts";
import type { Ticket } from "../vault/store.ts";

export const NOTES_DIR = "notes";
const EVENT_LINE_RE = /^([A-Z][A-Z0-9_]*-\d+): (.+)$/;

// ---------- paths ----------

/** Normalizes a vault-relative path and refuses anything outside the user-visible tree. */
export function safeRel(rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\/+/, "");
  const parts = norm.split("/");
  if (!norm || norm === "." || parts.includes("..") || parts.some((p) => p.startsWith(".") && p !== ".")) {
    throw new UserError(`Not a valid vault path: ${rel}`);
  }
  if (parts[0] === STATE_DIR || parts[0] === ".git") throw new UserError(`Not a valid vault path: ${rel}`);
  return norm;
}

function isUserEditable(vault: string, rel: string): boolean {
  const parts = rel.split("/");
  if (!rel.endsWith(".md")) return false;
  if (parts[0] === NOTES_DIR) return parts.length >= 2;
  if (parts[0] === PROJECTS_DIR && parts.length === 4) {
    const name = parts[3];
    if (name === TICKET_FILE) {
      const text = readTextIfExists(path.join(vault, rel));
      return text !== null && parseFrontmatter(text).data.source === "local";
    }
    return !SYNC_OWNED.includes(name);
  }
  return false;
}

// ---------- overview ----------

export interface TicketRow {
  key: string;
  project: string;
  source: "jira" | "local";
  title: string;
  type: string;
  status: string;
  jiraStatus: string | null;
  jiraCategory: string | null;
  ahead: string | null;
  priority: string;
  assignee: string;
  mine: boolean;
  unread: number;
  updated: string | null;
}

export interface NoteNode {
  name: string;
  rel: string;
  dir: boolean;
  children?: NoteNode[];
}

export interface Overview {
  vault: string;
  lastSync: string | null;
  tickets: TicketRow[];
  notes: NoteNode[];
  statuses: readonly string[];
  localPrefixes: string[];
}

function row(t: Ticket, config: Config, unread: number): TicketRow {
  return {
    key: t.key,
    project: t.project,
    source: t.source,
    title: t.title,
    type: String(t.fm.type ?? ""),
    status: t.status,
    jiraStatus: t.source === "jira" ? String(t.fm.jira_status ?? "") : null,
    jiraCategory: t.source === "jira" ? String(t.fm.jira_status_category ?? "") : null,
    ahead: jiraAhead(t, config),
    priority: priorityOf(t),
    assignee: String(t.fm.assignee ?? ""),
    mine: t.fm.mine !== false,
    unread,
    updated: t.fm.updated ? String(t.fm.updated) : null,
  };
}

function notesTree(vault: string, rel: string): NoteNode[] {
  const abs = path.join(vault, rel);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => {
      const r = `${rel}/${e.name}`;
      return e.isDirectory() ? { name: e.name, rel: r, dir: true, children: notesTree(vault, r) } : { name: e.name, rel: r, dir: false };
    });
}

export function overview(vault: string): Overview {
  const config = loadConfig(vault);
  const state = loadState(vault);
  const unread = unreadByTicket(vault, state);
  return {
    vault,
    lastSync: state.lastSync,
    tickets: listTickets(vault).map((t) => row(t, config, unread.get(t.key)?.length ?? 0)),
    notes: notesTree(vault, NOTES_DIR),
    statuses: LOCAL_STATUSES,
    localPrefixes: Object.entries(config.projects).filter(([, p]) => p.source === "local").map(([name]) => name),
  };
}

// ---------- ticket ----------

export interface HistoryEvent {
  sha: string;
  date: string;
  text: string;
  unread: boolean;
  /** "sync" or "import". */
  via: string;
}

export function ticketHistory(vault: string, state: State, key: string): HistoryEvent[] {
  const commits = log(vault);
  const seenSha = state.seen[key];
  const seenAt = seenSha === undefined ? undefined : commits.findIndex((c) => c.sha === seenSha);
  const out: HistoryEvent[] = [];
  commits.forEach((c, i) => {
    if (!c.subject.startsWith(SYNC_SUBJECT_PREFIX)) return;
    for (const line of c.body.split("\n")) {
      const m = EVENT_LINE_RE.exec(line.trim());
      if (!m || m[1] !== key) continue;
      const unread = seenAt === undefined || seenAt < 0 || i < seenAt;
      out.push({ sha: c.sha, date: c.date, text: m[2], unread, via: /\(import\)/.test(c.subject) ? "import" : "sync" });
    }
  });
  return out;
}

export interface RenderedBlock {
  html: string;
  state: DiffBlock["state"];
  was?: string;
}

export interface TicketView {
  row: TicketRow;
  rel: string;
  fm: Frontmatter;
  notes: Frontmatter;
  files: string[];
  blocks: RenderedBlock[];
  unread: HistoryEvent[];
  seenDate: string | null;
}

function ticketUrlResolver(rel: string): (url: string) => string {
  return (url) => (/^[a-z]+:|^\/|^#/i.test(url) ? url : `/raw/${rel.split("/").map(encodeURIComponent).join("/")}/${url.split("/").map(encodeURIComponent).join("/")}`);
}

function oldTicketText(vault: string, rel: string, sha: string | undefined): string | null {
  if (!sha) return null;
  try {
    return git(vault, ["show", `${sha}:${rel}/${TICKET_FILE}`]);
  } catch {
    return null;
  }
}

/** Blocks of ticket.md worth showing: the H1 and the meta line are already in the page header. */
function ticketBody(text: string): string {
  const blocks = splitBlocks(parseFrontmatter(text).body);
  if (blocks[0]?.startsWith("# ")) blocks.shift();
  if (blocks[0]?.startsWith("[")) blocks.shift();
  return blocks.join("\n\n");
}

export function ticketView(vault: string, rawKey: string): TicketView {
  const config = loadConfig(vault);
  const state = loadState(vault);
  const t = requireTicket(vault, rawKey);
  const history = ticketHistory(vault, state, t.key);
  const unread = history.filter((e) => e.unread);
  const text = readTextIfExists(path.join(t.dir, TICKET_FILE)) ?? "";
  const seenSha = state.seen[t.key];
  // Highlight only when there is something unread and a baseline to compare with.
  const old = unread.length && seenSha ? oldTicketText(vault, t.rel, seenSha) : null;
  const resolveUrl = ticketUrlResolver(t.rel);
  const blocks = diffBlocks(old === null ? null : ticketBody(old), ticketBody(text)).map((b) => ({
    html: renderBlock(b.src, { resolveUrl }),
    state: b.state,
    ...(b.was ? { was: renderBlock(b.was, { resolveUrl }) } : {}),
  }));
  const files = fs
    .readdirSync(t.dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && !SYNC_OWNED.includes(e.name))
    .map((e) => e.name)
    .sort((a, b) => (a === NOTES_FILE ? -1 : b === NOTES_FILE ? 1 : a.localeCompare(b)));
  const seenCommit = seenSha ? log(vault).find((c) => c.sha === seenSha) : undefined;
  return {
    row: row(t, config, unread.length),
    rel: t.rel,
    fm: t.fm,
    notes: t.notes,
    files,
    blocks,
    unread,
    seenDate: seenCommit?.date ?? null,
  };
}

export function markSeen(vault: string, rawKey: string): void {
  const sha = head(vault);
  if (!sha) throw new UserError("The vault has no commits yet.");
  const t = requireTicket(vault, rawKey);
  const state = loadState(vault);
  state.seen[t.key] = sha;
  saveState(vault, state);
  refreshInbox(vault);
}

export function setStatus(vault: string, rawKey: string, status: string): void {
  if (!(LOCAL_STATUSES as readonly string[]).includes(status)) throw new UserError(`Unknown status "${status}".`);
  const t = requireTicket(vault, rawKey);
  const notesPath = path.join(t.dir, NOTES_FILE);
  const text = readTextIfExists(notesPath) ?? dumpFrontmatter({ ticket: t.key, status }) + `\n# ${t.key} — notes\n\n`;
  const updates: Record<string, string> = { status };
  if (status === "inprogress" && parseFrontmatter(text).data.taken === undefined) updates.taken = today();
  writeFileAtomic(notesPath, setFrontmatterKeys(text, updates));
  refreshInbox(vault);
}

// ---------- files ----------

export interface FileView {
  rel: string;
  editable: boolean;
  fm: Frontmatter;
  /** Body without frontmatter, as blocks. */
  blocks: Array<{ src: string; html: string }>;
  /** Raw frontmatter text (kept verbatim on save). */
  head: string;
}

const FM_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function fileView(vault: string, rawRel: string): FileView {
  const rel = safeRel(rawRel);
  const text = readTextIfExists(path.join(vault, rel));
  if (text === null) throw new UserError(`No such file: ${rel}`);
  const m = FM_RE.exec(text);
  const body = m ? text.slice(m[0].length) : text;
  const resolveUrl = rel.startsWith(`${PROJECTS_DIR}/`) ? ticketUrlResolver(rel.split("/").slice(0, 3).join("/")) : undefined;
  return {
    rel,
    editable: isUserEditable(vault, rel),
    fm: parseFrontmatter(text).data,
    blocks: splitBlocks(body).map((src) => ({ src, html: renderBlock(src, { resolveUrl }) })),
    head: m ? m[0] : "",
  };
}

export function renderOne(src: string, rel: string): string {
  const safe = safeRel(rel);
  const resolveUrl = safe.startsWith(`${PROJECTS_DIR}/`) ? ticketUrlResolver(safe.split("/").slice(0, 3).join("/")) : undefined;
  return renderBlock(src, { resolveUrl });
}

export function saveFile(vault: string, rawRel: string, body: string, headText: string): void {
  const rel = safeRel(rawRel);
  if (!isUserEditable(vault, rel)) throw new UserError(`${rel} is not editable here.`);
  const normalized = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n";
  writeFileAtomic(path.join(vault, rel), headText + normalized);
  if (rel.endsWith(`/${NOTES_FILE}`)) refreshInbox(vault);
}

export function setFrontmatter(vault: string, rawRel: string, updates: Record<string, string>): void {
  const rel = safeRel(rawRel);
  if (!isUserEditable(vault, rel)) throw new UserError(`${rel} is not editable here.`);
  const file = path.join(vault, rel);
  const text = readTextIfExists(file);
  if (text === null) throw new UserError(`No such file: ${rel}`);
  if (updates.status !== undefined && !(LOCAL_STATUSES as readonly string[]).includes(updates.status)) {
    throw new UserError(`Unknown status "${updates.status}".`);
  }
  writeFileAtomic(file, setFrontmatterKeys(text, updates));
  if (rel.endsWith(`/${NOTES_FILE}`)) refreshInbox(vault);
}

function cleanName(raw: string): string {
  const base = raw.trim().replace(/\.md$/i, "");
  const name = /^[\p{L}\p{N}_ .-]+$/u.test(base) ? base.replace(/\s+/g, "-") : slugify(base);
  if (!name || name.startsWith(".")) throw new UserError("File name is empty.");
  return name;
}

/** New user file in a ticket folder. Returns the vault-relative path. */
export function createTicketFile(vault: string, rawKey: string, rawName: string): string {
  const t = requireTicket(vault, rawKey);
  const name = cleanName(rawName);
  if (SYNC_OWNED.includes(name) || SYNC_OWNED.includes(`${name}.md`)) throw new UserError(`"${name}" is reserved for the sync.`);
  const file = path.join(t.dir, `${name}.md`);
  if (fs.existsSync(file)) throw new UserError(`${name}.md already exists.`);
  writeFileAtomic(file, dumpFrontmatter({ ticket: t.key, type: "Note", created: today() }) + `\n# ${t.key} — ${rawName.trim().replace(/\.md$/i, "")}\n\n`);
  return `${t.rel}/${name}.md`;
}

/** New plain note under notes/ (folder may be nested; created on demand). */
export function createNote(vault: string, rawFolder: string, rawName: string): string {
  const folder = rawFolder ? safeRel(path.posix.join(NOTES_DIR, rawFolder)) : NOTES_DIR;
  if (folder !== NOTES_DIR && !folder.startsWith(`${NOTES_DIR}/`)) throw new UserError("Notes live under notes/.");
  const name = cleanName(rawName);
  const rel = `${folder}/${name}.md`;
  const file = path.join(vault, rel);
  if (fs.existsSync(file)) throw new UserError(`${rel} already exists.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, dumpFrontmatter({ created: today() }) + `\n# ${rawName.trim().replace(/\.md$/i, "")}\n\n`);
  return rel;
}

/** Absolute path for a raw file (attachments, images) or null when outside the vault tree. */
export function rawFilePath(vault: string, rawRel: string): string | null {
  let rel: string;
  try {
    rel = safeRel(rawRel);
  } catch {
    return null;
  }
  const abs = path.join(vault, rel);
  if (!abs.startsWith(vault + path.sep)) return null;
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}
