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
   - `notes.md` — the user's status and main note. Edited by the user and by you. Its frontmatter
     also carries the user's `group:` (UI grouping; defaults to the project prefix) and
     `parent: KEY` (manual nesting in the UI list). Set by the web UI; leave them alone unless asked.
     `linked_folders:` (absolute paths of folders outside the vault shown with the ticket) is changed
     only with `lf link KEY PATH` / `lf unlink KEY PATH`, which validate the path.
     `tracked: true` puts the ticket on the loops board; change it with `lf track` / `lf untrack`.
   - any other `*.md`, diagrams, scripts — yours and the user's; the sync never touches them.
4. **Path to a ticket:** `lf path KEY`. From there use Read/Write/Edit on the files, not `cat`.

## Reading a ticket

- `ticket.md` — description, acceptance criteria, steps, all fields, related issues, attachments,
  comments. Image links are relative (`attachments/…`); Read opens them as images.
- `raw/issue.json` — the raw Jira response, for a field that is not in `ticket.md`.
- `notes.md` — what has already been decided and done. Read it **before** proposing anything.
- What changed: `lf diff KEY` — fields was → now, new and edited comments in full, attachments and
  the changed text blocks since the user last marked it seen; `--since YYYY-MM-DD` or a commit for
  another baseline, `--git` for a raw `git diff`. Full history: `git -C <vault> log -p -- <folder>/ticket.md`.

## Getting tickets in: two transports

`lf doctor` tells which one applies (`jira.transport` in `localflow.json`: `rest` or `import`).
With `import`, `lf` itself never opens a network connection — only loopback is allowed — so B is
the only way in. Both end in the same render, diff and commit.

**A. REST with a token** (`lf doctor` shows "Jira access ok"):
```
lf sync            # one commit per sync, with a change summary
```
The token is read by `lf` itself from the user's password manager (`jira.tokenCommand`); it is never on disk.
Never fetch, print or paste the token yourself — it must not enter this conversation. If
`lf doctor` reports the token command failed (locked vault, no `BW_SESSION`), ask the user to
unlock their password manager in the shell they started you from and retry; do not work around it.

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
Report briefly what changed (`lf inbox` already lists up to three changes per ticket: who
commented what, fields was → now, attachments; `lf diff KEY` has the rest). Mark as read only after reporting: `lf seen KEY` or `lf seen --all`.
An empty inbox is a valid result: say "nothing new".

## Task flow

| Moment | Action |
|---|---|
| "Let's start KEY" | `lf start KEY` (status → inprogress, `taken:`, `tracked: true`, creates `ai-summary.md` and `actions.md`), then fill `ai-summary.md` first. A feature branch in the code repository named after the ticket key in lower case (`proj-123-short-slug`); `lf repo KEY <repo>` links the shared repository notes |
| While working | Decisions into `## Decisions` of `notes.md`, one dated line per action into `## Log` (`lf log KEY "…"`), the plan in `actions.md`, waits as loops. Write **as you go**: these files are the source of truth between sessions and after `/clear` |
| Lots of material | `research-<topic>.md` (one topic per file, edited in place) via `lf note KEY research-<topic>` |
| PR opened | `lf status KEY inreview` and a loop for the review |
| Merged | `lf status KEY done` — only when the user says so |
| End of session | `lf commit` — notes go into the vault's local git |

Two statuses live side by side: Jira's (`jira_status` in `ticket.md`, moved only by the sync) and the
user's (`status` in `notes.md`, which the sync never moves). When they disagree, `lf ls` marks the
ticket `[≠ mine: inbox, Jira: inprogress — lf align KEY]` — mention it. `lf align KEY` (or
`--all`, with `--dry-run` first) copies Jira's status into the user's through the status mapping;
run it when the user asks. It never writes to Jira. `lf ls --by jira` groups by Jira's status.

## Ticket files

Each fact lives in one place:

| File | What it holds | Rule |
|---|---|---|
| `ticket.md` | the Jira mirror | sync-owned, never edited |
| `notes.md` | status (frontmatter), `## Decisions` (decision, date, source), `## Log` (one line per action) | the only place for status; the log is append-only |
| `ai-summary.md` | understanding of the ticket | written at the start, edited in place (no "Update" blocks), ends with open questions |
| `actions.md` | the plan only: phases, checkboxes, how to verify | no log, status or reference material; about 80 lines at most |
| `research-<topic>.md` | optional, one topic per file | edited in place: a new finding replaces the old conclusion |
| `<vault>/loops.md` | open loops, all tickets | next steps and waits live only here |
| `<vault>/notes/repos/<repo>.md` | the repository, not the ticket: environment, build and test commands, process (labels, reviews), pitfalls | shared by every ticket with `repo: <repo>`; move repo knowledge here instead of copying it into tickets |

A taken ticket has at least `ai-summary.md`, `actions.md` and one open loop. Do not keep "Status"
or "What to say at the daily" blocks anywhere — `lf standup` produces them. Translate the ticket
only when asked.

In `ai-summary.md` and `research-*.md` every claim is marked: `(source: ticket / comment by X /
log / Slack …)` for facts, `(inference)` for your conclusions. Never present an inference as a fact.

## Open loops

An open loop is something the user did or asked for and is now waiting on: a PR out for review, a
build sent to QA, a question to a manager, or their own promise. Four fields: what, from whom (`me`
or a name), by when, what to do if the deadline passes. They live in `<vault>/loops.md`, one line
each; next steps and waits live **only** there (not in notes.md, not in actions.md).

- **You record them.** After any action in the conversation that leaves the user waiting
  ("wrote to QA", "pushed the PR", "asked Mark"), add a loop right away and say it in one line:
  `lf loop "PR #41 review" --key EXP-123 --from Tom --by +4h --else "ping in #ios-reviews"`
  → "loop L3: waiting for Tom until 15:00, else ping in #ios-reviews". Pick a sensible deadline
  and mention it; the user corrects it if needed. `lf loop` without `--key` is fine for loops
  that have no ticket (onboarding, a question to someone).
- **Chain rule, always.** Closing a loop always opens the next one: a `me` loop is the user's next
  step, a `from <who>` loop is a delegation. Do both in one call:
  `lf done L3 "Tom approved, 2 comments" --next "merge after CI" --by +2h` (add `--from WHO`,
  `--else "…"` as needed; the next loop gets the same ticket). If the next step is unclear, ask
  "next one, or take the ticket off the board?" instead of closing silently. The closed line goes
  to the ticket's `## Log`.
- **Plain words are enough.** When the user reports an action ("wrote to QA", "Chloe approved",
  "move it to tomorrow"), write the loop / done / bump right away and confirm in one line. Do not
  ask where a sensible deadline can be picked; mention the one you chose.
- **Moving a deadline** is the user's call: `lf bump L3 --by tomorrow` only when they say so.
- **A tracked ticket always has at least one open loop.** It comes off the board only on the user's
  explicit word (`lf untrack KEY`) — never because it is Done in Jira or has gone quiet.
- **Start of a session:** read `<vault>/NUDGES.md` (written by `lf watch` every 15 minutes) or run
  `lf loops`, and if something expired, offer it first: "2 expired: ping Tom? move Lena's to
  tomorrow?". Expired loops are the frog: they come before anything else. Then list the tracked
  tickets with no open loop (the last section of `lf loops`) and ask about each: "next loop, or
  untrack?".
- **After working on a ticket**, one dated line of what happened: `lf log EXP-123 "split the fix
  into two PRs"`.
- Daily or weekly meeting: `lf standup` / `lf standup --week` and hand the output over as it is.
- `lf watch --plist` prints a launchd agent for the 15-minute check; installing it is the user's
  decision (`~/Library/LaunchAgents`, then `launchctl load`).

## Note format in notes.md

```markdown
## Decisions

- 2026-09-30 — Keep the old endpoint until v2 ships (source: the user; Mark in #ios)

## Log

- 2026-09-30 10:40 — Reproduced on iOS 26; the crash is in the swipe handler
- 2026-09-30 16:05 — Done: fix pushed — commit `abc1234`, branch `proj-123-…`
```
Quote the user's wording verbatim. Never rewrite earlier entries; only append. Older notes that use
dated `## 2026-09-30` headings stay as they are.

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

- `lf inbox --group activity|mine|tracked|waiting` — smart groups: unread changes in the user's and
  tracked tickets, assigned to them, tracked, waiting on someone. `INBOX.md` has them in that order.
- The web UI has smart folders over the whole vault (Activity, My Jira, Tracking, Waiting, No loops),
  configurable in `localflow.json` → `smartFolders`; plus Loops and Standup pages that write the same
  `loops.md` and `## Log` as the CLI.
- `lf ls` — open tickets by status; `--mine`, `--unread`, `--status done`, `--all`, `--project P`,
  `--by jira` to group by Jira's status.
- Text search — Grep over `projects/**/ticket.md` and `notes.md`. There is deliberately no vector search.

## Web UI

`lf serve` (then open http://127.0.0.1:7420/) is the user's own view of the same files: ticket
list, the ticket folder with the Jira mirror and their notes, an editor. It changes nothing about
how you work: the files are the source of truth, and whatever the user edits there is visible to
you on disk at once. Do not start it unless the user asks; it runs until Ctrl+C.

## When something is off

- `lf doctor` — environment, token, Jira access. No token and no connector means no sync; work with what is there.
- A noisy field in the diff — add its name to `jira.ignoreFields` in `localflow.json`.
- Never add a remote to the vault's git and never run `git push` there.
