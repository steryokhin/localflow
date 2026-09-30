import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class UserError extends Error {}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function slugify(s: string, maxLen = 60): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}

/** Make a filename safe for Markdown links (no spaces/parens). */
export function sanitizeAttachmentName(filename: string): string {
  const safe = filename
    .replace(/[^\p{L}\p{N}_.\-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+(\.)/g, "$1");
  return safe || "attachment";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** JSON with recursively sorted object keys, so stored snapshots diff cleanly. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

const CLOUD_MARKERS = ["Mobile Documents", "CloudDocs", "CloudStorage", "Dropbox", "OneDrive", "Google Drive"];

/** Returns the marker name if the path sits inside a cloud-synced folder. */
export function cloudSyncedMarker(p: string): string | null {
  const resolved = path.resolve(p);
  return CLOUD_MARKERS.find((m) => resolved.includes(m)) ?? null;
}
