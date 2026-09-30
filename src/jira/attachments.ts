import fs from "node:fs";
import path from "node:path";
import type { JiraClient } from "./client.ts";
import type { JiraIssue } from "./api.ts";
import { formatBytes, sanitizeAttachmentName, writeFileAtomic } from "../util.ts";

export const ATTACHMENTS_DIR = "attachments";

export interface AttachmentPlan {
  id: string;
  filename: string;
  /** File name inside the ticket's attachments/ folder. */
  localName: string;
  size: number;
  author: string;
  created: string;
  url: string;
  /** Set when the file is deliberately not downloaded (e.g. over the size limit). */
  skipReason?: string;
}

/** Deterministic local naming: the oldest attachment keeps the plain name, later duplicates get an id prefix. */
export function planAttachments(issue: JiraIssue, maxBytes: number): AttachmentPlan[] {
  const raw: any[] = [...(issue.fields.attachment ?? [])].sort((a, b) => Number(a.id) - Number(b.id));
  const used = new Set<string>();
  const plans: AttachmentPlan[] = [];
  for (const a of raw) {
    if (!a.filename || !a.content) continue;
    let localName = sanitizeAttachmentName(a.filename);
    if (used.has(localName.toLowerCase())) localName = `${a.id}-${localName}`;
    used.add(localName.toLowerCase());
    const size = Number(a.size ?? 0);
    plans.push({
      id: String(a.id),
      filename: a.filename,
      localName,
      size,
      author: a.author?.displayName ?? "unknown",
      created: a.created ?? "",
      url: a.content,
      skipReason: size > maxBytes ? `not downloaded: ${formatBytes(size)} exceeds the limit` : undefined,
    });
  }
  return plans;
}

/** Resolver for wiki markup references: a filename maps to the newest attachment carrying that name. */
export function attachmentResolver(plans: AttachmentPlan[]): (name: string) => string {
  const byName = new Map<string, string>();
  for (const p of plans) {
    byName.set(p.filename, p.localName);
    byName.set(sanitizeAttachmentName(p.filename), p.localName);
  }
  return (name) => `${ATTACHMENTS_DIR}/${byName.get(name) ?? byName.get(sanitizeAttachmentName(name)) ?? sanitizeAttachmentName(name)}`;
}

function isPresent(dir: string, p: AttachmentPlan): boolean {
  try {
    return fs.statSync(path.join(dir, ATTACHMENTS_DIR, p.localName)).size === p.size || p.size === 0;
  } catch {
    return false;
  }
}

export function hasMissingAttachments(ticketDir: string, plans: AttachmentPlan[]): boolean {
  return plans.some((p) => !p.skipReason && !isPresent(ticketDir, p));
}

export interface DownloadResult {
  downloaded: string[];
  removed: string[];
  failed: { name: string; error: string }[];
}

/** Bring the ticket's attachments/ folder in line with Jira: fetch what is missing, drop what was deleted. */
export async function syncAttachments(
  client: JiraClient,
  ticketDir: string,
  plans: AttachmentPlan[],
): Promise<DownloadResult> {
  const result: DownloadResult = { downloaded: [], removed: [], failed: [] };
  const dir = path.join(ticketDir, ATTACHMENTS_DIR);
  for (const p of plans) {
    if (p.skipReason || isPresent(ticketDir, p)) continue;
    try {
      writeFileAtomic(path.join(dir, p.localName), await client.download(p.url));
      result.downloaded.push(p.localName);
    } catch (e) {
      // A failed download must not kill the sync; the next run retries it.
      result.failed.push({ name: p.localName, error: (e as Error).message });
    }
  }
  if (fs.existsSync(dir)) {
    const expected = new Set(plans.map((p) => p.localName));
    for (const name of fs.readdirSync(dir)) {
      if (expected.has(name)) continue;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      result.removed.push(name);
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  return result;
}
