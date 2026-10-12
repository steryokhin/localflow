import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_FILE, DEFAULT_VAULT, INBOX_FILE, PROJECTS_DIR, STATE_DIR,
  defaultConfig, loadConfig, readToken, tokenSource,
} from "./config.ts";
import type { Config } from "./config.ts";
import { getMyself, probeSearch } from "./jira/api.ts";
import { ATTACHMENTS_DIR } from "./jira/attachments.ts";
import { JiraClient } from "./jira/client.ts";
import { LOCAL_STATUSES } from "./jira/mapping.ts";
import { openInEditor } from "./open.ts";
import { BOARD_ORDER, jiraAhead, priorityOf, refreshInbox, unreadLines, waitingLine } from "./render/inbox.ts";
import { ACTIONS_FILE, NUDGES_FILE, fmtDue, renderStandup } from "./render/loops.ts";
import { renderReport } from "./report.ts";
import { startServer } from "./serve/server.ts";
import { changeLine, fmtWhen, resolveSince, ticketChanges, unreadChanges } from "./sync/changes.ts";
import type { Change } from "./sync/changes.ts";
import { runImport } from "./sync/import.ts";
import { jiraAuth, runSync } from "./sync/run.ts";
import type { SyncOptions, SyncReport } from "./sync/run.ts";
import { UserError, cloudSyncedMarker, expandHome, nowStamp, readTextIfExists, slugify, today, writeFileAtomic } from "./util.ts";
import { dumpFrontmatter, parseFrontmatter, setFrontmatterKeys } from "./vault/frontmatter.ts";
import { EMPTY_TREE, assertLocalOnly, commitAll, commitPaths, git, gitInteractive, head, initRepo, isRepo, remotes } from "./vault/git.ts";
import { linkFolder, unlinkFolder } from "./vault/links.ts";
import { ME, addLoop, bumpLoop, closeLoop, readLoops, syncLoops } from "./vault/loops.ts";
import type { Loop } from "./vault/loops.ts";
import { appendTicketLog, setTracked } from "./vault/notes.ts";
import { beginWork, repoOf, setRepo } from "./vault/scaffold.ts";
import { launchdPlist, refreshActions, watchOnce } from "./watch.ts";
import { loadState, saveState, unreadByTicket } from "./vault/state.ts";
import type { State, UnreadEvent } from "./vault/state.ts";
import { SMART_GROUPS, inSmartGroup, waitingByKey } from "./vault/smart.ts";
import type { SmartGroup } from "./vault/smart.ts";
import { NOTES_FILE, SYNC_OWNED, TICKET_FILE, listTickets, notesStub, requireTicket } from "./vault/store.ts";
import type { Ticket } from "./vault/store.ts";

// Ticket text comes from other people (Jira titles, comments): control characters are dropped
// before anything reaches the terminal, so an escape sequence in a comment cannot drive it.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const terminalSafe = (s: string): string => s.replace(CONTROL_RE, "");
const out = (line = ""): void => console.log(terminalSafe(line));

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
  writeFileAtomic(path.join(vault, ".gitignore"), `${STATE_DIR}/\n${INBOX_FILE}\n/${ACTIONS_FILE}\n/${NUDGES_FILE}\n.DS_Store\n`);
  if (!isRepo(vault)) initRepo(vault);
  assertLocalOnly(vault);
  commitPaths(vault, [CONFIG_FILE, ".gitignore"], "init: Local Flow vault");
  out(`Created vault: ${vault}`);
  out(`Next: edit ${path.join(vault, CONFIG_FILE)} (Jira URL, projects, JQL presets), set jira.tokenCommand (password manager), then run \`lf doctor\`.`);
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
    check(true, "token", tokenSource(config));
  } catch (e) {
    check(false, "token", (e as Error).message.split("\n")[0]);
  }
  if (token && !opts.offline) {
    try {
      const client = new JiraClient(config.jira.baseUrl, jiraAuth(config), config.jira.userAgent, false);
      const me = await getMyself(client, config.jira.flavor);
      check(true, "Jira access", `${config.jira.baseUrl} as ${me.displayName} (${me.key || me.accountId || me.name})`);
      try {
        await probeSearch(client, config.jira.flavor);
        check(true, "Jira search", config.jira.flavor === "cloud" ? "/rest/api/3/search/jql" : "/rest/api/2/search");
      } catch (e) {
        check(false, "Jira search", `${(e as Error).message.split("\n")[0]} — is jira.flavor right? Cloud needs "cloud" (v3 API)`);
      }
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

export function cmdInbox(vault: string, group?: string): void {
  const config = loadConfig(vault);
  const state = loadState(vault);
  const tickets = listTickets(vault);
  const unread = unreadByTicket(vault, state);
  refreshInbox(vault);
  if (group !== undefined) return printSmartGroup(vault, group, tickets, unread, config, state);
  if (unread.size === 0) {
    out("Nothing new.");
    return;
  }
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const changes = unreadChanges(vault, tickets, unread.keys(), config, state);
  for (const [key, events] of unread) {
    out(`${key}  ${byKey.get(key)?.title ?? "(ticket folder missing)"}`);
    for (const line of unreadLines(events, changes.get(key))) out(`    ${line}`);
  }
  out();
  out(`${unread.size} unread. \`lf diff KEY\` shows the changes, \`lf seen KEY\` / \`lf seen --all\` marks them read.`);
}

function printSmartGroup(
  vault: string, raw: string, tickets: Ticket[], unread: Map<string, UnreadEvent[]>, config: Config, state: State,
): void {
  const group = (raw === "tracking" ? "tracked" : raw) as SmartGroup;
  if (!SMART_GROUPS.includes(group)) throw new UserError(`Unknown group "${raw}". Use one of: ${SMART_GROUPS.join(", ")}.`);
  const waiting = waitingByKey(readLoops(vault));
  const members = tickets.filter((t) => inSmartGroup(group, t, unread.has(t.key), waiting));
  if (!members.length) {
    out(`Nothing in "${group}".`);
    return;
  }
  const changes = unreadChanges(vault, members, members.map((t) => t.key).filter((k) => unread.has(k)), config, state);
  const now = new Date();
  for (const t of members) {
    out(`${unread.has(t.key) ? "●" : " "} ${t.key}  ${t.title}  [${t.status}]`);
    if (unread.has(t.key)) for (const line of unreadLines(unread.get(t.key)!, changes.get(t.key))) out(`      ${line}`);
    for (const l of waiting.get(t.key) ?? []) out(`      ⏳ ${waitingLine(l, now)}`);
  }
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

/**
 * What changed in a ticket since the "seen" mark (or --since a commit or date): fields was → now,
 * comments in full, attachments, changed text blocks. With --git, a plain `git diff` instead.
 */
export function cmdDiff(vault: string, rawKey: string, opts: { since?: string; git?: string[] }): number {
  const t = requireTicket(vault, rawKey);
  const state = loadState(vault);
  const seen = state.seen[t.key] ?? null;
  const base = opts.since ? resolveSince(vault, opts.since) : seen;
  if (opts.git) {
    // raw/issue.json is left out: it repeats ticket.md in a noisier form.
    const paths = t.source === "jira" ? [`${t.rel}/${TICKET_FILE}`, `${t.rel}/${ATTACHMENTS_DIR}`] : [t.rel];
    return gitInteractive(vault, ["diff", ...opts.git, base ?? EMPTY_TREE, "HEAD", "--", ...paths]);
  }
  if (t.source !== "jira") {
    out(`${t.key} is a local ticket: nothing comes from Jira. \`lf diff ${t.key} --git\` shows the file history.`);
    return 0;
  }
  const changes = ticketChanges(vault, t, base, { text: true, state });
  const since = opts.since ? `since ${opts.since}` : seen ? "since you last marked it seen" : "since it arrived";
  out(`${t.key}  ${t.title}`);
  out(`Changes ${since}:`);
  if (!changes.items.length && !changes.blocks.length) {
    out("  nothing");
    return 0;
  }
  const kinds: Array<[string, Array<Change["kind"]>]> = [["Fields", ["new", "field", "links"]], ["Comments", ["comment"]], ["Attachments", ["attachment"]]];
  for (const [title, ks] of kinds) {
    const items = changes.items.filter((c) => ks.includes(c.kind));
    if (!items.length) continue;
    out();
    out(title);
    for (const c of items) {
      if (c.kind === "comment" && c.body !== undefined) {
        out(`  ${fmtWhen(c.date)} ${c.who}${c.text.includes("edited") ? " (edited)" : ""}:`);
        for (const line of wrap(c.body, 96)) out(`      ${line}`);
      } else out(`  ${changeLine(c)}`);
    }
  }
  let section = "";
  for (const b of changes.blocks) {
    if (b.section !== section) {
      section = b.section;
      out();
      out(section);
    }
    if (b.was !== undefined) for (const line of b.was.split("\n")) out(`  - ${line}`);
    for (const line of b.now.split("\n")) out(`  + ${line}`);
    out();
  }
  return 0;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (cur && cur.length + word.length + 1 > width) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
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
  for (const rel of beginWork(vault, requireTicket(vault, rawKey))) out(`  created ${rel}`);
}

export function cmdRepo(vault: string, rawKey: string, name: string | undefined): void {
  const t = requireTicket(vault, rawKey);
  if (!name) {
    const r = repoOf(vault, t);
    out(r ? path.join(vault, r.rel) : `${t.key} has no repo: set it with \`lf repo ${t.key} NAME\``);
    return;
  }
  const r = setRepo(vault, t, name);
  out(`${t.key}: repo ${r.name} → ${path.join(vault, r.rel)}${r.created ? " (created)" : ""}`);
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

/** Relative paths are taken from the current directory; the stored entry is always absolute. */
const absFromCwd = (p: string): string => (p.trim().startsWith("~") ? p : path.resolve(p));

export function cmdLink(vault: string, rawKey: string, folder: string): void {
  const r = linkFolder(vault, rawKey, absFromCwd(folder));
  out(r.added ? `${r.key}: linked ${r.path}` : `${r.key}: ${r.path} is already linked`);
}

export function cmdUnlink(vault: string, rawKey: string, folder: string): void {
  const r = unlinkFolder(vault, rawKey, absFromCwd(folder));
  out(`${r.key}: unlinked ${r.path}`);
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
  process.stdout.write(terminalSafe(text));
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

// ---------- open loops ----------

const workdayEnd = (vault: string): string | undefined => loadConfig(vault).loops?.workdayEnd;

function describeLoop(l: Loop, now: Date): string {
  const whom = l.owner === ME ? "on me" : `waiting for ${l.owner}`;
  return `${l.id} · ${l.key ?? "no ticket"} · ${l.text} · ${whom} · by ${fmtDue(l.due, now)}${l.onExpiry ? ` · else: ${l.onExpiry}` : ""}`;
}

export function cmdLoop(vault: string, text: string, opts: { key?: string; from?: string; by?: string; else?: string }): void {
  if (!opts.by) throw new UserError('Every loop needs a deadline: --by +4h | 18:00 | eod | tomorrow | 2026-10-14 ["12:00"]');
  const now = new Date();
  const loop = addLoop(vault, { text, key: opts.key, owner: opts.from, by: opts.by, onExpiry: opts.else }, now, workdayEnd(vault));
  refreshActions(vault, now);
  out(`loop ${describeLoop(loop, now)}`);
}

async function ask(question: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function cmdDone(vault: string, query: string, outcome: string): Promise<void> {
  const now = new Date();
  const { loop, loggedTo } = closeLoop(vault, query, outcome, now);
  refreshActions(vault, now);
  out(`closed ${loop.id}: ${loop.text} → ${loggedTo}`);
  // Closing a loop usually opens the next one; asked only when a person is at the terminal.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    out(`Next step? lf loop "…" --by WHEN${loop.key ? ` --key ${loop.key}` : ""}`);
    return;
  }
  const text = await ask(`Next loop${loop.key ? ` for ${loop.key}` : ""}? (empty to skip) `);
  if (!text) return;
  const by = await ask("By when? (+4h, 18:00, eod, tomorrow, 2026-10-14) ");
  const from = await ask("Waiting for whom? (empty = me) ");
  cmdLoop(vault, text, { key: loop.key ?? undefined, from: from || undefined, by: by || "eod" });
}

export function cmdBump(vault: string, query: string, by: string | undefined): void {
  if (!by) throw new UserError("Usage: lf bump <id|word> --by WHEN");
  const now = new Date();
  const { loop, was } = bumpLoop(vault, query, by, now, workdayEnd(vault));
  refreshActions(vault, now);
  out(`${loop.id}: by ${fmtDue(loop.due, now)}${was ? ` (was ${was})` : ""} · ${loop.text}`);
}

export function cmdLog(vault: string, rawKey: string, text: string): void {
  if (!text.trim()) throw new UserError('Usage: lf log KEY "what happened"');
  const t = requireTicket(vault, rawKey);
  appendTicketLog(t, nowStamp(), text);
  // A first note puts the ticket on the board; an explicit `lf untrack` is respected.
  if (t.notes.tracked === undefined) setTracked(requireTicket(vault, t.key), true);
  out(`${t.key}: logged`);
}

export function cmdLoops(vault: string): void {
  refreshActions(vault, new Date());
  process.stdout.write(terminalSafe(fs.readFileSync(path.join(vault, ACTIONS_FILE), "utf8")));
}

export function cmdWatch(vault: string, opts: { plist?: boolean; quiet?: boolean }): void {
  if (opts.plist) {
    process.stdout.write(launchdPlist(vault));
    return;
  }
  const r = watchOnce(vault, new Date(), { notify: !opts.quiet });
  const note = r.notified ? " · notified" : r.quiet && (r.fresh.expired.length || r.fresh.soon.length) ? " · quiet hours, no notification" : "";
  out(`expired ${r.expired.length} · within the hour ${r.soon.length}${note} → ${path.join(vault, NUDGES_FILE)}`);
}

export function cmdStandup(vault: string, week: boolean): void {
  const now = new Date();
  process.stdout.write(terminalSafe(renderStandup(vault, syncLoops(vault), listTickets(vault), now, week)));
}

export function cmdTrack(vault: string, rawKey: string, tracked: boolean): void {
  const t = requireTicket(vault, rawKey);
  setTracked(t, tracked);
  refreshActions(vault, new Date());
  out(`${t.key}: ${tracked ? "tracked" : "untracked"}`);
}
