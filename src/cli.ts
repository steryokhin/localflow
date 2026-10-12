import { parseArgs } from "node:util";
import {
  cmdBump, cmdCommit, cmdCreate, cmdDiff, cmdDoctor, cmdDone, cmdInbox, cmdInit, cmdLink, cmdLog, cmdLoop, cmdLoops, cmdLs,
  cmdNote, cmdOpen, cmdPath, cmdImport, cmdRepo, cmdReport, cmdSeen, cmdServe, cmdStandup, cmdStart, cmdStatus, cmdSync, cmdTrack,
  cmdUnlink, cmdWatch,
} from "./commands.ts";
import { resolveVault } from "./config.ts";
import { UserError } from "./util.ts";

const HELP = `Local Flow — local-only Jira mirror with your own notes (sync is one-way: Jira -> local).

Usage: lf <command> [options]          (global: --vault PATH, or LOCALFLOW_VAULT)

Setup
  init [PATH] [--jira-url URL] [--project KEY] [--local-prefix WORK] [--cloud] [--import-only]
                                  create a vault (default ~/LocalFlow); --cloud for Jira Cloud,
                                  --import-only: no outbound network, tickets come via "lf import"
  doctor [--offline]              check runtime, vault, token and Jira access

Sync
  sync [--project P] [--preset NAME] [--jql "..."] [--key K1,K2]
       [--dry-run] [--force] [--no-refresh]
                                  pull from Jira over REST (needs a token)
  import FILE.json... [--dry-run] [--force]
                                  same, from issue JSON an agent fetched (e.g. via Rovo); "-" reads stdin

What is new
  inbox                           tickets changed since you last looked
  diff KEY [--since COMMIT|DATE] [--git [git diff options]]
                                  what exactly changed: fields was → now, comments, attachments,
                                  text; since you last looked unless --since; --git: raw git diff
  seen KEY... | --all             mark as read

Work
  ls [--status S] [--mine] [--project P] [--unread] [--all]
  start KEY                       status -> inprogress, tracked; creates ai-summary.md and actions.md
  repo KEY [NAME]                 the ticket's repository: notes/repos/NAME.md, shared across tickets
  status KEY <inbox|inprogress|inreview|done|archived>
  note KEY NAME                   new note file in the ticket folder
  link KEY PATH                   link a folder outside the vault (shown in the ticket's web UI view)
  unlink KEY PATH                 remove a linked folder
  create PREFIX "title" [--type T] [--priority P2]    local ticket
  open [KEY]                      open the ticket folder (or the vault) in your editor
  path KEY                        print the ticket folder path
  commit [-m MSG]                 commit your own files (notes) to the vault's local git
  serve [--port 7420] [--open]    local web UI on http://127.0.0.1:<port> (loopback only)

Open loops (what I am waiting for, until when, and what to do then — kept in loops.md)
  loop "TEXT" --by WHEN [--key KEY] [--from WHO] [--else "WHAT THEN"]
                                  WHEN: +4h, +30m, +2d, 18:00, eod, tomorrow, 2026-10-14, "2026-10-14 12:00"
  done ID|WORD ["outcome"]        close a loop; it goes to the ticket's ## Log
  bump ID|WORD --by WHEN          move a deadline (logged)
  log KEY "TEXT"                  a line in the ticket's ## Log, without a loop
  loops                           rebuild and print ACTIONS.md (expired first)
  watch [--quiet] [--plist]       one check: NUDGES.md + a macOS notification (--quiet: none);
                                  --plist prints a launchd agent that runs it every 15 minutes
  standup [--week]                done / doing / waiting / blockers, ready to paste
  track KEY | untrack KEY         put a ticket on the loops board or take it off

Reports
  report [--date YYYY-MM-DD] [--write]
                                  the day from the vault's git history and session log;
                                  --write saves it to <vault>/reports/<date>.md
`;

type Opts = Record<string, { type: "string" | "boolean"; short?: string }>;

function parse(args: string[], options: Opts) {
  return parseArgs({ args, options: { vault: { type: "string" }, ...options }, allowPositionals: true });
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new UserError(`Usage: ${usage}`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  // `lf --vault PATH <command>` is the same as `lf <command> --vault PATH`.
  if (argv[0] === "--vault" && argv[1]) {
    process.env.LOCALFLOW_VAULT = argv[1];
    argv = argv.slice(2);
  }
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return 0;

    case "init": {
      const { values, positionals } = parse(rest, {
        "jira-url": { type: "string" },
        project: { type: "string" },
        "local-prefix": { type: "string" },
        force: { type: "boolean" },
        cloud: { type: "boolean" },
        "import-only": { type: "boolean" },
      });
      cmdInit(positionals[0] ?? (values.vault as string | undefined), {
        jiraUrl: values["jira-url"] as string | undefined,
        project: values.project as string | undefined,
        localPrefix: values["local-prefix"] as string | undefined,
        force: values.force as boolean | undefined,
        cloud: values.cloud as boolean | undefined,
        importOnly: values["import-only"] as boolean | undefined,
      });
      return 0;
    }

    case "import": {
      const { values, positionals } = parse(rest, { "dry-run": { type: "boolean" }, force: { type: "boolean" } });
      return cmdImport(resolveVault(values.vault as string | undefined), positionals, {
        dryRun: values["dry-run"] as boolean | undefined,
        force: values.force as boolean | undefined,
      });
    }

    case "doctor": {
      const { values } = parse(rest, { offline: { type: "boolean" } });
      return cmdDoctor(resolveVault(values.vault as string | undefined), { offline: values.offline as boolean | undefined });
    }

    case "sync": {
      const { values } = parse(rest, {
        project: { type: "string" },
        preset: { type: "string" },
        jql: { type: "string" },
        key: { type: "string" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        "no-refresh": { type: "boolean" },
      });
      const keys = (values.key as string | undefined)?.split(",").map((k) => k.trim().toUpperCase()).filter(Boolean);
      return cmdSync(resolveVault(values.vault as string | undefined), {
        project: values.project as string | undefined,
        preset: values.preset as string | undefined,
        jql: values.jql as string | undefined,
        keys,
        dryRun: values["dry-run"] as boolean | undefined,
        force: values.force as boolean | undefined,
        noRefresh: values["no-refresh"] as boolean | undefined,
      });
    }

    case "inbox": {
      const { values } = parse(rest, {});
      cmdInbox(resolveVault(values.vault as string | undefined));
      return 0;
    }

    case "seen": {
      const { values, positionals } = parse(rest, { all: { type: "boolean" } });
      cmdSeen(resolveVault(values.vault as string | undefined), positionals, !!values.all);
      return 0;
    }

    case "diff": {
      // Everything after --git is handed to `git diff` untouched (e.g. --stat, --word-diff).
      const gitAt = rest.indexOf("--git");
      const own = gitAt >= 0 ? rest.slice(0, gitAt) : rest;
      const { values, positionals } = parse(own, { since: { type: "string" } });
      return cmdDiff(resolveVault(values.vault as string | undefined), need(positionals[0], "lf diff KEY [--since COMMIT|YYYY-MM-DD] [--git [git diff options]]"), {
        since: values.since as string | undefined,
        git: gitAt >= 0 ? rest.slice(gitAt + 1) : undefined,
      });
    }

    case "ls": {
      const { values } = parse(rest, {
        status: { type: "string" },
        mine: { type: "boolean" },
        project: { type: "string" },
        unread: { type: "boolean" },
        all: { type: "boolean" },
      });
      cmdLs(resolveVault(values.vault as string | undefined), {
        status: values.status as string | undefined,
        mine: values.mine as boolean | undefined,
        project: values.project as string | undefined,
        unread: values.unread as boolean | undefined,
        all: values.all as boolean | undefined,
      });
      return 0;
    }

    case "start": {
      const { values, positionals } = parse(rest, {});
      cmdStart(resolveVault(values.vault as string | undefined), need(positionals[0], "lf start KEY"));
      return 0;
    }

    case "repo": {
      const { values, positionals } = parse(rest, {});
      cmdRepo(resolveVault(values.vault as string | undefined), need(positionals[0], "lf repo KEY [NAME]"), positionals[1]);
      return 0;
    }

    case "status": {
      const { values, positionals } = parse(rest, {});
      const usage = "lf status KEY <status>";
      cmdStatus(resolveVault(values.vault as string | undefined), need(positionals[0], usage), need(positionals[1], usage));
      return 0;
    }

    case "note": {
      const { values, positionals } = parse(rest, {});
      const usage = "lf note KEY NAME";
      cmdNote(resolveVault(values.vault as string | undefined), need(positionals[0], usage), need(positionals[1], usage));
      return 0;
    }

    case "link":
    case "unlink": {
      const { values, positionals } = parse(rest, {});
      const usage = `lf ${command} KEY PATH`;
      const run = command === "link" ? cmdLink : cmdUnlink;
      run(resolveVault(values.vault as string | undefined), need(positionals[0], usage), need(positionals[1], usage));
      return 0;
    }

    case "create": {
      const { values, positionals } = parse(rest, { type: { type: "string" }, priority: { type: "string" } });
      const usage = 'lf create PREFIX "title"';
      cmdCreate(
        resolveVault(values.vault as string | undefined),
        need(positionals[0], usage).toUpperCase(),
        need(positionals.slice(1).join(" "), usage),
        { type: values.type as string | undefined, priority: values.priority as string | undefined },
      );
      return 0;
    }

    case "loop": {
      const { values, positionals } = parse(rest, {
        key: { type: "string" }, from: { type: "string" }, by: { type: "string" }, else: { type: "string" },
      });
      cmdLoop(resolveVault(values.vault as string | undefined), positionals.join(" "), {
        key: values.key as string | undefined,
        from: values.from as string | undefined,
        by: values.by as string | undefined,
        else: values.else as string | undefined,
      });
      return 0;
    }

    case "done": {
      const { values, positionals } = parse(rest, {});
      await cmdDone(resolveVault(values.vault as string | undefined), need(positionals[0], 'lf done ID|WORD ["outcome"]'), positionals.slice(1).join(" "));
      return 0;
    }

    case "bump": {
      const { values, positionals } = parse(rest, { by: { type: "string" } });
      cmdBump(resolveVault(values.vault as string | undefined), need(positionals[0], "lf bump ID|WORD --by WHEN"), values.by as string | undefined);
      return 0;
    }

    case "log": {
      const { values, positionals } = parse(rest, {});
      cmdLog(resolveVault(values.vault as string | undefined), need(positionals[0], 'lf log KEY "text"'), positionals.slice(1).join(" "));
      return 0;
    }

    case "loops": {
      const { values } = parse(rest, {});
      cmdLoops(resolveVault(values.vault as string | undefined));
      return 0;
    }

    case "watch": {
      const { values } = parse(rest, { quiet: { type: "boolean" }, plist: { type: "boolean" } });
      cmdWatch(resolveVault(values.vault as string | undefined), { quiet: values.quiet as boolean | undefined, plist: values.plist as boolean | undefined });
      return 0;
    }

    case "standup": {
      const { values } = parse(rest, { week: { type: "boolean" } });
      cmdStandup(resolveVault(values.vault as string | undefined), !!values.week);
      return 0;
    }

    case "track":
    case "untrack": {
      const { values, positionals } = parse(rest, {});
      cmdTrack(resolveVault(values.vault as string | undefined), need(positionals[0], `lf ${command} KEY`), command === "track");
      return 0;
    }

    case "report": {
      const { values } = parse(rest, { date: { type: "string" }, write: { type: "boolean" } });
      cmdReport(resolveVault(values.vault as string | undefined), {
        date: values.date as string | undefined,
        write: values.write as boolean | undefined,
      });
      return 0;
    }

    case "open": {
      const { values, positionals } = parse(rest, {});
      cmdOpen(resolveVault(values.vault as string | undefined), positionals[0]);
      return 0;
    }

    case "path": {
      const { values, positionals } = parse(rest, {});
      cmdPath(resolveVault(values.vault as string | undefined), need(positionals[0], "lf path KEY"));
      return 0;
    }

    case "serve": {
      const { values } = parse(rest, { port: { type: "string" }, open: { type: "boolean" } });
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new UserError("--port must be 1..65535");
      await cmdServe(resolveVault(values.vault as string | undefined), { port, open: values.open as boolean | undefined });
      return 0;
    }

    case "commit": {
      const { values } = parse(rest, { message: { type: "string", short: "m" } });
      cmdCommit(resolveVault(values.vault as string | undefined), values.message as string | undefined);
      return 0;
    }

    default:
      throw new UserError(`Unknown command "${command}". Run \`lf help\`.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error & { code?: string }) => {
    // Expected failures get a clean one-line message; anything else keeps its stack for debugging.
    const expected = e instanceof UserError || e.code?.startsWith("ERR_PARSE_ARGS");
    console.error(expected || !process.env.LOCALFLOW_DEBUG ? `lf: ${e.message}` : e);
    process.exitCode = 1;
  },
);
