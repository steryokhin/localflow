import fs from "node:fs";
import path from "node:path";
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
    tokenFile: string;
    userAgent: string;
    maxAttachmentMb: number;
    /** Field names or ids never rendered into ticket.md (noisy fields). */
    ignoreFields: string[];
  };
  projects: Record<string, ProjectConfig>;
}

export const DEFAULT_IGNORE_FIELDS = ["Rank", "Development", "Last Viewed"];

export function defaultConfig(opts: { jiraUrl?: string; project?: string; localPrefix?: string }): Config {
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
      tokenFile: "~/.config/localflow/jira-token",
      userAgent: "localflow/0.1",
      maxAttachmentMb: 25,
      ignoreFields: [...DEFAULT_IGNORE_FIELDS],
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
  parsed.jira.tokenFile ??= "~/.config/localflow/jira-token";
  parsed.jira.userAgent ??= "localflow/0.1";
  parsed.jira.maxAttachmentMb ??= 25;
  parsed.jira.ignoreFields ??= [...DEFAULT_IGNORE_FIELDS];
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

export function readToken(config: Config): string {
  const file = expandHome(config.jira.tokenFile);
  let token: string;
  try {
    token = fs.readFileSync(file, "utf8").trim();
  } catch {
    throw new UserError(
      `Jira token file not found: ${file}\n` +
        `Create a read-only Personal Access Token in Jira and save it:\n` +
        `  mkdir -p "${path.dirname(file)}" && printf '%s' 'TOKEN' > "${file}" && chmod 600 "${file}"`,
    );
  }
  if (!token) throw new UserError(`Jira token file is empty: ${file}`);
  return token;
}

/** True when the token file is readable by group or others. */
export function tokenFileTooOpen(config: Config): boolean {
  try {
    return (fs.statSync(expandHome(config.jira.tokenFile)).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
