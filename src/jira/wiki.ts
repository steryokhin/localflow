// Jira wiki markup -> Markdown. Lossy by nature: the untouched original always stays in raw/issue.json.

export interface WikiOptions {
  /** Map an attachment filename used in markup to a local relative path. */
  resolveAttachment?: (name: string) => string | null;
  /** Added to heading levels so ticket content nests under the document's own sections. */
  headingShift?: number;
}

const IMAGE_EXT = "png|jpe?g|gif|webp|bmp|heic|svg|tiff?";
const LIST_INDENT = "    ";

export function wikiToMarkdown(text: string | null | undefined, opts: WikiOptions = {}): string {
  if (!text || !text.trim()) return "";
  const src = text.replace(/\r\n?/g, "\n");
  const out: string[] = [];
  const codeRe = /\{(code|noformat)(?::([^}]*))?\}([\s\S]*?)\{\1\}/g;
  let last = 0;
  for (let m = codeRe.exec(src); m; m = codeRe.exec(src)) {
    out.push(convertText(src.slice(last, m.index), opts));
    out.push("\n```" + codeLanguage(m[1], m[2]) + "\n" + m[3].replace(/^\n+|\s+$/g, "") + "\n```\n");
    last = m.index + m[0].length;
  }
  out.push(convertText(src.slice(last), opts));
  return out
    .join("")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function codeLanguage(kind: string, params: string | undefined): string {
  if (kind !== "code" || !params) return "";
  for (const p of params.split("|")) {
    const [k, v] = p.split("=");
    if (v === undefined && /^[\w+#-]+$/.test(k)) return k.toLowerCase();
    if (k === "language" && v) return v.toLowerCase();
  }
  return "";
}

function convertText(segment: string, opts: WikiOptions): string {
  const shift = opts.headingShift ?? 0;
  const lines = segment.replace(/\{quote\}/g, "\n{quote}\n").split("\n");
  const out: string[] = [];
  let inQuote = false;
  for (const rawLine of lines) {
    if (rawLine.trim() === "{quote}") {
      inQuote = !inQuote;
      out.push("");
      continue;
    }
    const converted = convertLine(rawLine, shift, opts);
    for (const l of converted.split("\n")) out.push(inQuote ? `> ${l}`.trimEnd() : l);
  }
  return out.join("\n");
}

function convertLine(rawLine: string, shift: number, opts: WikiOptions): string {
  const line = rawLine
    .replace(/\{color(?::[^}]*)?\}/g, "")
    .replace(/\{panel(?::[^}]*)?\}/g, "")
    .replace(/\{anchor:[^}]*\}/g, "");

  const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
  if (heading) return "#".repeat(Math.min(6, Number(heading[1]) + shift)) + " " + inline(heading[2], opts);

  const bq = /^\s*bq\.\s+(.*)$/.exec(line);
  if (bq) return "> " + inline(bq[1], opts);

  if (/^\s*-{4,}\s*$/.test(line)) return "---";

  // `* item`, `** nested`, `# numbered`, `#* mixed`, `- item`
  const list = /^\s*([*#]+|-)\s+(.*)$/.exec(line);
  if (list) {
    const marker = list[1];
    const bullet = marker.endsWith("#") ? "1." : "-";
    return LIST_INDENT.repeat(marker.length - 1) + `${bullet} ` + inline(list[2], opts);
  }

  if (line.trimStart().startsWith("||")) {
    const row = inline(line.trim(), opts).replace(/\|\|/g, "|").replace(/\|?$/, "|");
    const cells = row.split("|").length - 2;
    return row + "\n|" + " --- |".repeat(Math.max(1, cells));
  }

  return inline(line, opts);
}

function inline(s: string, opts: WikiOptions): string {
  // Finished fragments are parked as placeholders so later emphasis rules cannot mangle them.
  const parked: string[] = [];
  const park = (md: string): string => `\u0000${parked.push(md) - 1}\u0000`;

  let t = s;
  t = t.replace(/\{\{(.+?)\}\}/g, (_, code: string) => park("`" + code + "`"));

  t = t.replace(
    new RegExp(`!(?=\\S)([^!\\n|]{1,200}?\\.(?:${IMAGE_EXT}))\\s*(?:\\|[^!\\n]*)?!`, "gi"),
    (_, name: string) => park(`![](${resolveRef(name.trim(), opts)})`),
  );
  t = t.replace(/\[\^([^\]\n]+)\]/g, (_, name: string) => park(`[${name}](${resolveRef(name.trim(), opts)})`));
  t = t.replace(/\[~([^\]\n]+)\]/g, (_, user: string) => park(`@${user}`));
  t = t.replace(/\[([^\]|\n]+)\|([^\]|\n]+)(?:\|[^\]\n]*)?\]/g, (_, label: string, url: string) =>
    url.startsWith("#") ? label : park(`[${label}](${url.trim()})`),
  );
  t = t.replace(/\[((?:https?:\/\/|mailto:)[^\]\s]+)\]/g, (_, url: string) => park(`<${url}>`));
  t = t.replace(/https?:\/\/[^\s<>()\u0000]+/g, (url) => park(url));

  t = t.replace(/(?<![*\w])\*(\S(?:[^*\n]*?\S)?)\*(?![*\w])/g, "**$1**");
  t = t.replace(/(?<![_\w])_(\S(?:[^_\n]*?\S)?)_(?![_\w])/g, "*$1*");
  t = t.replace(/(?<![-\w])-(\S(?:[^-\n]*?\S)?)-(?![-\w])/g, "~~$1~~");
  t = t.replace(/(?<![+\w])\+(\S(?:[^+\n]*?\S)?)\+(?![+\w])/g, "$1");
  t = t.replace(/\?\?(\S(?:[^?\n]*?\S)?)\?\?/g, "*$1*");
  t = t.replace(/\\\\\s*/g, "<br>");

  // Placeholders may nest (a link inside bold), so restore until none remain.
  for (let i = 0; i < 5 && t.includes("\u0000"); i++) {
    t = t.replace(/\u0000(\d+)\u0000/g, (_, idx: string) => parked[Number(idx)]);
  }
  return t;
}

function resolveRef(name: string, opts: WikiOptions): string {
  if (/^https?:\/\//.test(name)) return name;
  return opts.resolveAttachment?.(name) ?? name;
}
