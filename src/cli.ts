import { parseArgs } from "node:util";
import {
  cmdCommit, cmdCreate, cmdDiff, cmdDoctor, cmdInbox, cmdInit, cmdLs, cmdNote, cmdOpen, cmdPath,
  cmdReport, cmdSeen, cmdStart, cmdStatus, cmdSync,
} from "./commands.ts";
import { resolveVault } from "./config.ts";
import { UserError } from "./util.ts";

const HELP = `Local Flow — local-only Jira mirror with your own notes (sync is one-way: Jira -> local).

Usage: lf <command> [options]          (global: --vault PATH, or LOCALFLOW_VAULT)

Setup
  init [PATH] [--jira-url URL] [--project KEY] [--local-prefix WORK]
                                  create a vault (default ~/LocalFlow)
  doctor [--offline]              check runtime, vault, token and Jira access

Sync
  sync [--project P] [--preset NAME] [--jql "..."] [--key K1,K2]
       [--dry-run] [--force] [--no-refresh]

What is new
  inbox                           tickets changed since you last looked
  diff KEY [git diff options]     what exactly changed in a ticket
  seen KEY... | --all             mark as read

Work
  ls [--status S] [--mine] [--project P] [--unread] [--all]
  start KEY                       status -> inprogress
  status KEY <inbox|inprogress|inreview|done|archived>
  note KEY NAME                   new note file in the ticket folder
  create PREFIX "title" [--type T] [--priority P2]    local ticket
  open [KEY]                      open the ticket folder (or the vault) in your editor
  path KEY                        print the ticket folder path
  commit [-m MSG]                 commit your own files (notes) to the vault's local git

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
      });
      cmdInit(positionals[0] ?? (values.vault as string | undefined), {
        jiraUrl: values["jira-url"] as string | undefined,
        project: values.project as string | undefined,
        localPrefix: values["local-prefix"] as string | undefined,
        force: values.force as boolean | undefined,
      });
      return 0;
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
      // Everything after KEY is handed to `git diff` untouched (e.g. --stat, --word-diff).
      const vaultIdx = rest.indexOf("--vault");
      const vaultFlag = vaultIdx >= 0 ? rest[vaultIdx + 1] : undefined;
      const args = vaultIdx >= 0 ? [...rest.slice(0, vaultIdx), ...rest.slice(vaultIdx + 2)] : rest;
      return cmdDiff(resolveVault(vaultFlag), need(args[0], "lf diff KEY [git diff options]"), args.slice(1));
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
