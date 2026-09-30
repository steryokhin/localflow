import assert from "node:assert/strict";
import { test } from "node:test";
import { wikiToMarkdown } from "../src/jira/wiki.ts";

const md = (s: string) => wikiToMarkdown(s, { resolveAttachment: (n) => `attachments/${n.replace(/\s+/g, "-")}` });

test("empty input", () => {
  assert.equal(md(""), "");
  assert.equal(wikiToMarkdown(null), "");
});

test("headings are shifted", () => {
  assert.equal(wikiToMarkdown("h1. Title", { headingShift: 2 }), "### Title");
  assert.equal(md("h3. Sub"), "### Sub");
});

test("emphasis", () => {
  assert.equal(md("this is *bold* and _italic_ and -gone- and +under+"), "this is **bold** and *italic* and ~~gone~~ and under");
});

test("hyphens and underscores in prose are left alone", () => {
  assert.equal(md("a - b - c and snake_case_name and 2026-09-01"), "a - b - c and snake_case_name and 2026-09-01");
});

test("numbered list does not become a heading", () => {
  assert.equal(md("# first\n# second\n## nested"), "1. first\n1. second\n    1. nested");
});

test("bullet lists with nesting", () => {
  assert.equal(md("* one\n** two\n- three"), "- one\n    - two\n- three");
});

test("code blocks keep their content untouched", () => {
  assert.equal(md("before\n{code:swift}\nlet a_b = *x*\n{code}\nafter"), "before\n\n```swift\nlet a_b = *x*\n```\n\nafter");
  assert.equal(md("{noformat}\n# not a list\n{noformat}"), "```\n# not a list\n```");
});

test("links", () => {
  assert.equal(md("[Docs|https://example.com/a_b_c] and [https://example.com/x]"), "[Docs](https://example.com/a_b_c) and <https://example.com/x>");
  assert.equal(md("see https://example.com/some_page_here now"), "see https://example.com/some_page_here now");
  assert.equal(md("cc [~jdoe]"), "cc @jdoe");
});

test("images and attachment links point at local files", () => {
  assert.equal(md("!Screen Shot.png|width=300,height=200!"), "![](attachments/Screen-Shot.png)");
  assert.equal(md("!error.png|thumbnail! text"), "![](attachments/error.png) text");
  assert.equal(md("log: [^crash.log]"), "log: [crash.log](attachments/crash.log)");
  assert.equal(md("!https://example.com/a.png!"), "![](https://example.com/a.png)");
});

test("exclamation marks in prose are not images", () => {
  assert.equal(md("Wow! It works! Really."), "Wow! It works! Really.");
});

test("quote, monospace, color, panel", () => {
  assert.equal(md("{quote}quoted line{quote}"), "> quoted line");
  assert.equal(md("run {{make_all}} now"), "run `make_all` now");
  assert.equal(md("{color:red}alert{color}"), "alert");
  assert.equal(md("bq. said so"), "> said so");
});

test("tables", () => {
  assert.equal(md("||Name||Value||\n|a|b|"), "|Name|Value|\n| --- | --- |\n|a|b|");
});
