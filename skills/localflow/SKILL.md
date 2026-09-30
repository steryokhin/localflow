---
name: localflow
description: Working with tickets through Local Flow (`lf`) — a local-only Jira mirror with personal notes. Use when the user mentions a ticket by key (e.g. PROJ-123), asks "what's new in Jira", "sync Jira", "show the ticket", "let's start PROJ-123", "add a note to the ticket", says "lf" or "local flow", or when a task refers to a Jira ticket. Russian triggers work too ("что нового в жире", "синкни жиру", "поехали PROJ-123").
---

# Local Flow — rules for working with tickets

`lf` is a CLI (`~/work/localflow/bin/lf`, installed as `~/.local/bin/lf`). The vault is a plain local
folder (default `~/LocalFlow`; otherwise `LOCALFLOW_VAULT` or `--vault`). Everything is files; the
vault's git repository is local and has no remote. Full command list: `lf help`.

## Essentials

1. **Sync is one-way: Jira → local.** `lf` never writes to Jira. To change something in Jira (status,
   comment, assignee) use the Jira tools available in this environment or ask the user to do it in
   the Jira UI, then run `lf sync` so the mirror catches up.
2. **Nothing leaves the machine.** Ticket content, attachments and notes must not be sent to external
   services: no Artifacts, gists, web forms or pasted excerpts. Reports go to the terminal and to files
   inside the vault.
3. **Ticket folder** `projects/<PREFIX>/<KEY>-slug/`:
   - `ticket.md`, `attachments/`, `raw/` — owned by the sync. **Never edit them.**
   - `notes.md` — the user's status and main note. Edited by the user and by you.
   - any other `*.md`, diagrams, scripts — yours and the user's; the sync never touches them.
4. **Path to a ticket:** `lf path KEY`. From there use Read/Write/Edit on the files, not `cat`.

## Reading a ticket

- `ticket.md` — description, acceptance criteria, steps, all fields, related issues, attachments,
  comments. Image links are relative (`attachments/…`); Read opens them as images.
- `raw/issue.json` — the raw Jira response, for a field that is not in `ticket.md`.
- `notes.md` — what has already been decided and done. Read it **before** proposing anything.
- History: `lf diff KEY` (since the last "seen" mark), `git -C <vault> log -p -- <folder>/ticket.md`.

## What's new

At the start of a ticket session (when Jira is reachable, usually over VPN):
```
lf sync            # one commit per sync, with a change summary
lf inbox           # tickets changed since the user last looked
```
Report briefly what changed (`lf inbox` already summarizes: new comments, status changes, edited
descriptions, attachments). Mark as read only after reporting: `lf seen KEY` or `lf seen --all`.
An empty inbox is a valid result: say "nothing new".

## Task flow

| Moment | Action |
|---|---|
| "Let's start KEY" | `lf start KEY` (status → inprogress, sets `taken:`) and a feature branch in the code repository named after the ticket key in lower case (`proj-123-short-slug`) |
| While working | Write every decision into `notes.md` **as you go**, dated: decisions, what was done (commit hash), open questions. `notes.md` is the source of truth between sessions and after `/clear` |
| Lots of material | Separate files via `lf note KEY <name>` (scratchpad, review-findings, plan) with frontmatter `ticket: KEY` |
| PR opened | `lf status KEY inreview` |
| Merged | `lf status KEY done` — only when the user says so |
| End of session | `lf commit` — notes go into the vault's local git |

The status in `notes.md` belongs to the user; the sync never moves it. When Jira is further along
(e.g. the ticket was closed), `lf ls` shows `[Jira is ahead: done]` — mention it; the user changes
the status.

## Note format in notes.md

```markdown
## 2026-09-30
- Decision: … (user)
- Done: … — commit `abc1234`, branch `proj-123-…`
- Open: …
```
Quote the user's wording verbatim. Never rewrite earlier entries; only append.

## Local tickets

For work that has no Jira ticket: `lf create WORK "title"` (the prefix comes from
`localflow.json`, `source: local`). Their `ticket.md` is editable.

## Board and search

- `lf ls` — open tickets by status; `--mine`, `--unread`, `--status done`, `--all`, `--project P`.
- Text search — Grep over `projects/**/ticket.md` and `notes.md`. There is deliberately no vector search.

## When something is off

- `lf doctor` — environment, token, Jira access. No VPN means no sync; work with what is there.
- A noisy field in the diff — add its name to `jira.ignoreFields` in `localflow.json`.
- Never add a remote to the vault's git and never run `git push` there.
