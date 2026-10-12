// What exactly changed in a Jira ticket since a vault commit: fields (was → now), comments with
// author, time and text, attachments, and the changed blocks of description-like sections.
// Built from raw/issue.json and ticket.md at that commit versus now, so any baseline works:
// the user's "seen" mark, a commit, or a date.

import path from "node:path";
import { loadConfig } from "../config.ts";
import type { Config } from "../config.ts";
import type { JiraIssue } from "../jira/api.ts";
import { collectIssueLinks, extractSprint } from "../jira/mapping.ts";
import { richTextSignature, richTextToMarkdown } from "../jira/richtext.ts";
import { diffBlockLists } from "../render/blockdiff.ts";
import { splitBlocks } from "../render/markdown.ts";
import { otherFields } from "../render/ticket.ts";
import type { RenderContext } from "../render/ticket.ts";
import { UserError, readTextIfExists } from "../util.ts";
import { parseFrontmatter } from "../vault/frontmatter.ts";
import { git } from "../vault/git.ts";
import { loadFieldNames, loadState } from "../vault/state.ts";
import type { State } from "../vault/state.ts";
import { RAW_FILE, TICKET_FILE } from "../vault/store.ts";
import type { Ticket } from "../vault/store.ts";

export interface Change {
  kind: "new" | "field" | "text" | "comment" | "attachment" | "links";
  /** ISO time it happened when known: a comment's time, otherwise the issue's "updated". */
  date: string | null;
  who: string | null;
  /** One line: "status: Open → In Progress", "Tom commented: «…»". */
  text: string;
  /** Full plain text of a comment, for the detailed views. */
  body?: string;
}

export interface TextChange {
  section: string;
  state: "new" | "changed";
  now: string;
  was?: string;
}

export interface TicketChanges {
  /** The commit compared against; null when the ticket did not exist then (everything is new). */
  base: string | null;
  items: Change[];
  /** Changed blocks of the text sections (description, acceptance criteria, …). */
  blocks: TextChange[];
}

const EXCERPT = 80;
/** ticket.md sections whose changes are covered by fields, comments and attachments instead. */
const NOT_TEXT = new Set(["Comments", "Attachments", "Other fields", "Related issues"]);

const label = (o: any): string => o?.displayName ?? o?.name ?? "";
const names = (list: any[] | undefined): string => (list ?? []).map((x) => (typeof x === "string" ? x : x?.name)).filter(Boolean).sort().join(", ");
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Rich text as one plain line: Markdown syntax dropped, whitespace collapsed. */
export function plainText(value: unknown, flavor: Config["jira"]["textFormat"]): string {
  return richTextToMarkdown(value, { flavor })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function compareIssues(a: JiraIssue, b: JiraIssue, ctx: RenderContext): Change[] {
  const f0 = a.fields;
  const f1 = b.fields;
  const ids = ctx.project?.fields ?? {};
  const when = (f1.updated as string | undefined) ?? null;
  const out: Change[] = [];
  const field = (name: string, before: string, after: string): void => {
    if (before !== after) out.push({ kind: "field", date: when, who: null, text: `${name}: ${clip(before || "none", 60)} → ${clip(after || "none", 60)}` });
  };
  const text = (name: string, before: unknown, after: unknown): void => {
    if (richTextSignature(before) !== richTextSignature(after)) out.push({ kind: "text", date: when, who: null, text: `${name} changed` });
  };

  field("status", label(f0.status), label(f1.status));
  field("assignee", f0.assignee ? label(f0.assignee) : "unassigned", f1.assignee ? label(f1.assignee) : "unassigned");
  field("priority", label(f0.priority), label(f1.priority));
  field("resolution", label(f0.resolution), label(f1.resolution));
  field("title", richTextSignature(f0.summary), richTextSignature(f1.summary));
  if (ids.sprint) field("sprint", extractSprint(f0[ids.sprint]) ?? "", extractSprint(f1[ids.sprint]) ?? "");
  field("fix versions", names(f0.fixVersions), names(f1.fixVersions));
  field("labels", names(f0.labels), names(f1.labels));
  field("components", names(f0.components), names(f1.components));
  field("due date", f0.duedate ?? "", f1.duedate ?? "");
  text("description", f0.description, f1.description);
  if (ids.acceptanceCriteria) text("acceptance criteria", f0[ids.acceptanceCriteria], f1[ids.acceptanceCriteria]);
  if (ids.stepsToReproduce) text("steps to reproduce", f0[ids.stepsToReproduce], f1[ids.stepsToReproduce]);

  const before = new Map<string, any>((f0.comment?.comments ?? []).map((c: any) => [String(c.id), c]));
  const comments: any[] = f1.comment?.comments ?? [];
  for (const c of comments) {
    const prev = before.get(String(c.id));
    const isNew = !prev;
    if (!isNew && richTextSignature(prev.body) === richTextSignature(c.body)) continue;
    const who = label(c.author) || "someone";
    const body = plainText(c.body, ctx.textFormat);
    out.push({
      kind: "comment",
      date: (isNew ? c.created : c.updated ?? c.created) ?? null,
      who,
      text: `${who} ${isNew ? "commented" : "edited a comment"}: «${clip(body, EXCERPT)}»`,
      body,
    });
  }
  const now = new Set(comments.map((c) => String(c.id)));
  const deleted = [...before.keys()].filter((id) => !now.has(id)).length;
  if (deleted) out.push({ kind: "comment", date: when, who: null, text: `${deleted} comment${deleted > 1 ? "s" : ""} deleted` });

  const oldAtt = new Map<string, any>((f0.attachment ?? []).map((x: any) => [String(x.id), x]));
  const newAtt = new Map<string, any>((f1.attachment ?? []).map((x: any) => [String(x.id), x]));
  for (const [id, x] of newAtt) {
    if (!oldAtt.has(id)) out.push({ kind: "attachment", date: x.created ?? when, who: label(x.author) || null, text: `+ attachment ${x.filename}` });
  }
  for (const [id, x] of oldAtt) if (!newAtt.has(id)) out.push({ kind: "attachment", date: when, who: null, text: `− attachment ${x.filename}` });

  const linkSig = (issue: JiraIssue): string =>
    [
      ...collectIssueLinks(issue.fields.issuelinks).map((l) => `${l.relation}:${l.key}`),
      ...(issue.fields.subtasks ?? []).map((s: any) => `subtask:${s.key}`),
      `parent:${issue.fields.parent?.key ?? ""}`,
    ].join("|");
  if (linkSig(a) !== linkSig(b)) out.push({ kind: "links", date: when, who: null, text: "related issues changed" });

  const o0 = new Map(otherFields(a, ctx));
  const o1 = new Map(otherFields(b, ctx));
  for (const name of [...new Set([...o0.keys(), ...o1.keys()])].sort()) {
    const was = (o0.get(name) ?? "").startsWith("\n") ? "(text)" : o0.get(name) ?? "";
    const is = (o1.get(name) ?? "").startsWith("\n") ? "(text)" : o1.get(name) ?? "";
    if (o0.get(name) !== o1.get(name)) out.push({ kind: "field", date: when, who: null, text: was === is ? `${name} changed` : `${name}: ${clip(was || "none", 60)} → ${clip(is || "none", 60)}` });
  }
  return out;
}

export function renderContext(vault: string, config: Config, state: State, t: Ticket): RenderContext {
  return {
    baseUrl: config.jira.baseUrl,
    names: { ...loadFieldNames(vault), ...config.jira.fieldNames },
    project: config.projects[t.project],
    me: state.me,
    ignoreFields: config.jira.ignoreFields,
    attachments: [],
    textFormat: config.jira.textFormat,
  };
}

function showAt(vault: string, sha: string, rel: string): string | null {
  try {
    return git(vault, ["show", `${sha}:${rel}`]);
  } catch {
    return null;
  }
}

/** Blocks of the text sections of ticket.md, each tagged with its "## " section. */
function sectionBlocks(md: string): Array<{ section: string; src: string }> {
  let section = "";
  const out: Array<{ section: string; src: string }> = [];
  for (const src of splitBlocks(parseFrontmatter(md).body)) {
    const h = /^## (.+?)(?: \(\d+\))?$/.exec(src);
    if (h) {
      section = h[1];
      continue;
    }
    if (section && !NOT_TEXT.has(section)) out.push({ section, src });
  }
  return out;
}

function textChanges(oldMd: string, newMd: string): TextChange[] {
  const a = sectionBlocks(oldMd);
  const b = sectionBlocks(newMd);
  const diff = diffBlockLists(a.map((x) => x.src), b.map((x) => x.src));
  const out: TextChange[] = [];
  diff.forEach((d, i) => {
    if (d.state === "same") return;
    out.push({ section: b[i]?.section ?? "", state: d.state, now: d.src, ...(d.was ? { was: d.was } : {}) });
  });
  return out;
}

/**
 * Changes of one ticket between `base` (a vault commit) and the files on disk now.
 * `opts.text` adds the changed text blocks (one more git call).
 */
export function ticketChanges(vault: string, t: Ticket, base: string | null, opts: { text?: boolean; config?: Config; state?: State } = {}): TicketChanges {
  if (t.source !== "jira") return { base, items: [], blocks: [] };
  const nowRaw = readTextIfExists(path.join(t.dir, RAW_FILE));
  if (nowRaw === null) return { base, items: [], blocks: [] };
  const issue = JSON.parse(nowRaw) as JiraIssue;
  const oldRaw = base ? showAt(vault, base, `${t.rel}/${RAW_FILE}`) : null;
  if (oldRaw === null) {
    return { base: null, items: [{ kind: "new", date: issue.fields.created ?? null, who: label(issue.fields.reporter) || null, text: `new ticket — ${t.title}` }], blocks: [] };
  }
  const config = opts.config ?? loadConfig(vault);
  const state = opts.state ?? loadState(vault);
  const items = compareIssues(JSON.parse(oldRaw) as JiraIssue, issue, renderContext(vault, config, state, t));
  let blocks: TextChange[] = [];
  if (opts.text) {
    const oldMd = showAt(vault, base!, `${t.rel}/${TICKET_FILE}`);
    const newMd = readTextIfExists(path.join(t.dir, TICKET_FILE));
    if (oldMd !== null && newMd !== null) blocks = textChanges(oldMd, newMd);
  }
  return { base, items, blocks };
}

/** The commit a "since" value points at: a sha, or the last commit before a YYYY-MM-DD date. */
export function resolveSince(vault: string, since: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    const sha = git(vault, ["rev-list", "-1", `--before=${since}T00:00:00`, "HEAD"]).trim();
    return sha || null;
  }
  try {
    return git(vault, ["rev-parse", "--verify", "-q", `${since}^{commit}`]).trim();
  } catch {
    throw new UserError(`Not a commit or a date (YYYY-MM-DD): ${since}`);
  }
}

/** "12.10 14:05" in local time. */
export function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** One line of a change for lists: "12.10 14:05 · Tom commented: «…»". */
export function changeLine(c: Change): string {
  const when = c.kind === "comment" || c.kind === "attachment" || c.kind === "new" ? fmtWhen(c.date) : "";
  return when ? `${when} · ${c.text}` : c.text;
}

/** Changes since the "seen" mark for every ticket with unread sync events. */
export function unreadChanges(vault: string, tickets: Ticket[], unreadKeys: Iterable<string>, config: Config, state: State): Map<string, Change[]> {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const out = new Map<string, Change[]>();
  for (const key of unreadKeys) {
    const t = byKey.get(key);
    if (t) out.set(key, ticketChanges(vault, t, state.seen[key] ?? null, { config, state }).items);
  }
  return out;
}

/** Up to `max` change lines, plus a "… N more" line. */
export function summaryLines(items: Change[], max = 3): string[] {
  const lines = items.slice(0, max).map(changeLine);
  if (items.length > max) lines.push(`… ${items.length - max} more`);
  return lines;
}
