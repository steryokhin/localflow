// One entry point for Jira rich text in any of its three shapes:
// wiki markup (Data Center, REST v2), ADF (Cloud, REST v3 / raw tool output),
// or Markdown already produced by a tool such as the Rovo connector.

import { adfToMarkdown, isAdf } from "./adf.ts";
import { wikiToMarkdown } from "./wiki.ts";
import { stableJson } from "../util.ts";

export type TextFlavor = "wiki" | "markdown";

export interface RichTextOptions {
  /** How plain strings are interpreted; ADF objects are detected regardless. */
  flavor: TextFlavor;
  resolveAttachment?: (name: string) => string | null;
  headingShift?: number;
}

export function richTextToMarkdown(value: unknown, opts: RichTextOptions): string {
  if (value === null || value === undefined) return "";
  if (isAdf(value)) return adfToMarkdown(value, opts);
  if (typeof value !== "string") return "";
  if (opts.flavor === "markdown") return shiftHeadings(value.replace(/\r\n?/g, "\n"), opts.headingShift ?? 0).trim();
  return wikiToMarkdown(value, opts);
}

/** Push Markdown headings down so ticket content nests under the document's own sections. */
function shiftHeadings(md: string, shift: number): string {
  if (!shift) return md;
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      const m = /^(#{1,6})(\s+.*)$/.exec(line);
      return m ? "#".repeat(Math.min(6, m[1].length + shift)) + m[2] : line;
    })
    .join("\n");
}

/** Plain text of a rich value, for change detection. */
export function richTextSignature(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").trim();
  // Key order differs between a fresh API object and the stored snapshot; compare canonically.
  return stableJson(value);
}
