# Local Flow

A local-only mirror of your Jira tickets with your own notes next to each one.
Sync is strictly one-way: **Jira → local files**. Nothing leaves your machine.

- Zero dependencies: TypeScript with no build step, runs on Node ≥ 22.18 or Bun.
- Network access lives in one file (`src/jira/client.ts`): GET requests only, to the configured
  Jira host only. A test enforces this.
- The vault is a plain folder with a local git repository and no remote. Git gives you diffs and
  full version history of every ticket for free.
- Built for working with an AI coding agent: a Claude Code skill ships with the tool.

## Install

```bash
git clone <repo> ~/work/localflow
~/work/localflow/install.sh      # symlinks ~/.local/bin/lf and ~/.claude/skills/localflow
```

## Two ways to get tickets in

- **REST with a token** — `lf sync`. Autonomous: cron, hooks, no model, no tokens spent.
  Data Center: Personal Access Token (Bearer), REST v2. Cloud: API token + `jira.email` (Basic auth),
  REST v3 (`/rest/api/3/search/jql` — Cloud removed the v2 search endpoint). Attachments on Cloud
  are fetched from `api.media.atlassian.com` via pre-signed redirects; that host is allowed for
  downloads only and never receives the token.
- **Through an AI agent** — `lf import FILE.json`. When an API token is not an option but the
  agent has the Atlassian (Rovo) MCP connector, the agent fetches the issues and hands the JSON
  to `lf`; rendering, diffs, history and notes are identical. The bundled skill tells the agent how.
  Attachments cannot be downloaded this way and are only listed.
  With `jira.transport: "import"` (`lf init --import-only`) `lf` refuses every non-loopback
  connection, so the tool itself never talks to the network at all.

## First run

```bash
lf init ~/LocalFlow --jira-url https://jira.example.com --project PROJ --local-prefix WORK   # add --cloud for Jira Cloud
# put a read-only token into your password manager (Data Center: Personal Access Token;
# Cloud: API token with scopes from id.atlassian.com) — lf fetches it with jira.tokenCommand,
# by default: bw get password localflow-jira
lf doctor
lf sync --dry-run
lf sync
lf seen --all        # the first sync marks everything as new
```

The token is never stored on disk: `jira.tokenCommand` is an argv array whose stdout is the
token, by default `["bw", "get", "password", "localflow-jira"]` (Bitwarden CLI; any manager with a
CLI works). `lf` runs it without a shell, captures only stdout and never prints the value; stdin
stays on the terminal so the manager can ask for its master password. For runs started by an agent (no terminal), unlock
first in the shell you start the agent from: `export BW_SESSION=$(bw unlock --raw)`.

On Jira Cloud, create the token as an *API token with scopes* and grant only `read:jira-work` and
`read:jira-user`: `lf` has no write methods at all (enforced by a test), and a read-only token
makes that true at Atlassian's end too. Scoped tokens may need `baseUrl` pointed at
`https://api.atlassian.com/ex/jira/<cloudId>` — `lf doctor` tells you whether access works.

## The vault

```
~/LocalFlow/
  localflow.json              config
  INBOX.md                    generated: what is new + the board (not in git)
  .localflow/                 local state (not in git)
  projects/
    PROJ/PROJ-123-slug/
      ticket.md               generated from Jira — never edit by hand
      attachments/            files from Jira
      raw/issue.json          the raw Jira response, byte for byte
      notes.md                yours: workflow status and main note
      *.md, anything else     yours: the sync never touches it
    WORK/WORK-001-slug/       a local ticket of your own (ticket.md is editable)
  notes/                      plain notes outside the board (journal, decisions, …)
```

The sync owns only `ticket.md`, `attachments/` and `raw/`. Your workflow status (`inbox`,
`inprogress`, `inreview`, `done`, `archived`) lives in `notes.md` and is never changed by the
sync; when Jira has moved further than your status, `lf ls` points it out.

## Commands

| Command | What it does |
|---|---|
| `lf sync [--project P] [--preset N] [--jql "…"] [--key K1,K2] [--dry-run] [--force]` | pull changes from Jira; one commit per sync |
| `lf import FILE.json… [--dry-run] [--force]` | the same, from issue JSON fetched by an agent; `-` reads stdin |
| `lf inbox` | tickets changed since you last looked, with a summary |
| `lf diff KEY [git diff options]` | what exactly changed in a ticket |
| `lf seen KEY… \| --all` | mark as read |
| `lf ls [--status S] [--mine] [--project P] [--unread] [--all]` | the board in the terminal |
| `lf start KEY` / `lf status KEY <status>` | your workflow status |
| `lf note KEY NAME` | a new note file in the ticket folder |
| `lf create PREFIX "title"` | a local ticket of your own |
| `lf open [KEY]` / `lf path KEY` | open in your editor / print the folder path |
| `lf commit [-m MSG]` | commit your own files (notes) to the vault's local git |
| `lf report [--date D] [--write]` | the day, from the vault's git history and the session log; no model involved |
| `lf serve [--port 7420] [--open]` | the local web UI (see below) |
| `lf doctor [--offline]` | check runtime, vault, token and Jira access |

The vault is resolved from `--vault PATH`, then `LOCALFLOW_VAULT`, then the nearest parent folder
containing `localflow.json`, then `~/LocalFlow`.

## Configuration

```json
{
  "version": 1,
  "jira": {
    "baseUrl": "https://jira.example.com",
    "transport": "rest",
    "flavor": "datacenter",
    "tokenCommand": ["bw", "get", "password", "localflow-jira"],
    "userAgent": "localflow/0.1",
    "maxAttachmentMb": 25,
    "ignoreFields": ["Rank", "Development", "Last Viewed"],
    "fieldNames": {},
    "textFormat": "wiki"
  },
  "projects": {
    "PROJ": {
      "source": "jira",
      "defaultPreset": "mine",
      "presets": {
        "mine": "project = PROJ AND resolution = Unresolved AND assignee = currentUser() ORDER BY updated DESC"
      },
      "fields": {
        "acceptanceCriteria": "customfield_10001",
        "stepsToReproduce": "customfield_10002",
        "storyPoints": "customfield_10003",
        "sprint": "customfield_10004",
        "epicLink": "customfield_10005"
      },
      "statusOverrides": { "ready for dev": "inbox" }
    },
    "WORK": { "source": "local" }
  }
}
```

- `fields` — ids of the project's custom fields that get their own sections in `ticket.md`.
  Every other non-empty field is rendered under "Other fields" with its human-readable name.
- `ignoreFields` — field names or ids that only add noise to diffs and are left out of `ticket.md`.
- `statusOverrides` — Jira status name → initial local status for new tickets. Without an override a
  new ticket starts in `inbox` (you have not triaged it yet), except tickets already closed in Jira,
  which start in `done`.
- `transport` — `rest` (lf fetches from Jira itself) or `import` (no outbound network; only `lf import`).
- `flavor` — `datacenter` (REST v2, Bearer PAT, wiki markup) or `cloud` (REST v2, Basic auth with
  `email` + API token). `textFormat` says how plain-string rich text is read: `wiki` for REST,
  `markdown` for Rovo output; ADF objects are recognised either way.
- `me` — for imported data: your accountId, email or display name, so `mine` can be computed.
- `fieldNames` — `customfield_*` → human name, for imported data that carries no field names.

## Web UI

`lf serve` starts the UI at `http://127.0.0.1:7420/`. It binds the loopback interface only,
answers only to a `127.0.0.1`/`localhost` Host header, loads no external resources and needs a
custom header for every change, so no other site can talk to it. Four panes, Finder-style:
where to look (groups, statuses, plain notes) · the ticket list · the ticket folder (Original
Task and History pinned on top, your files below) · the content. The Jira mirror highlights what
changed since you last marked the ticket seen; History is the ticket's event feed. Your files
open read-only; *Edit* (or a double-click on a block) switches to a Notion-style editor: the whole
document stays rendered, the block you click shows its Markdown, leaving it renders it again; ⌘S
saves, and so does a pause. The page follows the vault: files added or changed by `lf`, an agent
or your editor appear without a reload, and an open editor is never overwritten.

**Groups.** The first nav section is *Groups*: *All*, then one entry per group with open/unread
counts. A ticket's group is the `group:` key in its `notes.md`; without it the group is the
project prefix, so existing tickets show up under `HCOMHOT` or `WORK` with no migration. The `+`
creates an empty group (kept in `groups.json` in the vault root), the hover `×` deletes it (click,
then *Yes*): `group:` is cleared from its tickets, which fall back to their prefix; tickets are
never deleted. The selected group is remembered and scopes both the list and the *Status* counts;
*Status* has *All* (everything but archived) next to *All open* and the single statuses.

**Hierarchy.** The list is a tree built from `parent: KEY` in `notes.md`, set by hand only (Jira
epic and parent links are not used). Chevrons fold a branch; a child whose parent is missing or
filtered out stays visible at the top level. Drag a ticket onto another one to nest it, onto the
empty part of the list (or the strip that appears while dragging) to un-nest it, or onto a group
in the nav to move it there. Self-parenting and cycles are refused. Search results stay flat.

**New file.** *+ File* at the bottom of the ticket folder column creates a Markdown file in the
ticket folder (suggested name `note-YYYY-MM-DD.md`) and opens it for typing. `ticket.md`,
`attachments`, `raw` and `notes.md` are refused.

**Sync button.** A Jira ticket's header has *Sync*: it fetches just that ticket, in the server
process, exactly like `lf sync --key KEY` (still read-only towards Jira; one sync at a time). The
result comes as a toast (`updated` / `unchanged` / the error). What changed stays unread until
you press *Mark seen*. The token comes from `jira.tokenCommand`, so with Bitwarden unlock it
before starting the server: `export BW_SESSION=$(bw unlock --raw)`, then `lf serve`. The button
is hidden when `jira.transport` is `import`.

## Daily report and session log

`lf report` assembles the day without a model: what came from Jira (the sync commits' summaries),
which tickets you moved or annotated (committed notes only), what is in progress, and the Claude
Code sessions of the day. Sessions are recorded by `hooks/session-log.sh`: one JSON line in
`.localflow/sessions.jsonl` when a session ends (exit or `/clear`), read from the local transcript
only. Register it in `~/.claude/settings.json`:

```json
"hooks": { "SessionEnd": [ { "hooks": [ { "type": "command", "command": "~/work/localflow/hooks/session-log.sh" } ] } ] }
```

## Claude Code skill

The rules an agent follows when working with `lf` are in `skills/localflow/SKILL.md`;
`install.sh` links them into `~/.claude/skills/localflow`. The repository's `CLAUDE.md` imports
the same file.

## Tests

```bash
node --test test/*.test.ts     # or: bun test
```

The end-to-end test starts a fake Jira on 127.0.0.1 and runs the sync against a temporary vault.
`test/network-guard.test.ts` makes sure network access stays inside the Jira client.

## Status and disclaimer

Early, personal tooling: written for one workflow and one Jira Data Center instance, tested against
an invented Jira, not yet battle-tested on real data. Expect rough edges.

Use at your own risk. The software is provided "as is", without warranty of any kind; the author is
not responsible for lost notes, misread tickets, or anything your employer thinks about a Jira
mirror on your laptop. Read your company's policies before pointing it at a corporate Jira. It never
writes to Jira and never sends data anywhere except the Jira host you configure — but verify that
yourself: the code is small enough to read in one sitting.

## License

BSD 2-Clause. See `LICENSE`.
