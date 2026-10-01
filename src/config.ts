import fs from "node:fs";
import path from "node:path";
import { runSecretCommand } from "./secret.ts";
import { UserError, expandHome } from "./util.ts";

export const CONFIG_FILE = "localflow.json";
export const STATE_DIR = ".localflow";
export const PROJECTS_DIR = "projects";
export const INBOX_FILE = "INBOX.md";
export const DEFAULT_VAULT = "~/LocalFlow";

export interface JiraFieldIds {
  acceptanceCriteria?: string;
  stepsToReproduce?: string;
  storyPoints?: string;
  sprint?: string;
  epicLink?: string;
}

export interface ProjectConfig {
  source: "jira" | "local";
  /** Jira only. */
  defaultPreset?: string;
  presets?: Record<string, string>;
  fields?: JiraFieldIds;
  /** Lower-cased Jira status name -> local status, overriding the status category mapping. */
  statusOverrides?: Record<string, string>;
}

export interface Config {
  version: number;
  jira: {
    baseUrl: string;
    /**
     * "rest": lf talks to Jira itself (needs a token). "import": lf never opens an outbound
     * connection — every non-loopback request is refused; issues arrive through `lf import`.
     */
    transport: "rest" | "import";
    /** "datacenter": REST v2, Bearer PAT, wiki markup. "cloud": REST v3 (search/jql), Basic auth (email + API token), ADF. */
    flavor: "datacenter" | "cloud";
    /** Cloud only: the account email paired with the API token. */
    email?: string;
    /**
     * REST transport only: an argv array whose stdout is the token, e.g.
     * ["bw", "get", "password", "localflow-jira"]. Run without a shell; stdin/stderr stay on the
     * terminal so the password manager can prompt. The token is never stored on disk or logged —
     * there is deliberately no token file.
     */
    tokenCommand?: string[];
    userAgent: string;
    maxAttachmentMb: number;
    /** Field names or ids never rendered into ticket.md (noisy fields). */
    ignoreFields: string[];
    /** Field id -> human name, for imported data that carries no names (Rovo). Merged over what REST reports. */
    fieldNames: Record<string, string>;
    /**
     * Who "me" is for imported data: matched against assignee accountId, email, key, name or
     * display name. REST sync learns this from /myself instead.
     */
    me?: string;
    /** How plain-string rich text is interpreted: wiki markup (Data Center) or Markdown (Rovo output). */
    textFormat: "wiki" | "markdown";
  };
  projects: Record<string, ProjectConfig>;
}

export const DEFAULT_IGNORE_FIELDS = ["Rank", "Development", "Last Viewed"];

export function defaultConfig(opts: { jiraUrl?: string; project?: string; localPrefix?: string; cloud?: boolean; importOnly?: boolean }): Config {
  const projects: Record<string, ProjectConfig> = {};
  const jiraProject = opts.project ?? "PROJ";
  projects[jiraProject] = {
    source: "jira",
    defaultPreset: "mine",
    presets: {
      mine: `project = ${jiraProject} AND resolution = Unresolved AND assignee = currentUser() ORDER BY updated DESC`,
      "all-open": `project = ${jiraProject} AND resolution = Unresolved ORDER BY updated DESC`,
    },
    fields: {},
    statusOverrides: {},
  };
  projects[opts.localPrefix ?? "WORK"] = { source: "local" };
  return {
    version: 1,
    jira: {
      baseUrl: opts.jiraUrl ?? "https://jira.example.com",
      transport: opts.importOnly ? "import" : "rest",
      flavor: opts.cloud ? "cloud" : "datacenter",
      ...(opts.cloud ? { email: "you@example.com" } : {}),
      ...(opts.importOnly ? {} : { tokenCommand: ["bw", "get", "password", "localflow-jira"] }),
      userAgent: "localflow/0.1",
      maxAttachmentMb: 25,
      ignoreFields: [...DEFAULT_IGNORE_FIELDS],
      fieldNames: {},
      textFormat: opts.cloud ? "markdown" : "wiki",
    },
    projects,
  };
}

export function loadConfig(vault: string): Config {
  const file = path.join(vault, CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new UserError(`No ${CONFIG_FILE} in ${vault}. Run \`lf init\` first or pass --vault.`);
  }
  let parsed: Config;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new UserError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed.jira?.baseUrl || !parsed.projects) {
    throw new UserError(`${file} must contain "jira.baseUrl" and "projects".`);
  }
  if (parsed.jira.tokenFile !== undefined) {
    throw new UserError(`${file}: "jira.tokenFile" is no longer supported — tokens are not stored on disk. Use "jira.tokenCommand".`);
  }
  parsed.jira.userAgent ??= "localflow/0.1";
  parsed.jira.maxAttachmentMb ??= 25;
  parsed.jira.ignoreFields ??= [...DEFAULT_IGNORE_FIELDS];
  parsed.jira.flavor ??= "datacenter";
  parsed.jira.transport ??= "rest";
  parsed.jira.fieldNames ??= {};
  parsed.jira.textFormat ??= parsed.jira.flavor === "cloud" ? "markdown" : "wiki";
  return parsed;
}

/** Vault resolution: --vault flag, LOCALFLOW_VAULT, nearest parent with localflow.json, ~/LocalFlow. */
export function resolveVault(flag?: string): string {
  if (flag) return path.resolve(expandHome(flag));
  if (process.env.LOCALFLOW_VAULT) return path.resolve(expandHome(process.env.LOCALFLOW_VAULT));
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(expandHome(DEFAULT_VAULT));
}

/** Human-readable description of where the token comes from, never the token itself. */
export function tokenSource(config: Config): string {
  return `command: ${(config.jira.tokenCommand ?? []).join(" ")}`;
}

export function readToken(config: Config): string {
  const cmd = config.jira.tokenCommand;
  if (cmd === undefined) {
    throw new UserError(
      'No "jira.tokenCommand" in localflow.json. Tokens are read from a password manager, never from a file, e.g.\n' +
        '  "tokenCommand": ["bw", "get", "password", "localflow-jira"]',
    );
  }
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((a) => typeof a !== "string")) {
    throw new UserError('jira.tokenCommand must be a non-empty array of strings, e.g. ["bw", "get", "password", "localflow-jira"].');
  }
  return runSecretCommand(cmd);
}
