// Block-level diff of two Markdown documents, used to highlight "what's new" inside a ticket:
// blocks present only in the new text are marked new; a new block that replaced a removed one
// (same position, similar words) is marked changed and remembers the old text.

import { splitBlocks } from "./markdown.ts";

export type BlockState = "same" | "new" | "changed";

export interface DiffBlock {
  src: string;
  state: BlockState;
  /** Previous text for "changed" blocks. */
  was?: string;
}

function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
}

function similar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return false;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size) >= 0.4;
}

export function diffBlocks(oldMd: string | null, newMd: string): DiffBlock[] {
  const b = splitBlocks(newMd);
  if (oldMd === null) return b.map((src) => ({ src, state: "same" }));
  const a = splitBlocks(oldMd);
  const pairs = lcs(a, b);
  const out: DiffBlock[] = [];
  let ai = 0;
  let bi = 0;
  const gap = (aEnd: number, bEnd: number): void => {
    const removed = a.slice(ai, aEnd);
    for (let j = bi; j < bEnd; j++) {
      const src = b[j];
      const k = removed.findIndex((r) => similar(r, src));
      if (k >= 0) {
        out.push({ src, state: "changed", was: removed[k] });
        removed.splice(k, 1);
      } else out.push({ src, state: "new" });
    }
    ai = aEnd;
    bi = bEnd;
  };
  for (const [i, j] of pairs) {
    gap(i, j);
    out.push({ src: b[j], state: "same" });
    ai = i + 1;
    bi = j + 1;
  }
  gap(a.length, b.length);
  return out;
}
