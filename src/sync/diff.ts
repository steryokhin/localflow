// Human-readable summary of what changed between two snapshots of a Jira issue.
// The summary goes into the sync commit body and drives `lf inbox`.

import type { JiraIssue } from "../jira/api.ts";
import type { RenderContext } from "../render/ticket.ts";
import { otherFields } from "../render/ticket.ts";
import { collectIssueLinks, extractSprint } from "../jira/mapping.ts";
import { richTextSignature } from "../jira/richtext.ts";

function label(obj: any): string {
  return obj?.displayName ?? obj?.name ?? "none";
}

function names(list: any[] | undefined): string {
  return (list ?? []).map((x) => (typeof x === "string" ? x : x?.name)).filter(Boolean).sort().join(", ");
}

function text(v: unknown): string {
  return richTextSignature(v);
}

export function summarizeChanges(oldIssue: JiraIssue, newIssue: JiraIssue, ctx: RenderContext): string[] {
  const a = oldIssue.fields;
  const b = newIssue.fields;
  const ids = ctx.project?.fields ?? {};
  const events: string[] = [];
  const changed = (what: string, before: string, after: string): void => {
    if (before !== after) events.push(`${what} ${before || "none"} → ${after || "none"}`);
  };

  changed("status", label(a.status), label(b.status));
  changed("assignee", a.assignee ? label(a.assignee) : "unassigned", b.assignee ? label(b.assignee) : "unassigned");
  changed("priority", label(a.priority), label(b.priority));
  changed("resolution", a.resolution ? label(a.resolution) : "", b.resolution ? label(b.resolution) : "");
  if (text(a.summary) !== text(b.summary)) events.push("title changed");
  if (text(a.description) !== text(b.description)) events.push("description changed");
  if (ids.acceptanceCriteria && text(a[ids.acceptanceCriteria]) !== text(b[ids.acceptanceCriteria])) {
    events.push("acceptance criteria changed");
  }
  if (ids.stepsToReproduce && text(a[ids.stepsToReproduce]) !== text(b[ids.stepsToReproduce])) {
    events.push("steps to reproduce changed");
  }
  if (ids.sprint) changed("sprint", extractSprint(a[ids.sprint]) ?? "", extractSprint(b[ids.sprint]) ?? "");
  changed("fix versions", names(a.fixVersions), names(b.fixVersions));
  changed("labels", names(a.labels), names(b.labels));
  changed("due date", a.duedate ?? "", b.duedate ?? "");

  // Comments, matched by id.
  const oldComments = new Map<string, any>((a.comment?.comments ?? []).map((c: any) => [String(c.id), c]));
  const newComments: any[] = b.comment?.comments ?? [];
  const added = newComments.filter((c) => !oldComments.has(String(c.id)));
  const edited = newComments.filter((c) => {
    const prev = oldComments.get(String(c.id));
    return prev && text(prev.body) !== text(c.body);
  });
  const newIds = new Set(newComments.map((c) => String(c.id)));
  const deleted = [...oldComments.keys()].filter((id) => !newIds.has(id));
  if (added.length) {
    const authors = [...new Set(added.map((c) => label(c.author)))].join(", ");
    events.push(added.length === 1 ? `new comment by ${authors}` : `${added.length} new comments by ${authors}`);
  }
  if (edited.length) events.push(`${edited.length} comment${edited.length > 1 ? "s" : ""} edited`);
  if (deleted.length) events.push(`${deleted.length} comment${deleted.length > 1 ? "s" : ""} deleted`);

  // Attachments, matched by id.
  const oldAtt = new Set((a.attachment ?? []).map((x: any) => String(x.id)));
  const newAtt = new Set((b.attachment ?? []).map((x: any) => String(x.id)));
  const attAdded = [...newAtt].filter((id) => !oldAtt.has(id)).length;
  const attRemoved = [...oldAtt].filter((id) => !newAtt.has(id)).length;
  if (attAdded) events.push(`+${attAdded} attachment${attAdded > 1 ? "s" : ""}`);
  if (attRemoved) events.push(`-${attRemoved} attachment${attRemoved > 1 ? "s" : ""}`);

  const linkSig = (issue: JiraIssue): string =>
    [
      ...collectIssueLinks(issue.fields.issuelinks).map((l) => `${l.relation}:${l.key}`),
      ...(issue.fields.subtasks ?? []).map((s: any) => `subtask:${s.key}`),
      `parent:${issue.fields.parent?.key ?? ""}`,
    ].join("|");
  if (linkSig(oldIssue) !== linkSig(newIssue)) events.push("related issues changed");

  const before = new Map(otherFields(oldIssue, ctx));
  const after = new Map(otherFields(newIssue, ctx));
  const fieldNames = [...new Set([...before.keys(), ...after.keys()])].filter((n) => before.get(n) !== after.get(n));
  if (fieldNames.length) events.push(`fields changed: ${fieldNames.sort().join(", ")}`);

  return events;
}
