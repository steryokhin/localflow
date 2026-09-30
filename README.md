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

## First run

```bash
lf init ~/LocalFlow --jira-url https://jira.example.com --project PROJ --local-prefix WORK
# a read-only Personal Access Token from Jira:
mkdir -p ~/.config/localflow
printf '%s' 'TOKEN' > ~/.config/localflow/jira-token && chmod 600 ~/.config/localflow/jira-token
lf doctor
lf sync --dry-run
lf sync
lf seen --all        # the first sync marks everything as new
```

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
```

The sync owns only `ticket.md`, `attachments/` and `raw/`. Your workflow status (`inbox`,
`inprogress`, `inreview`, `done`, `archived`) lives in `notes.md` and is never changed by the
sync; when Jira has moved further than your status, `lf ls` points it out.

## Commands

| Command | What it does |
|---|---|
| `lf sync [--project P] [--preset N] [--jql "…"] [--key K1,K2] [--dry-run] [--force]` | pull changes from Jira; one commit per sync |
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
| `lf doctor [--offline]` | check runtime, vault, token and Jira access |

The vault is resolved from `--vault PATH`, then `LOCALFLOW_VAULT`, then the nearest parent folder
containing `localflow.json`, then `~/LocalFlow`.

## Configuration

```json
{
  "version": 1,
  "jira": {
    "baseUrl": "https://jira.example.com",
    "tokenFile": "~/.config/localflow/jira-token",
    "userAgent": "localflow/0.1",
    "maxAttachmentMb": 25,
    "ignoreFields": ["Rank", "Development", "Last Viewed"]
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
- `statusOverrides` — Jira status name → initial local status for new tickets.

Written for Jira Data Center (REST API v2, Bearer token auth).

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
