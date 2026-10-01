import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_FILE, DEFAULT_VAULT, INBOX_FILE, PROJECTS_DIR, STATE_DIR,
  defaultConfig, loadConfig, readToken, tokenFileTooOpen, tokenSource,
} from "./config.ts";
import { getMyself } from "./jira/api.ts";
import { ATTACHMENTS_DIR } from "./jira/attachments.ts";
import { JiraClient } from "./jira/client.ts";
import { LOCAL_STATUSES } from "./jira/mapping.ts";
import { openInEditor } from "./open.ts";
import { BOARD_ORDER, jiraAhead, priorityOf, refreshInbox } from "./render/inbox.ts";
import { renderReport } from "./report.ts";
import { startServer } from "./serve/server.ts";
import { runImport } from "./sync/import.ts";
import { jiraAuth, runSync } from "./sync/run.ts";
import type { SyncOptions, SyncReport } from "./sync/run.ts";
import { UserError, cloudSyncedMarker, expandHome, nowStamp, readTextIfExists, slugify, today, writeFileAtomic } from "./util.ts";
import { dumpFrontmatter, parseFrontmatter, setFrontmatterKeys } from "./vault/frontmatter.ts";
import { EMPTY_TREE, assertLocalOnly, commitAll, commitPaths, git, gitInteractive, head, initRepo, isRepo, remotes } from "./vault/git.ts";
import { loadState, saveState, unreadByTicket } from "./vault/state.ts";
import { NOTES_FILE, SYNC_OWNED, TICKET_FILE, listTickets, notesStub, requireTicket } from "./vault/store.ts";

const out = (line = ""): void => console.log(line);

export function cmdInit(
  target: string | undefined,
  opts: { jiraUrl?: string; project?: string; localPrefix?: string; force?: boolean; cloud?: boolean; importOnly?: boolean },
): void {
  const vault = path.resolve(expandHome(target ?? DEFAULT_VAULT));
  const cloud = cloudSyncedMarker(vault);
  if (cloud && !opts.force) {
    throw new UserError(`${vault} looks cloud-synced ("${cloud}"). Jira content would leave this machine. Pick a local folder.`);
  }
  if (fs.existsSync(path.join(vault, CONFIG_FILE))) throw new UserError(`${vault} is already a Local Flow vault.`);
  fs.mkdirSync(path.join(vault, PROJECTS_DIR), { recursive: true });
  writeFileAtomic(path.join(vault, CONFIG_FILE), JSON.stringify(defaultConfig(opts), null, 2) + "\n");
  writeFileAtomic(path.join(vault, ".gitignore"), `${STATE_DIR}/\n${INBOX_FILE}\n.DS_Store\n`);
  if (!isRepo(vault)) initRepo(vault);
  assertLocalOnly(vault);
  commitPaths(vault, [CONFIG_FILE, ".gitignore"], "init: Local Flow vault");
  out(`Created vault: ${vault}`);
  out(`Next: edit ${path.join(vault, CONFIG_FILE)} (Jira URL, projects, JQL presets), save a read-only token, then run \`lf doctor\`.`);
}

export async function cmdDoctor(vault: string, opts: { offline?: boolean }): Promise<number> {
  let failed = false;
  const check = (ok: boolean, label: string, detail = ""): void => {
    if (!ok) failed = true;
    out(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  const runtime = "Bun" in globalThis ? `Bun ${(globalThis as any).Bun.version}` : `Node ${process.versions.node}`;
  check(true, "runtime", runtime);
  try {
    check(true, "git", git(process.cwd(), ["--version"]).trim());
  } catch (e) {
    check(false, "git", (e as Error).message);
  }
  check(fs.existsSync(path.join(vault, CONFIG_FILE)), "vault", vault);
  if (!fs.existsSync(path.join(vault, CONFIG_FILE))) return 1;

  const cloud = cloudSyncedMarker(vault);
  check(!cloud, "vault is not in a cloud-synced folder", cloud ? `path contains "${cloud}"` : "");
  check(isRepo(vault), "vault is a git repository");
  if (isRepo(vault)) {
    const r = remotes(vault);
    check(r.length === 0, "vault has no git remote", r.join(", "));
  }

  const config = loadConfig(vault);
  const projects = Object.entries(config.projects).map(([name, p]) => `${name} (${p.source})`);
  check(projects.length > 0, "projects", projects.join(", "));
  check(true, "Jira flavor", `${config.jira.flavor}, rich text as ${config.jira.textFormat}`);
  if (config.jira.transport === "import") {
    check(true, "network", "loopback only — lf opens no outbound connections; tickets arrive via `lf import`");
    return failed ? 1 : 0;
  }
  let token = "";
  try {
    token = readToken(config);
    check(!tokenFileTooOpen(config), "token", tokenFileTooOpen(config) ? `run: chmod 600 ${config.jira.tokenFile}` : tokenSource(config));
  } catch (e) {
    check(false, "token", (e as Error).message.split("\n")[0]);
  }
  if (token && !opts.offline) {
    try {
      const me = await getMyself(new JiraClient(config.jira.baseUrl, jiraAuth(config), config.jira.userAgent, false));
      check(true, "Jira access", `${config.jira.baseUrl} as ${me.displayName} (${me.key || me.accountId || me.name})`);
    } catch (e) {
      check(false, "Jira access", (e as Error).message);
    }
  }
  return failed ? 1 : 0;
}

export async function cmdSync(vault: string, opts: SyncOptions): Promise<number> {
  const config = loadConfig(vault);
  const report = await runSync(vault, config, { ...opts, log: out });
  printReport(vault, report, !!opts.dryRun);
  return 0;
}

export async function cmdImport(vault: string, files: string[], opts: { dryRun?: boolean; force?: boolean }): Promise<number> {
  const config = loadConfig(vault);
  const report = await runImport(vault, config, files, { ...opts, log: out });
  printReport(vault, report, !!opts.dryRun);
  return 0;
}

function printReport(vault: string, report: SyncReport, dryRun: boolean): void {
  const by = (kind: string) => report.actions.filter((a) => a.kind === kind);
  out();
  out(dryRun ? "DRY RUN — nothing was written" : `Vault: ${vault}`);
  out(`new ${by("create").length} · updated ${by("update").length} · re-rendered ${by("rerender").length} · unchanged ${by("skip").length}`);
  for (const a of [...by("create"), ...by("update")]) out(`  ${a.key}: ${a.events.join("; ")}`);
  for (const w of report.warnings) out(`  WARN ${w}`);
  if (report.commit) out(`Commit: ${report.commit.slice(0, 10)}  (see \`lf inbox\`, \`lf diff KEY\`)`);
}

export function cmdInbox(vault: string): void {
  const tickets = new Map(listTickets(vault).map((t) => [t.key, t]));
  const unread = unreadByTicket(vault, loadState(vault));
  refreshInbox(vault);
  if (unread.size === 0) {
    out("Nothing new.");
    return;
  }
  for (const [key, events] of unread) {
    out(`${key}  ${tickets.get(key)?.title ?? "(ticket folder missing)"}`);
    for (const e of events) out(`    ${e.date}  ${e.text}`);
  }
  out();
  out(`${unread.size} unread. \`lf diff KEY\` shows the changes, \`lf seen KEY\` / \`lf seen --all\` marks them read.`);
}

export function cmdSeen(vault: string, keys: string[], all: boolean): void {
  const sha = head(vault);
  if (!sha) throw new UserError("The vault has no commits yet — run `lf sync` first.");
  const state = loadState(vault);
  const targets = all ? listTickets(vault).map((t) => t.key) : keys.map((k) => requireTicket(vault, k).key);
  if (targets.length === 0) throw new UserError("Usage: lf seen KEY [KEY...] | lf seen --all");
  for (const key of targets) state.seen[key] = sha;
  saveState(vault, state);
  refreshInbox(vault);
  out(`Marked ${targets.length} ticket(s) as seen.`);
}

export function cmdDiff(vault: string, rawKey: string, passthrough: string[]): number {
  const t = requireTicket(vault, rawKey);
  const state = loadState(vault);
  const base = state.seen[t.key] ?? EMPTY_TREE;
  // raw/issue.json is left out: it repeats ticket.md in a noisier form.
  const paths = t.source === "jira" ? [`${t.rel}/${TICKET_FILE}`, `${t.rel}/${ATTACHMENTS_DIR}`] : [t.rel];
  return gitInteractive(vault, ["diff", ...passthrough, base, "HEAD", "--", ...paths]);
}

export function cmdLs(
  vault: string,
  opts: { status?: string; mine?: boolean; project?: string; unread?: boolean; all?: boolean },
): void {
  const config = loadConfig(vault);
  const unread = unreadByTicket(vault, loadState(vault));
  let tickets = listTickets(vault);
  if (opts.project) tickets = tickets.filter((t) => t.project === opts.project);
  if (opts.mine) tickets = tickets.filter((t) => t.source === "local" || t.fm.mine === true);
  if (opts.unread) tickets = tickets.filter((t) => unread.has(t.key));
  if (opts.status) tickets = tickets.filter((t) => t.status === opts.status);
  else if (!opts.all) tickets = tickets.filter((t) => t.status !== "done" && t.status !== "archived");
  if (tickets.length === 0) {
    out("No tickets match.");
    return;
  }
  const keyWidth = Math.max(...tickets.map((t) => t.key.length));
  const jiraWidth = Math.max(...tickets.map((t) => String(t.fm.jira_status ?? "local").length));
  const statuses = [...BOARD_ORDER, ...new Set(tickets.map((t) => t.status).filter((s) => !BOARD_ORDER.includes(s)))];
  for (const status of statuses) {
    const group = tickets.filter((t) => t.status === status);
    if (group.length === 0) continue;
    out(`${status} (${group.length})`);
    for (const t of group) {
      const ahead = jiraAhead(t, config);
      const flags = [
        t.source === "jira" && t.fm.mine === false ? `[${t.fm.assignee}]` : "",
        ahead ? `[Jira is ahead: ${ahead}]` : "",
      ].filter(Boolean).join(" ");
      out(
        `  ${unread.has(t.key) ? "●" : " "} ${t.key.padEnd(keyWidth)}  ${priorityOf(t).padEnd(2)}  ` +
          `${String(t.fm.jira_status ?? "local").padEnd(jiraWidth)}  ${t.title}${flags ? `  ${flags}` : ""}`,
      );
    }
  }
}

export function cmdStatus(vault: string, rawKey: string, status: string, extra: Record<string, string> = {}): void {
  if (!(LOCAL_STATUSES as readonly string[]).includes(status)) {
    throw new UserError(`Unknown status "${status}". Use one of: ${LOCAL_STATUSES.join(", ")}.`);
  }
  const t = requireTicket(vault, rawKey);
  const notesPath = path.join(t.dir, NOTES_FILE);
  const text = readTextIfExists(notesPath) ?? notesStub(t.key, status);
  const current = parseFrontmatter(text).data;
  const updates: Record<string, string> = { status };
  for (const [k, v] of Object.entries(extra)) if (current[k] === undefined) updates[k] = v;
  writeFileAtomic(notesPath, setFrontmatterKeys(text, updates));
  refreshInbox(vault);
  out(`${t.key}: ${t.status} → ${status}`);
}

export function cmdStart(vault: string, rawKey: string): void {
  cmdStatus(vault, rawKey, "inprogress", { taken: today() });
}

export function cmdPath(vault: string, rawKey: string): void {
  out(requireTicket(vault, rawKey).dir);
}

export function cmdOpen(vault: string, rawKey: string | undefined): void {
  openInEditor(rawKey ? requireTicket(vault, rawKey).dir : vault);
}

export function cmdNote(vault: string, rawKey: string, rawName: string): void {
  const t = requireTicket(vault, rawKey);
  const base = rawName.replace(/\.md$/i, "");
  const name = /^[\p{L}\p{N}_.-]+$/u.test(base) ? base : slugify(base);
  if (!name) throw new UserError("Note name is empty.");
  if (SYNC_OWNED.includes(name) || SYNC_OWNED.includes(`${name}.md`)) {
    throw new UserError(`"${name}" is reserved for the sync. Pick another name.`);
  }
  const file = path.join(t.dir, `${name}.md`);
  if (fs.existsSync(file)) throw new UserError(`${file} already exists.`);
  writeFileAtomic(file, dumpFrontmatter({ ticket: t.key, type: "Note", created: today() }) + `\n# ${t.key} — ${base}\n\n`);
  out(file);
}

export function cmdCommit(vault: string, message: string | undefined): void {
  assertLocalOnly(vault);
  const sha = commitAll(vault, message ?? `notes: ${nowStamp()}`);
  out(sha ? `Committed ${sha.slice(0, 10)}` : "Nothing to commit.");
}

export function cmdReport(vault: string, opts: { date?: string; write?: boolean }): void {
  const date = opts.date ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UserError(`--date must be YYYY-MM-DD (got "${date}")`);
  const text = renderReport(vault, date);
  if (opts.write) {
    const file = path.join(vault, "reports", `${date}.md`);
    writeFileAtomic(file, text);
    out(file);
    return;
  }
  process.stdout.write(text);
}

export function cmdCreate(vault: string, prefix: string, title: string, opts: { type?: string; priority?: string }): void {
  const config = loadConfig(vault);
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) throw new UserError(`Prefix must look like WORK or LF2 (got "${prefix}").`);
  if (config.projects[prefix]?.source === "jira") {
    throw new UserError(`${prefix} is a Jira project: its tickets come from the sync, not from \`lf create\`.`);
  }
  if (!title.trim()) throw new UserError('Usage: lf create PREFIX "title"');
  const numbers = listTickets(vault)
    .filter((t) => t.project === prefix)
    .map((t) => Number(t.key.slice(prefix.length + 1)));
  const next = Math.max(0, ...numbers) + 1;
  const key = `${prefix}-${String(next).padStart(3, "0")}`;
  const slug = slugify(title);
  const dir = path.join(vault, PROJECTS_DIR, prefix, slug ? `${key}-${slug}` : key);
  const fm = { id: key, title: title.trim(), type: opts.type ?? "Task", source: "local", priority: opts.priority ?? "P2", created: today() };
  writeFileAtomic(path.join(dir, TICKET_FILE), dumpFrontmatter(fm) + `\n# ${key}: ${title.trim()}\n\n`);
  writeFileAtomic(path.join(dir, NOTES_FILE), notesStub(key, "inbox"));
  refreshInbox(vault);
  out(`${key}  ${dir}`);
}

export async function cmdServe(vault: string, opts: { port?: number; open?: boolean }): Promise<void> {
  const server = await startServer(vault, { port: opts.port, log: out });
  const { port } = server.address() as { port: number };
  out("Press Ctrl+C to stop.");
  if (opts.open) openInEditor(`http://127.0.0.1:${port}/`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
