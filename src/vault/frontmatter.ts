// Minimal YAML frontmatter support: scalars, inline `[a, b]` lists and block `- item` lists.
// Enough for files this tool writes and for simple hand-written note headers.

export type FmValue = string | number | boolean | null | FmValue[];
export type Frontmatter = Record<string, FmValue>;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Frontmatter = {};
  let listKey: string | null = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      listKey = null;
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey !== null) {
      (data[listKey] as FmValue[]).push(parseScalar(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      listKey = null;
      continue;
    }
    const key = kv[1];
    const raw = kv[2].trim();
    if (raw === "") {
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1).trim();
      data[key] = inner ? splitInlineList(inner).map(parseScalar) : [];
    } else {
      data[key] = parseScalar(raw);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

/** Split `a, "b, c", d` respecting quoted commas. */
function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let buf = "";
  let quote = "";
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ",") {
      items.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) items.push(buf.trim());
  return items;
}

function parseScalar(raw: string): FmValue {
  const v = raw.trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower === "null" || v === "~") return null;
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

function dumpScalar(v: FmValue): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (s === "") return '""';
  const needsQuote =
    /^[#&*!|>'"%@`?\-\[\]{},]/.test(s) ||
    s.includes(":") ||
    s.includes("\n") ||
    s.includes(" #") ||
    s !== s.trim() ||
    ["true", "false", "null", "yes", "no", "on", "off", "~"].includes(s.toLowerCase()) ||
    /^-?\d+(\.\d+)?$/.test(s);
  if (!needsQuote) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ") + '"';
}

function dumpValue(v: FmValue): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return " []";
    return "\n" + v.map((item) => `  - ${dumpScalar(item)}`).join("\n");
  }
  return " " + dumpScalar(v);
}

/** Dump keys in insertion order. */
export function dumpFrontmatter(data: Frontmatter): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(data)) lines.push(`${k}:${dumpValue(v)}`);
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * Set scalar keys in a file's frontmatter by editing only the affected lines.
 * Everything else (comments, unknown structures, body) is left byte-for-byte intact.
 */
export function setFrontmatterKeys(text: string, updates: Record<string, string | number | boolean>): string {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    const data: Frontmatter = { ...updates };
    return dumpFrontmatter(data) + "\n" + text;
  }
  const lines = m[1].split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    const newLine = `${key}: ${dumpScalar(value)}`;
    const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (idx === -1) {
      lines.push(newLine);
      continue;
    }
    // Drop block-list items that belonged to the replaced key.
    let end = idx + 1;
    while (end < lines.length && /^\s+-\s+/.test(lines[end])) end++;
    lines.splice(idx, end - idx, newLine);
  }
  return `---\n${lines.join("\n")}\n---\n` + text.slice(m[0].length);
}
