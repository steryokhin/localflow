import type { ProjectConfig } from "../config.ts";

export const LOCAL_STATUSES = ["inbox", "inprogress", "inreview", "done", "archived"] as const;
export type LocalStatus = (typeof LOCAL_STATUSES)[number];

/** Local progress order, used to notice when Jira is further along than the local status. */
export const STATUS_RANK: Record<string, number> = { inbox: 0, inprogress: 1, inreview: 2, done: 3, archived: 4 };

const CATEGORY_TO_LOCAL: Record<string, LocalStatus> = {
  "to do": "inbox",
  new: "inbox",
  "in progress": "inprogress",
  indeterminate: "inprogress",
  done: "done",
};

const PRIORITY_P1 = new Set([
  "blocker", "critical", "highest", "high", "major", "very high", "urgent",
  "p0", "p1", "prio 1", "critical 1", "critical 2", "p1 - high impact",
]);
const PRIORITY_P3 = new Set([
  "low", "lowest", "minor", "trivial", "bottom of the list",
  "p4", "prio 4", "prio 5", "p3 - low impact",
]);

export function mapPriority(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (PRIORITY_P1.has(n)) return "P1";
  if (PRIORITY_P3.has(n)) return "P3";
  return "P2";
}

export function mapLocalStatus(category: string, statusName: string, project?: ProjectConfig): LocalStatus {
  const override = project?.statusOverrides?.[statusName.trim().toLowerCase()];
  if (override && (LOCAL_STATUSES as readonly string[]).includes(override)) return override as LocalStatus;
  return CATEGORY_TO_LOCAL[category.trim().toLowerCase()] ?? "inbox";
}

/**
 * The sprint field is either a list of objects or a list of strings like
 * `com.atlassian.greenhopper.service.sprint.Sprint@abc[id=1,name=Sprint 42,...]`.
 * Returns the most recent sprint name.
 */
export function extractSprint(field: unknown): string | null {
  const names: string[] = [];
  const visit = (item: unknown): void => {
    if (item && typeof item === "object" && "name" in item) {
      const name = (item as { name?: unknown }).name;
      if (name) names.push(String(name));
    } else if (typeof item === "string") {
      const m = /name=([^,\]]+)/.exec(item);
      names.push(m ? m[1] : item);
    }
  };
  if (Array.isArray(field)) field.forEach(visit);
  else visit(field);
  return names.at(-1) ?? null;
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes ? `${hours}h${minutes}m` : `${hours}h`;
}

export interface IssueLink {
  relation: string;
  key: string;
  summary: string;
}

export function collectIssueLinks(issuelinks: any[] | null | undefined): IssueLink[] {
  const out: IssueLink[] = [];
  for (const link of issuelinks ?? []) {
    const other = link.outwardIssue ?? link.inwardIssue;
    if (!other?.key) continue;
    const phrase: string = (link.outwardIssue ? link.type?.outward : link.type?.inward) ?? "relates to";
    out.push({ relation: phrase.toLowerCase(), key: other.key, summary: other.fields?.summary ?? "" });
  }
  return out.sort((a, b) => a.relation.localeCompare(b.relation) || compareKeys(a.key, b.key));
}

/** `blocked by` -> `blocked_by`, for frontmatter keys. */
export function relationKey(relation: string): string {
  return relation.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "related";
}

/** Order ticket keys by project prefix, then numerically. */
export function compareKeys(a: string, b: string): number {
  const pa = /^(.*)-(\d+)$/.exec(a);
  const pb = /^(.*)-(\d+)$/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  return pa[1].localeCompare(pb[1]) || Number(pa[2]) - Number(pb[2]);
}
