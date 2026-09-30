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

## Getting tickets in: two transports

`lf doctor` tells which one applies. Both end in the same render, diff and commit.

**A. REST with a token** (`lf doctor` shows "Jira access ok"):
```
lf sync            # one commit per sync, with a change summary
```

**B. Through the Atlassian (Rovo) MCP connector**, when there is no API token but the connector
is available to you. You fetch, `lf` does the rest:
1. `getAccessibleAtlassianResources()` → your own `cloudId` (never hard-code someone else's).
2. One ticket: `getJiraIssue({ cloudId, issueIdOrKey: "KEY-123", fields: ["*all", "comment"], responseContentFormat: "markdown" })`.
   Many: `searchJiraIssuesUsingJql({ cloudId, jql, fields: ["*all", "comment"], responseContentFormat: "markdown", maxResults: 50 })`,
   following `nextPageToken` until it is empty.
3. Save the issue objects exactly as returned (one object, an array, or the whole `{issues: [...]}`
   response) to a file outside the vault, e.g. `/tmp/lf-import.json`, and run `lf import /tmp/lf-import.json`.
   `--dry-run` previews. Attachments cannot be downloaded this way; they are listed in `ticket.md`.
4. First time only: `localflow.json` needs `jira.me` (your accountId or display name) and, for
   readable "Other fields", `jira.fieldNames` mapping `customfield_*` ids to names — take both
   from the first `*all` response and tell the user what you set.

Never write anything to Jira through the connector as part of a sync; the mirror is read-only.

## What's new

After a sync or import:
```
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

## Daily report

`lf report` (today) or `lf report --date YYYY-MM-DD` prints, with no model involved: what came
from Jira, which tickets the user moved or annotated (committed changes only), what is in progress,
and the Claude Code sessions of the day (if the SessionEnd hook is installed). When the user asks
for a daily summary, run it and write the narrative **from that output**, not from the raw files.
`lf report --write` saves it to `<vault>/reports/<date>.md`. Uncommitted notes are invisible to
the report — `lf commit` first.

## Board and search

- `lf ls` — open tickets by status; `--mine`, `--unread`, `--status done`, `--all`, `--project P`.
- Text search — Grep over `projects/**/ticket.md` and `notes.md`. There is deliberately no vector search.

## When something is off

- `lf doctor` — environment, token, Jira access. No token and no connector means no sync; work with what is there.
- A noisy field in the diff — add its name to `jira.ignoreFields` in `localflow.json`.
- Never add a remote to the vault's git and never run `git push` there.
