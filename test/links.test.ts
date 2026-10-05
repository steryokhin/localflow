// Linked folders: `linked_folders:` in notes.md, lf link / lf unlink, listing.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cmdCreate, cmdInit } from "../src/commands.ts";
import { fileView, setFrontmatter, ticketView } from "../src/serve/api.ts";
import { parseFrontmatter, setFrontmatterKeys } from "../src/vault/frontmatter.ts";
import { linkFolder, readLinkedFile, readLinkedFolders, unlinkFolder } from "../src/vault/links.ts";
import { findTicket } from "../src/vault/store.ts";

let tmp: string;
let vault: string;
let ext: string;

const notesText = (key: string) => fs.readFileSync(path.join(findTicket(vault, key)!.dir, "notes.md"), "utf8");

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localflow-links-")));
  vault = path.join(tmp, "vault");
  console.log = () => {};
  cmdInit(vault, { localPrefix: "WORK" });
  cmdCreate(vault, "WORK", "First", {});
  cmdCreate(vault, "WORK", "Second", {});
  ext = path.join(tmp, "repo", "docs");
  fs.mkdirSync(ext, { recursive: true });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("setFrontmatterKeys writes and replaces block lists", () => {
  const text = "---\nticket: A-1\nlist:\n  - old\nstatus: inbox\n---\nbody\n";
  const out = setFrontmatterKeys(text, { list: ["/a/b", "/c: d"] });
  assert.equal(out, '---\nticket: A-1\nlist:\n  - /a/b\n  - "/c: d"\nstatus: inbox\n---\nbody\n');
  assert.deepEqual(parseFrontmatter(out).data.list, ["/a/b", "/c: d"]);
});

test("link creates the field, keeps the rest of notes.md, ignores duplicates; unlink of the last entry removes it", () => {
  const before = notesText("WORK-001");
  assert.deepEqual(linkFolder(vault, "work-001", ext + "/"), { key: "WORK-001", path: ext, added: true });
  const linked = notesText("WORK-001");
  assert.ok(linked.includes(`linked_folders:\n  - ${ext}\n`));
  assert.equal(linked.replace(`linked_folders:\n  - ${ext}\n`, ""), before, "only the new key was added");
  assert.equal(linkFolder(vault, "WORK-001", ext).added, false);

  const other = path.join(tmp, "repo");
  linkFolder(vault, "WORK-001", other);
  assert.deepEqual(findTicket(vault, "WORK-001")!.notes.linked_folders, [ext, other]);

  unlinkFolder(vault, "WORK-001", other);
  assert.deepEqual(findTicket(vault, "WORK-001")!.notes.linked_folders, [ext]);
  unlinkFolder(vault, "WORK-001", ext);
  assert.equal(notesText("WORK-001"), before, "no empty list left behind");
});

test("link refuses missing paths, files and relative paths without writing anything", () => {
  const before = notesText("WORK-002");
  const file = path.join(tmp, "plain.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => linkFolder(vault, "WORK-002", path.join(tmp, "nope")), /No such folder/);
  assert.throws(() => linkFolder(vault, "WORK-002", file), /Not a folder/);
  assert.throws(() => linkFolder(vault, "WORK-002", "relative/dir"), /Not an absolute path/);
  assert.throws(() => linkFolder(vault, "WORK-002", "  "), /empty/);
  assert.throws(() => unlinkFolder(vault, "WORK-002", ext), /not linked/);
  assert.equal(notesText("WORK-002"), before);
});

test("unlink works for a folder that no longer exists", () => {
  const gone = path.join(tmp, "gone");
  fs.mkdirSync(gone);
  linkFolder(vault, "WORK-002", gone);
  fs.rmdirSync(gone);
  assert.equal(readLinkedFolders(findTicket(vault, "WORK-002")!.notes)[0].error, "folder not found");
  unlinkFolder(vault, "WORK-002", gone);
  assert.equal(findTicket(vault, "WORK-002")!.notes.linked_folders, undefined);
});

test("listing: immediate files only, fresh on every call", () => {
  const plain = path.join(tmp, "plain-dir");
  fs.mkdirSync(path.join(plain, "sub"), { recursive: true });
  fs.writeFileSync(path.join(plain, "a.md"), "# A\n");
  fs.writeFileSync(path.join(plain, ".hidden"), "x");
  fs.writeFileSync(path.join(plain, "sub", "deep.md"), "x");
  linkFolder(vault, "WORK-002", plain);
  let [folder] = ticketView(vault, "WORK-002").linked;
  assert.deepEqual(folder.files, [{ name: "a.md", path: path.join(plain, "a.md") }]);
  fs.writeFileSync(path.join(plain, "b.md"), "# B\n");
  [folder] = ticketView(vault, "WORK-002").linked;
  assert.deepEqual(folder.files.map((f) => f.name), ["a.md", "b.md"], "re-read, not cached");
  unlinkFolder(vault, "WORK-002", plain);

  fs.writeFileSync(path.join(ext, "clean.md"), "# Clean\n");
  linkFolder(vault, "WORK-002", ext);
});

test("linked files open read-only; files outside linked folders, hidden files and escaping symlinks are refused", () => {
  const view = ticketView(vault, "WORK-002");
  const file = view.linked[0].files.find((f) => f.name === "clean.md")!.path;
  assert.equal(readLinkedFile(vault, "WORK-002", file), "# Clean\n");
  assert.throws(() => readLinkedFile(vault, "WORK-001", file), /not in a folder linked/);
  assert.throws(() => readLinkedFile(vault, "WORK-002", path.join(tmp, "plain.txt")), /not in a folder linked/);
  assert.throws(() => readLinkedFile(vault, "WORK-002", path.join(ext, "..", ".gitignore")), /Not shown/);
  fs.symlinkSync(path.join(tmp, "plain.txt"), path.join(ext, "escape.md"));
  assert.throws(() => readLinkedFile(vault, "WORK-002", path.join(ext, "escape.md")), /not in a folder linked/);
  assert.ok(!ticketView(vault, "WORK-002").linked[0].files.some((f) => f.name === "escape.md"), "symlinks are not listed");
  fs.writeFileSync(path.join(ext, "bin.dat"), Buffer.from([1, 0, 2]));
  assert.throws(() => readLinkedFile(vault, "WORK-002", path.join(ext, "bin.dat")), /binary/);
});

test("linked_folders cannot be set through the generic frontmatter endpoint", () => {
  const rel = `${findTicket(vault, "WORK-002")!.rel}/notes.md`;
  assert.equal(fileView(vault, rel).editable, true);
  assert.throws(() => setFrontmatter(vault, rel, { linked_folders: "/tmp" }), /lf link/);
});
