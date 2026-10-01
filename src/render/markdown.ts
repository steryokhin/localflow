// Small Markdown renderer for the web UI. Documents are split into blocks first (the editor
// edits one block at a time, and "what's new" is computed per block), then each block is
// rendered on its own. Supports what ticket.md and hand-written notes actually use: headings,
// paragraphs, nested lists, task items, fenced code, quotes, tables, rules, images, links,
// emphasis, inline code, strikethrough. All HTML in the source is escaped.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const FENCE_RE = /^(\s*)(```|~~~)/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split Markdown into blocks; joining them with "\n\n" reproduces an equivalent document. */
export function splitBlocks(md: string): string[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let mode: "" | "fence" | "list" | "quote" | "table" | "para" = "";
  let fence = "";
  const flush = (): void => {
    while (cur.length && !cur[cur.length - 1].trim()) cur.pop();
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
    mode = "";
  };
  for (const line of lines) {
    if (mode === "fence") {
      cur.push(line);
      if (line.trim().startsWith(fence)) flush();
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) {
      flush();
      mode = "fence";
      fence = f[2];
      cur.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const isHeading = /^#{1,6}\s/.test(line);
    const isRule = /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
    if (isHeading || isRule) {
      flush();
      cur.push(line);
      flush();
      continue;
    }
    const isList = LIST_RE.test(line);
    const isQuote = /^\s*>/.test(line);
    const isTable = /^\s*\|/.test(line) || TABLE_SEP_RE.test(line);
    if (mode === "") {
      mode = isList ? "list" : isQuote ? "quote" : isTable ? "table" : "para";
      cur.push(line);
      continue;
    }
    // Continuation rules: lists absorb indented lines and further items, quotes absorb ">" lines,
    // tables absorb "|" lines, paragraphs absorb anything that does not start another block.
    const continues =
      mode === "list" ? isList || /^\s{2,}/.test(line) :
      mode === "quote" ? isQuote :
      mode === "table" ? isTable :
      !isList && !isQuote && !isTable;
    if (!continues) flush();
    if (mode === "") mode = isList ? "list" : isQuote ? "quote" : isTable ? "table" : "para";
    cur.push(line);
  }
  flush();
  return blocks;
}

export interface RenderOptions {
  /** Rewrites relative image/link targets (e.g. "attachments/x.png" -> "/raw/<ticket>/attachments/x.png"). */
  resolveUrl?: (url: string) => string;
}

export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  return splitBlocks(md).map((b) => renderBlock(b, opts)).join("\n");
}

export function renderBlock(block: string, opts: RenderOptions = {}): string {
  const lines = block.split("\n");
  const first = lines[0];
  const f = FENCE_RE.exec(first);
  if (f) {
    const lang = first.slice(f[0].length).trim().split(/\s+/)[0] ?? "";
    const body = lines.slice(1, lines[lines.length - 1].trim().startsWith(f[2]) && lines.length > 1 ? -1 : undefined);
    const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
    return `<pre><code${cls}>${escapeHtml(body.join("\n"))}\n</code></pre>`;
  }
  const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(first);
  if (h && lines.length === 1) return `<h${h[1].length}>${inline(h[2], opts)}</h${h[1].length}>`;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(first) && lines.length === 1) return "<hr>";
  if (/^\s*>/.test(first)) {
    const inner = lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
    return `<blockquote>${renderMarkdown(inner, opts)}</blockquote>`;
  }
  if (LIST_RE.test(first)) return renderList(lines, opts);
  if (lines.length >= 2 && TABLE_SEP_RE.test(lines[1])) return renderTable(lines, opts);
  return `<p>${lines.map((l) => inline(l.trim(), opts)).join("<br>\n")}</p>`;
}

interface ListItem {
  ordered: boolean;
  indent: number;
  text: string[];
  children: ListItem[];
  task: "" | "todo" | "done";
}

function renderList(lines: string[], opts: RenderOptions): string {
  const root: ListItem = { ordered: false, indent: -1, text: [], children: [], task: "" };
  const stack: ListItem[] = [root];
  for (const line of lines) {
    const m = LIST_RE.exec(line);
    if (m) {
      const indent = m[1].length;
      let text = line.slice(m[0].length);
      let task: ListItem["task"] = "";
      const t = /^\[([ xX])\]\s+/.exec(text);
      if (t) {
        task = t[1] === " " ? "todo" : "done";
        text = text.slice(t[0].length);
      }
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      const item: ListItem = { ordered: /\d/.test(m[2]), indent, text: [text], children: [], task };
      stack[stack.length - 1].children.push(item);
      stack.push(item);
    } else {
      stack[stack.length - 1].text.push(line.trim());
    }
  }
  const render = (items: ListItem[]): string => {
    if (!items.length) return "";
    const tag = items[0].ordered ? "ol" : "ul";
    const li = items
      .map((it) => {
        const box = it.task ? `<input type="checkbox" disabled${it.task === "done" ? " checked" : ""}> ` : "";
        return `<li${it.task ? ' class="task"' : ""}>${box}${inline(it.text.join(" "), opts)}${render(it.children)}</li>`;
      })
      .join("");
    return `<${tag}>${li}</${tag}>`;
  };
  return render(root.children);
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let i = 0;
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 2;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(lines: string[], opts: RenderOptions): string {
  const head = splitRow(lines[0]);
  const aligns = splitRow(lines[1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const cell = (tag: string, text: string, i: number): string =>
    `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${inline(text, opts)}</${tag}>`;
  const th = head.map((c, i) => cell("th", c, i)).join("");
  const rows = lines.slice(2).map((l) => `<tr>${splitRow(l).map((c, i) => cell("td", c, i)).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
}

function safeUrl(url: string, opts: RenderOptions): string {
  const u = url.trim();
  if (/^(javascript|data|vbscript):/i.test(u)) return "#";
  return escapeHtml(opts.resolveUrl ? opts.resolveUrl(u) : u);
}

export function inline(text: string, opts: RenderOptions = {}): string {
  // Protect code spans first so nothing inside them is interpreted.
  const codes: string[] = [];
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) => {
    codes.push(`<code>${escapeHtml(code.trim())}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, alt: string, url: string) => `<img src="${safeUrl(url, opts)}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, label: string, url: string) => `<a href="${safeUrl(url, opts)}">${label}</a>`);
  s = s.replace(/(^|[^"'>=\w])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, (_m, pre: string, url: string) => `${pre}<a href="${url}">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
  return s;
}
