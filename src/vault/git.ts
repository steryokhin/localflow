// Thin wrapper over the system `git` binary. The vault is a local-only repository:
// any configured remote is treated as a hard error, since a push would leak Jira content.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UserError } from "../util.ts";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const BOT_IDENTITY = ["-c", "user.name=Local Flow", "-c", "user.email=localflow@localhost"];

export function git(vault: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: vault, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message: string };
    if (err.code === "ENOENT") throw new UserError("git is not installed or not on PATH.");
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).trim()}`);
  }
}

export function isRepo(vault: string): boolean {
  return fs.existsSync(path.join(vault, ".git"));
}

export function initRepo(vault: string): void {
  git(vault, ["init", "-q"]);
}

export function remotes(vault: string): string[] {
  return git(vault, ["remote"]).split("\n").map((s) => s.trim()).filter(Boolean);
}

export function assertLocalOnly(vault: string): void {
  if (!isRepo(vault)) throw new UserError(`${vault} is not a git repository. Run \`lf init\` there first.`);
  const r = remotes(vault);
  if (r.length) {
    throw new UserError(
      `The vault has a git remote (${r.join(", ")}). Local Flow refuses to work with it: ` +
        `a push would send Jira content off this machine.\nRemove it: git -C "${vault}" remote remove ${r[0]}`,
    );
  }
}

export function head(vault: string): string | null {
  try {
    return git(vault, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

/** Commit exactly the given paths (relative to the vault). Returns the new sha, or null if nothing changed. */
export function commitPaths(vault: string, paths: string[], message: string): string | null {
  const existing = paths.filter((p) => fs.existsSync(path.join(vault, p)) || isTracked(vault, p));
  if (existing.length === 0) return null;
  git(vault, ["add", "-A", "--", ...existing]);
  if (!git(vault, ["status", "--porcelain", "--", ...existing]).trim()) return null;
  git(vault, [...BOT_IDENTITY, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message, "--", ...existing]);
  return head(vault);
}

function isTracked(vault: string, p: string): boolean {
  return git(vault, ["ls-files", "--", p]).trim() !== "";
}

/** Commit everything that is dirty (the user's own files). Returns the new sha, or null if clean. */
export function commitAll(vault: string, message: string): string | null {
  git(vault, ["add", "-A"]);
  if (!git(vault, ["status", "--porcelain"]).trim()) return null;
  const hasIdentity = spawnSync("git", ["config", "user.email"], { cwd: vault }).status === 0;
  git(vault, [...(hasIdentity ? [] : BOT_IDENTITY), "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return head(vault);
}

export interface Commit {
  sha: string;
  date: string;
  subject: string;
  body: string;
}

/** All commits, newest first. */
export function log(vault: string): Commit[] {
  if (!head(vault)) return [];
  const out = git(vault, ["log", "--format=%H%x1f%cI%x1f%s%x1f%b%x1e"]);
  return out
    .split("\x1e")
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha, date, subject, body] = rec.split("\x1f");
      return { sha, date, subject, body: body ?? "" };
    });
}

/** Run an interactive git command with the terminal attached (pager, colors). */
export function gitInteractive(vault: string, args: string[]): number {
  return spawnSync("git", args, { cwd: vault, stdio: "inherit" }).status ?? 1;
}
