// Renders the generated ticket.md for a Jira issue.
// Output must be deterministic for a given issue: the file lives in git and every byte that
// changes shows up as "something new". Volatile fields (votes, watches, sync time) stay out.

import type { JiraIssue, JiraUser } from "../jira/api.ts";
import type { ProjectConfig } from "../config.ts";
import type { AttachmentPlan } from "../jira/attachments.ts";
import { ATTACHMENTS_DIR, attachmentResolver } from "../jira/attachments.ts";
import { collectIssueLinks, extractSprint, formatDuration, mapPriority, relationKey } from "../jira/mapping.ts";
import { richTextToMarkdown } from "../jira/richtext.ts";
import type { TextFlavor } from "../jira/richtext.ts";
import { dumpFrontmatter } from "../vault/frontmatter.ts";
import type { Frontmatter } from "../vault/frontmatter.ts";
import { formatBytes } from "../util.ts";

export interface RenderContext {
  baseUrl: string;
  /** Field id -> human name. */
  names: Record<string, string>;
  project?: ProjectConfig;
  me: JiraUser | null;
  ignoreFields: string[];
  attachments: AttachmentPlan[];
  /** How plain-string rich text is read: wiki markup (Data Center) or Markdown (Rovo output). */
  textFormat: TextFlavor;
}

/** Fields rendered explicitly elsewhere in the document. */
const HANDLED_FIELDS = new Set([
  "summary", "description", "status", "priority", "labels", "components", "created", "updated",
  "resolutiondate", "duedate", "resolution", "assignee", "reporter", "comment", "issuetype",
  "issuelinks", "subtasks", "parent", "fixVersions", "versions", "attachment",
  "timeoriginalestimate", "timespent",
]);

/** Fields that change without the ticket meaningfully changing, or carry no information. */
const NOISY_FIELDS = new Set([
  "votes", "watches", "lastViewed", "worklog", "timetracking", "progress", "aggregateprogress",
  "aggregatetimeestimate", "aggregatetimeoriginalestimate", "aggregatetimespent", "timeestimate",
  "workratio", "project", "creator", "archivedby", "archiveddate", "thumbnail",
]);

export function issueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/browse/${key}`;
}

export function isMine(issue: JiraIssue, me: JiraUser | null): boolean {
  const a = issue.fields.assignee;
  if (!a || !me) return false;
  const same = (mine: string, theirs: unknown): boolean => !!mine && typeof theirs === "string" && theirs === mine;
  return (
    same(me.accountId, a.accountId) ||
    same(me.emailAddress, a.emailAddress) ||
    same(me.key, a.key) ||
    same(me.name, a.name) ||
    same(me.displayName, a.displayName)
  );
}

function shortDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

function nameOf(obj: any): string | null {
  return obj?.displayName ?? obj?.name ?? null;
}

export function buildFrontmatter(issue: JiraIssue, ctx: RenderContext): Frontmatter {
  const f = issue.fields;
  const ids = ctx.project?.fields ?? {};
  const fm: Frontmatter = {};
  const put = (key: string, value: unknown): void => {
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    fm[key] = value as Frontmatter[string];
  };
  const namesOf = (list: any[] | undefined): string[] => (list ?? []).map((x) => x?.name).filter(Boolean);

  put("id", issue.key);
  put("title", (f.summary ?? "").trim());
  put("type", f.issuetype?.name ?? "Task");
  put("source", "jira");
  put("jira_url", issueUrl(ctx.baseUrl, issue.key));
  put("jira_status", f.status?.name ?? "Open");
  put("jira_status_category", f.status?.statusCategory?.name ?? "To Do");
  put("jira_priority", f.priority?.name);
  put("priority", mapPriority(f.priority?.name));
  put("resolution", f.resolution?.name);
  put("created", f.created);
  put("updated", f.updated);
  put("resolved", f.resolutiondate);
  put("due_date", f.duedate);
  put("assignee", nameOf(f.assignee) ?? "unassigned");
  put("reporter", nameOf(f.reporter));
  fm.mine = isMine(issue, ctx.me);
  if (ids.epicLink && typeof f[ids.epicLink] === "string") put("epic_link", f[ids.epicLink]);
  put("parent", f.parent?.key);
  put("subtasks", (f.subtasks ?? []).map((s: any) => s.key).filter(Boolean));
  if (ids.sprint) put("sprint", extractSprint(f[ids.sprint]));
  if (ids.storyPoints) put("story_points", f[ids.storyPoints]);
  put("fix_versions", namesOf(f.fixVersions));
  put("affects_versions", namesOf(f.versions));
  put("components", namesOf(f.components));
  put("labels", [...(f.labels ?? [])]);
  put("time_estimate", formatDuration(f.timeoriginalestimate));
  put("time_spent", formatDuration(f.timespent));

  const byRelation = new Map<string, string[]>();
  for (const link of collectIssueLinks(f.issuelinks)) {
    const key = relationKey(link.relation);
    byRelation.set(key, [...(byRelation.get(key) ?? []), link.key]);
  }
  for (const [relation, keys] of byRelation) if (!(relation in fm)) put(relation, keys);
  return fm;
}

/** Render a custom field value as one line of text; null when there is nothing to show. */
export function formatFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    // Java object dumps carry a per-request identity hash; keep only the stable name.
    const javaDump = /^[\w.]+@[0-9a-f]+\[(.*)\]$/s.exec(s);
    if (javaDump) return /name=([^,\]]+)/.exec(javaDump[1])?.[1] ?? javaDump[1];
    return s;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(formatFieldValue).filter((x): x is string => !!x);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const o = value as Record<string, any>;
    if (o.type === "doc") return "\n" + JSON.stringify(value); // ADF: rendered as a block by the caller
    const label = o.displayName ?? o.value ?? o.name ?? o.key;
    if (label === undefined || label === null) return JSON.stringify(value);
    const child = o.child ? formatFieldValue(o.child) : null;
    return child ? `${label} / ${child}` : String(label);
  }
  return null;
}

/** Non-empty fields not covered by dedicated sections, as [human name, value] sorted by name. */
export function otherFields(issue: JiraIssue, ctx: RenderContext): [string, string][] {
  const ids = ctx.project?.fields ?? {};
  const dedicated = new Set(Object.values(ids).filter(Boolean) as string[]);
  const ignored = new Set(ctx.ignoreFields.map((x) => x.toLowerCase()));
  const out: [string, string][] = [];
  for (const [id, value] of Object.entries(issue.fields)) {
    if (HANDLED_FIELDS.has(id) || NOISY_FIELDS.has(id) || dedicated.has(id)) continue;
    const name = ctx.names[id] ?? id;
    if (ignored.has(id.toLowerCase()) || ignored.has(name.toLowerCase())) continue;
    const text = formatFieldValue(value);
    if (!text || /^\d\|[0-9a-z]+:/.test(text)) continue; // LexoRank values
    out.push([name, text]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

export function renderTicket(issue: JiraIssue, ctx: RenderContext): string {
  const f = issue.fields;
  const ids = ctx.project?.fields ?? {};
  const resolve = attachmentResolver(ctx.attachments);
  const wiki = (text: unknown): string =>
    richTextToMarkdown(text, { flavor: ctx.textFormat, resolveAttachment: resolve, headingShift: 2 });
  const link = (key: string): string => `[${key}](${issueUrl(ctx.baseUrl, key)})`;

  const fm = buildFrontmatter(issue, ctx);
  const parts: string[] = [
    dumpFrontmatter(fm),
    `# ${issue.key}: ${fm.title ?? ""}`,
    "",
    `${link(issue.key)} · **${fm.type}** · **${fm.jira_status}** · Priority: ${fm.jira_priority ?? "—"}  `,
    `Assignee: ${fm.assignee} · Reporter: ${fm.reporter ?? "unknown"}`,
    "",
    "## Description",
    "",
    wiki(f.description) || "_(no description)_",
    "",
  ];

  const ac = ids.acceptanceCriteria ? wiki(f[ids.acceptanceCriteria]) : "";
  if (ac) parts.push("## Acceptance Criteria", "", ac, "");
  const steps = ids.stepsToReproduce ? wiki(f[ids.stepsToReproduce]) : "";
  if (steps) parts.push("## Steps to Reproduce", "", steps, "");

  const others = otherFields(issue, ctx);
  if (others.length) {
    parts.push("## Other fields", "");
    for (const [name, text] of others) {
      if (text.startsWith("\n{")) parts.push(`**${name}:**`, "", wiki(JSON.parse(text.slice(1))), "");
      else if (text.includes("\n")) parts.push(`**${name}:**`, "", wiki(text), "");
      else parts.push(`- **${name}:** ${text}`);
    }
    parts.push("");
  }

  const related: string[] = [];
  if (fm.epic_link) related.push(`- epic: ${link(String(fm.epic_link))}`);
  if (f.parent?.key) related.push(`- parent: ${link(f.parent.key)} — ${f.parent.fields?.summary ?? ""}`.trimEnd());
  for (const s of f.subtasks ?? []) {
    if (s.key) related.push(`- subtask: ${link(s.key)} — ${s.fields?.summary ?? ""}`.trimEnd());
  }
  for (const l of collectIssueLinks(f.issuelinks)) {
    related.push(`- ${l.relation}: ${link(l.key)} — ${l.summary}`.replace(/ — $/, ""));
  }
  if (related.length) parts.push("## Related issues", "", ...related, "");

  if (ctx.attachments.length) {
    parts.push("## Attachments", "");
    for (const a of ctx.attachments) {
      const meta = `${a.author}, ${shortDate(a.created)}, ${formatBytes(a.size)}`;
      parts.push(
        a.skipReason
          ? `- ${a.filename} — ${meta} _(${a.skipReason})_`
          : `- [${a.filename}](${ATTACHMENTS_DIR}/${a.localName}) — ${meta}`,
      );
    }
    parts.push("");
  }

  const comments: any[] = f.comment?.comments ?? [];
  if (comments.length) {
    parts.push(`## Comments (${comments.length})`, "");
    for (const c of comments) {
      const edited = c.updated && c.updated !== c.created ? ` (edited ${shortDate(c.updated)})` : "";
      parts.push(`### ${nameOf(c.author) ?? "unknown"} — ${shortDate(c.created)}${edited}`, "", wiki(c.body), "");
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
