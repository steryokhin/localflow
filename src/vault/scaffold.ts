// The files a ticket gets when work on it starts, and the shared per-repository notes.
// Templates are built in; a file of the same name in <vault>/templates/ replaces one.
// Existing files are never overwritten.

import fs from "node:fs";
import path from "node:path";
import { UserError, readTextIfExists, today, writeFileAtomic } from "../util.ts";
import { setFrontmatterKeys } from "./frontmatter.ts";
import { notesText, setTracked } from "./notes.ts";
import { NOTES_FILE } from "./store.ts";
import type { Ticket } from "./store.ts";

export const TEMPLATES_DIR = "templates";
export const REPOS_DIR = "notes/repos";
export const SUMMARY_FILE = "ai-summary.md";
export const PLAN_FILE = "actions.md";

const BUILTIN: Record<string, string> = {
  [SUMMARY_FILE]: `---
ticket: {{key}}
type: Summary
created: {{date}}
---

# {{key}} — summary

_What the ticket asks, in my own words. Edited in place, no "Update" blocks. Every claim is marked:
(source: ticket / comment by X / Slack …) or (inference)._

## What is asked

## Context and constraints

## Inconsistencies spotted

## Open questions
`,
  [PLAN_FILE]: `---
ticket: {{key}}
type: Plan
created: {{date}}
---

# {{key}} — plan

_Only the plan: phases, checkboxes, how to verify — about 80 lines at most. The log and decisions
go to notes.md, waits to loops.md, repository setup to notes/repos/<repo>.md._

## Phase 1

- [ ]

## How to verify

- [ ]
`,
  "repo.md": `---
type: Repo
repo: {{name}}
created: {{date}}
---

# {{name}}

_About the repository, not a ticket: shared by every ticket with \`repo: {{name}}\` in its notes.md._

## Environment

## Build and test

## Process

_Labels, reviews, release steps._

## Pitfalls
`,
};

function template(vault: string, name: string, vars: Record<string, string>): string {
  const text = readTextIfExists(path.join(vault, TEMPLATES_DIR, name)) ?? BUILTIN[name];
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

/** Starting work: the ticket is tracked and has ai-summary.md and actions.md. Returns the files created. */
export function beginWork(vault: string, t: Ticket): string[] {
  if (t.notes.tracked !== true) setTracked(t, true);
  const created: string[] = [];
  for (const name of [SUMMARY_FILE, PLAN_FILE]) {
    const file = path.join(t.dir, name);
    if (fs.existsSync(file)) continue;
    writeFileAtomic(file, template(vault, name, { key: t.key, date: today() }));
    created.push(`${t.rel}/${name}`);
  }
  return created;
}

export function cleanRepoName(raw: string): string {
  const name = raw.trim();
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(name) || name.length > 80) {
    throw new UserError(`Not a repository name: "${raw}" (letters, digits, "_", "-", "." only).`);
  }
  return name;
}

export const repoRel = (name: string): string => `${REPOS_DIR}/${name}.md`;

/** Sets `repo:` in the ticket's notes.md and creates notes/repos/<name>.md when missing. */
export function setRepo(vault: string, t: Ticket, raw: string): { name: string; rel: string; created: boolean } {
  const name = cleanRepoName(raw);
  const rel = repoRel(name);
  const file = path.join(vault, rel);
  const created = !fs.existsSync(file);
  if (created) writeFileAtomic(file, template(vault, "repo.md", { name, date: today() }));
  writeFileAtomic(path.join(t.dir, NOTES_FILE), setFrontmatterKeys(notesText(t), { repo: name }));
  return { name, rel, created };
}

/** The ticket's repository notes from `repo:` in notes.md, or null. */
export function repoOf(vault: string, t: Ticket): { name: string; rel: string; exists: boolean } | null {
  const raw = t.notes.repo;
  if (typeof raw !== "string") return null;
  try {
    const name = cleanRepoName(raw);
    return { name, rel: repoRel(name), exists: fs.existsSync(path.join(vault, repoRel(name))) };
  } catch {
    return null;
  }
}
