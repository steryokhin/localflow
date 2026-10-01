// Markdown block splitting, rendering and block diff used by the web UI.

import assert from "node:assert/strict";
import { test } from "node:test";
import { diffBlocks } from "../src/render/blockdiff.ts";
import { inline, renderBlock, renderMarkdown, splitBlocks } from "../src/render/markdown.ts";

test("splitBlocks separates paragraphs, headings, rules, quotes and tables", () => {
  const md = "# Title\n\nfirst line\nsecond line\n\n---\n\n> quote\n> more\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n## Sub\ntail";
  assert.deepEqual(splitBlocks(md), [
    "# Title",
    "first line\nsecond line",
    "---",
    "> quote\n> more",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "## Sub",
    "tail",
  ]);
});

test("a fenced code block with blank lines inside stays one block", () => {
  const md = "before\n\n```js\nlet a = 1;\n\n\nlet b = 2;\n```\n\nafter";
  assert.deepEqual(splitBlocks(md), ["before", "```js\nlet a = 1;\n\n\nlet b = 2;\n```", "after"]);
});

test("a nested list is one block, including indented continuation lines", () => {
  const md = "- one\n  - nested\n    1. deep\n- two\n  continued\n\nafter";
  assert.deepEqual(splitBlocks(md), ["- one\n  - nested\n    1. deep\n- two\n  continued", "after"]);
});

test("round-trip: joining blocks with a blank line re-splits identically", () => {
  const md = [
    "# H", "", "para a", "para b", "", "```", "x", "", "y", "```", "", "- a", "  - b", "- c", "", "> q", "", "| a | b |", "| - | - |", "| 1 | 2 |", "", "***", "", "### Last",
  ].join("\n");
  const blocks = splitBlocks(md);
  assert.ok(blocks.length >= 8);
  assert.deepEqual(splitBlocks(blocks.join("\n\n")), blocks);
});

test("CRLF input and blank-only input", () => {
  assert.deepEqual(splitBlocks("a\r\n\r\nb"), ["a", "b"]);
  assert.deepEqual(splitBlocks("\n\n  \n"), []);
});

test("headings and rules render", () => {
  assert.equal(renderBlock("## Hello *you* ##"), "<h2>Hello <em>you</em></h2>");
  assert.equal(renderBlock("---"), "<hr>");
  assert.equal(renderMarkdown("# A\n\npara"), "<h1>A</h1>\n<p>para</p>");
});

test("nested lists, ordered lists and task items", () => {
  assert.equal(
    renderBlock("- one\n  1. first\n  2. second\n- two"),
    "<ul><li>one<ol><li>first</li><li>second</li></ol></li><li>two</li></ul>",
  );
  const tasks = renderBlock("- [ ] todo\n- [x] done");
  assert.equal(
    tasks,
    '<ul><li class="task"><input type="checkbox" disabled> todo</li><li class="task"><input type="checkbox" disabled checked> done</li></ul>',
  );
});

test("tables render with column alignment and escaped pipes", () => {
  const html = renderBlock("| L | C | R | N |\n| :-- | :-: | --: | --- |\n| a | b | c | d\\|e |");
  assert.equal(
    html,
    '<table><thead><tr><th style="text-align:left">L</th><th style="text-align:center">C</th><th style="text-align:right">R</th><th>N</th></tr></thead>' +
      '<tbody><tr><td style="text-align:left">a</td><td style="text-align:center">b</td><td style="text-align:right">c</td><td>d|e</td></tr></tbody></table>',
  );
});

test("code fences escape HTML and carry the language", () => {
  assert.equal(renderBlock("```ts\nif (a < b && c > d) {}\n```"), '<pre><code class="lang-ts">if (a &lt; b &amp;&amp; c &gt; d) {}\n</code></pre>');
  assert.equal(renderBlock("```\n<b>x</b>\n```"), "<pre><code>&lt;b&gt;x&lt;/b&gt;\n</code></pre>");
});

test("blockquotes render their content as markdown", () => {
  assert.equal(renderBlock("> **hi**\n> there"), "<blockquote><p><strong>hi</strong><br>\nthere</p></blockquote>");
});

test("inline code protects emphasis markers and pipes", () => {
  assert.equal(inline("use `a*b*c` and `x | y`"), "use <code>a*b*c</code> and <code>x | y</code>");
  assert.equal(inline("`<script>`"), "<code>&lt;script&gt;</code>");
  const table = renderBlock("| a | b |\n| - | - |\n| `x*y*` | 2 |");
  assert.match(table, /<td><code>x\*y\*<\/code><\/td>/);
});

test("images and links go through resolveUrl", () => {
  const resolveUrl = (u: string) => `/raw/T/${u}`;
  assert.equal(inline("![shot](attachments/a.png)", { resolveUrl }), '<img src="/raw/T/attachments/a.png" alt="shot" loading="lazy">');
  assert.equal(inline("[doc](notes/x.md)", { resolveUrl }), '<a href="/raw/T/notes/x.md">doc</a>');
  assert.equal(inline("[doc](notes/x.md)"), '<a href="notes/x.md">doc</a>');
});

test("javascript:, data: and vbscript: URLs are neutralised", () => {
  assert.equal(inline("[x](javascript:alert)"), '<a href="#">x</a>');
  assert.equal(inline("[x](JaVaScRiPt:alert)"), '<a href="#">x</a>');
  assert.match(inline("![x](data:text/html,hi)"), /src="#"/);
  assert.match(inline("[x](vbscript:run)"), /href="#"/);
});

test("raw HTML in the source is escaped", () => {
  const html = renderMarkdown('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test("bold, italic, strikethrough and autolinks", () => {
  assert.equal(inline("**b** __b2__ *i* _i2_ ~~s~~"), "<strong>b</strong> <strong>b2</strong> <em>i</em> <em>i2</em> <s>s</s>");
  assert.equal(inline("snake_case_name stays"), "snake_case_name stays");
  assert.equal(inline("see https://example.com/a?b=1, ok"), 'see <a href="https://example.com/a?b=1">https://example.com/a?b=1</a>, ok');
});

test("diffBlocks: unchanged text is all same", () => {
  const md = "# A\n\npara\n\n- x\n- y";
  const d = diffBlocks(md, md);
  assert.deepEqual(d.map((b) => b.state), ["same", "same", "same"]);
});

test("diffBlocks: an appended block is new", () => {
  const d = diffBlocks("one block here\n\ntwo block there", "one block here\n\ntwo block there\n\nbrand fresh addition");
  assert.deepEqual(d.map((b) => b.state), ["same", "same", "new"]);
  assert.equal(d[2].src, "brand fresh addition");
  assert.equal(d[2].was, undefined);
});

test("diffBlocks: an edited paragraph sharing words is changed and keeps the old text", () => {
  const oldMd = "intro paragraph\n\nSwipe fails on iOS devices\n\noutro paragraph";
  const newMd = "intro paragraph\n\nSwipe fails on iOS devices and iPadOS\n\noutro paragraph";
  const d = diffBlocks(oldMd, newMd);
  assert.deepEqual(d.map((b) => b.state), ["same", "changed", "same"]);
  assert.equal(d[1].was, "Swipe fails on iOS devices");
  assert.equal(d[1].src, "Swipe fails on iOS devices and iPadOS");
});

test("diffBlocks: an unrelated replacement is new, not changed", () => {
  const d = diffBlocks("alpha beta gamma", "completely different words");
  assert.deepEqual(d.map((b) => b.state), ["new"]);
});

test("diffBlocks: no old text means everything is same", () => {
  const d = diffBlocks(null, "a\n\nb");
  assert.deepEqual(d.map((b) => b.state), ["same", "same"]);
});
