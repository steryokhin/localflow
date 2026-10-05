// Folders outside the vault linked to a ticket: `linked_folders:` in notes.md, a list of absolute
// paths. The key is written only here (by `lf link`/`lf unlink` and the web UI, which call the same
// functions) or by hand; the sync never touches it. The folders themselves are not ours: they are
// only listed and read, never written, and no git runs in them.

import fs from "node:fs";
import path from "node:path";
import { UserError, expandHome, readTextIfExists, writeFileAtomic } from "../util.ts";
import { removeFrontmatterKeys, setFrontmatterKeys } from "./frontmatter.ts";
import type { Frontmatter } from "./frontmatter.ts";
import { NOTES_FILE, notesStub, requireTicket } from "./store.ts";
import type { Ticket } from "./store.ts";

export const LINKED_KEY = "linked_folders";
/** Linked files larger than this are not rendered. */
const MAX_LINKED_FILE = 2 * 1024 * 1024;

/** The ticket's linked folders as written (a hand-written scalar counts as one entry). */
export function linkedFolders(notes: Frontmatter): string[] {
  const v = notes[LINKED_KEY];
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((p) => String(p ?? "").trim()).filter(Boolean);
}

/** Absolute (`~` expanded), normalized, without a trailing slash: the form stored in notes.md and compared on unlink. */
function normalize(rawPath: string): string {
  const p = expandHome(rawPath.trim());
  if (!p) throw new UserError("Folder path is empty.");
  if (!path.isAbsolute(p)) throw new UserError(`Not an absolute path: ${p}`);
  const norm = path.resolve(p);
  return norm.length > 1 ? norm.replace(/[\\/]+$/, "") : norm;
}

function writeLinked(t: Ticket, list: string[]): void {
  const notesPath = path.join(t.dir, NOTES_FILE);
  const text = readTextIfExists(notesPath) ?? notesStub(t.key, t.status);
  // The last unlink removes the key instead of leaving `linked_folders: []` behind.
  writeFileAtomic(notesPath, list.length ? setFrontmatterKeys(text, { [LINKED_KEY]: list }) : removeFrontmatterKeys(text, [LINKED_KEY]));
}

/** Adds an existing directory to the ticket's linked folders. Returns false when it was already linked. */
export function linkFolder(vault: string, rawKey: string, rawPath: string): { key: string; path: string; added: boolean } {
  const t = requireTicket(vault, rawKey);
  const p = normalize(rawPath);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new UserError(`No such folder: ${p}`);
  }
  if (!st.isDirectory()) throw new UserError(`Not a folder: ${p}`);
  const list = linkedFolders(t.notes);
  if (list.some((x) => x === p)) return { key: t.key, path: p, added: false };
  writeLinked(t, [...list, p]);
  return { key: t.key, path: p, added: true };
}

/** Removes a folder from the ticket's linked folders. The folder itself does not have to exist any more. */
export function unlinkFolder(vault: string, rawKey: string, rawPath: string): { key: string; path: string } {
  const t = requireTicket(vault, rawKey);
  const p = normalize(rawPath);
  const list = linkedFolders(t.notes);
  // Entries written by hand may carry a trailing slash: compare normalized.
  const rest = list.filter((x) => {
    try {
      return normalize(x) !== p;
    } catch {
      return x !== rawPath.trim();
    }
  });
  if (rest.length === list.length) throw new UserError(`${p} is not linked to ${t.key}.`);
  writeLinked(t, rest);
  return { key: t.key, path: p };
}

// ---------- reading ----------

export interface LinkedFile {
  name: string;
  /** Absolute path. */
  path: string;
}

export interface LinkedFolder {
  path: string;
  name: string;
  /** Why the folder cannot be listed (missing, not a folder, unreadable), or null. */
  error: string | null;
  files: LinkedFile[];
}

/** Lists each linked folder's immediate files, read from disk on every call (no snapshot). */
export function readLinkedFolders(notes: Frontmatter): LinkedFolder[] {
  return linkedFolders(notes).map((p) => {
    const folder: LinkedFolder = { path: p, name: path.basename(p) || p, error: null, files: [] };
    let names: string[];
    try {
      names = fs
        .readdirSync(p, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {
      const code = (e as { code?: string }).code;
      folder.error = code === "ENOENT" ? "folder not found" : code === "ENOTDIR" ? "not a folder" : "cannot be read";
      return folder;
    }
    folder.files = names.map((name) => ({ name, path: path.join(p, name) }));
    return folder;
  });
}

/**
 * Text of a file in one of the ticket's linked folders. Only immediate, non-hidden regular files of
 * a linked folder are served (symlinks pointing elsewhere are refused), so linking a folder never
 * opens the rest of the disk to the web UI.
 */
export function readLinkedFile(vault: string, rawKey: string, rawFile: string): string {
  const t = requireTicket(vault, rawKey);
  const file = path.resolve(rawFile);
  if (path.basename(file).startsWith(".")) throw new UserError(`Not shown: ${file}`);
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    throw new UserError(`No such file: ${file}`);
  }
  const inLinked = linkedFolders(t.notes).some((p) => {
    try {
      return path.dirname(real) === fs.realpathSync(p);
    } catch {
      return false;
    }
  });
  if (!inLinked) throw new UserError(`${file} is not in a folder linked to ${t.key}.`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new UserError(`Not a file: ${file}`);
  if (st.size > MAX_LINKED_FILE) throw new UserError(`${path.basename(file)} is larger than 2 MB: open it in your editor.`);
  const buf = fs.readFileSync(real);
  if (buf.includes(0)) throw new UserError(`${path.basename(file)} is a binary file: open it in your editor.`);
  return buf.toString("utf8");
}
