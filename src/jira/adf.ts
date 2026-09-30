// Atlassian Document Format (Jira Cloud rich text) -> Markdown. Lossy by design; the raw
// document stays in raw/issue.json. Unknown node types render their children, so nothing
// silently disappears.

export interface AdfOptions {
  resolveAttachment?: (name: string) => string | null;
  headingShift?: number;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, any>;
  content?: AdfNode[];
  marks?: { type: string; attrs?: Record<string, any> }[];
  text?: string;
}

export function isAdf(value: unknown): value is AdfNode {
  return !!value && typeof value === "object" && (value as AdfNode).type === "doc";
}

export function adfToMarkdown(doc: AdfNode, opts: AdfOptions = {}): string {
  return blocks(doc.content ?? [], opts, 0).replace(/\n{3,}/g, "\n\n").trim();
}

function blocks(nodes: AdfNode[], opts: AdfOptions, depth: number): string {
  return nodes.map((n) => block(n, opts, depth)).filter((s) => s !== "").join("\n\n");
}

function indent(text: string, depth: number): string {
  const pad = "    ".repeat(depth);
  return text.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

function block(node: AdfNode, opts: AdfOptions, depth: number): string {
  const kids = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return inlines(kids, opts);
    case "heading": {
      const level = Math.min(6, Number(node.attrs?.level ?? 1) + (opts.headingShift ?? 0));
      return `${"#".repeat(level)} ${inlines(kids, opts)}`;
    }
    case "bulletList":
      return kids.map((li) => listItem(li, "-", opts, depth)).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.order ?? 1);
      return kids.map((li, i) => listItem(li, `${start + i}.`, opts, depth)).join("\n");
    }
    case "taskList":
      return kids
        .map((li) => listItem(li, li.attrs?.state === "DONE" ? "- [x]" : "- [ ]", opts, depth))
        .join("\n");
    case "decisionList":
      return kids.map((li) => listItem(li, "- ✔", opts, depth)).join("\n");
    case "codeBlock": {
      const lang = node.attrs?.language ?? "";
      const code = kids.map((k) => k.text ?? "").join("");
      return "```" + lang + "\n" + code.replace(/\s+$/, "") + "\n```";
    }
    case "blockquote":
      return quote(blocks(kids, opts, depth));
    case "panel": {
      const kind = String(node.attrs?.panelType ?? "info");
      return quote(`**${kind[0].toUpperCase()}${kind.slice(1)}:** ${blocks(kids, opts, depth)}`);
    }
    case "rule":
      return "---";
    case "table":
      return table(kids, opts);
    case "mediaSingle":
    case "mediaGroup":
      return kids.map((m) => media(m, opts)).filter(Boolean).join("\n");
    case "media":
      return media(node, opts);
    case "expand":
    case "nestedExpand": {
      const title = node.attrs?.title ? `**${node.attrs.title}**\n\n` : "";
      return title + blocks(kids, opts, depth);
    }
    case "text":
    case "hardBreak":
    case "mention":
    case "emoji":
    case "inlineCard":
    case "date":
    case "status":
      return inlines([node], opts);
    default:
      // layoutSection, layoutColumn, extension bodies, anything new: render what is inside.
      return blocks(kids, opts, depth);
  }
}

function listItem(li: AdfNode, marker: string, opts: AdfOptions, depth: number): string {
  const kids = li.content ?? [];
  const first = kids[0];
  const head = first && (first.type === "paragraph" || first.type === "text") ? inlines(first.content ?? [first], opts) : "";
  const rest = blocks(head ? kids.slice(1) : kids, opts, 0);
  const line = `${marker} ${head}`.trimEnd();
  return indent(rest ? `${line}\n${indent(rest, 1)}` : line, depth);
}

function quote(text: string): string {
  return text.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
}

function table(rows: AdfNode[], opts: AdfOptions): string {
  const lines: string[] = [];
  rows.forEach((row, i) => {
    const cells = (row.content ?? []).map((c) => blocks(c.content ?? [], opts, 0).replace(/\n+/g, "<br>").replace(/\|/g, "\\|"));
    lines.push(`| ${cells.join(" | ")} |`);
    if (i === 0) lines.push(`|${" --- |".repeat(cells.length)}`);
  });
  return lines.join("\n");
}

function media(node: AdfNode, opts: AdfOptions): string {
  if (node.type !== "media") return "";
  const a = node.attrs ?? {};
  if (a.type === "external" && a.url) return `![](${a.url})`;
  const name: string = a.alt || a.id || "attachment";
  const target = opts.resolveAttachment?.(name) ?? name;
  return `![${a.alt ?? ""}](${target})`;
}

function inlines(nodes: AdfNode[], opts: AdfOptions): string {
  return nodes.map((n) => inline(n, opts)).join("");
}

function inline(node: AdfNode, opts: AdfOptions): string {
  const a = node.attrs ?? {};
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? []);
    case "hardBreak":
      return "<br>";
    case "mention":
      return `@${String(a.text ?? "user").replace(/^@/, "")}`;
    case "emoji":
      return a.text ?? a.shortName ?? "";
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return a.url ? `<${a.url}>` : "";
    case "date":
      return a.timestamp ? new Date(Number(a.timestamp)).toISOString().slice(0, 10) : "";
    case "status":
      return a.text ? `[${a.text}]` : "";
    case "mediaInline":
      return media({ ...node, type: "media" }, opts);
    default:
      return inlines(node.content ?? [], opts);
  }
}

function applyMarks(text: string, marks: NonNullable<AdfNode["marks"]>): string {
  let t = text;
  for (const m of marks) {
    switch (m.type) {
      case "code":
        t = "`" + t + "`";
        break;
      case "strong":
        t = `**${t}**`;
        break;
      case "em":
        t = `*${t}*`;
        break;
      case "strike":
        t = `~~${t}~~`;
        break;
      case "link":
        t = m.attrs?.href ? `[${t}](${m.attrs.href})` : t;
        break;
      default:
        // underline, textColor, subsup, backgroundColor: no Markdown equivalent.
        break;
    }
  }
  return t;
}
