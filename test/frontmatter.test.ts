import assert from "node:assert/strict";
import { test } from "node:test";
import { dumpFrontmatter, parseFrontmatter, setFrontmatterKeys } from "../src/vault/frontmatter.ts";

test("round trip of scalars and lists", () => {
  const data = {
    id: "PROJ-1",
    title: 'Crash: "swipe" fails',
    mine: true,
    points: 3,
    labels: ["ios", "needs: review"],
    empty: [],
    nothing: null,
    numeric_text: "123",
  };
  const parsed = parseFrontmatter(dumpFrontmatter(data) + "\nbody\n");
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, "\nbody\n");
});

test("inline lists and hand-written headers", () => {
  const { data } = parseFrontmatter('---\ntags: [a, "b, c", d]\nstatus: inprogress\n---\ntext');
  assert.deepEqual(data, { tags: ["a", "b, c", "d"], status: "inprogress" });
});

test("no frontmatter", () => {
  assert.deepEqual(parseFrontmatter("# just text\n"), { data: {}, body: "# just text\n" });
});

test("setFrontmatterKeys edits only the targeted lines", () => {
  const text = "---\nticket: A-1\nstatus: inbox\n# my comment\ncustom:\n  - x\n---\n\n# Notes\n\nkeep me\n";
  const updated = setFrontmatterKeys(text, { status: "inprogress", taken: "2026-09-30" });
  assert.equal(
    updated,
    "---\nticket: A-1\nstatus: inprogress\n# my comment\ncustom:\n  - x\ntaken: 2026-09-30\n---\n\n# Notes\n\nkeep me\n",
  );
});

test("setFrontmatterKeys adds a header when the file has none", () => {
  assert.equal(setFrontmatterKeys("plain\n", { status: "done" }), "---\nstatus: done\n---\n\nplain\n");
});
