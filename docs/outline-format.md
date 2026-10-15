# outline.md — format

`<vault>/outline.md` is one plain-text tree where everything is an item: project folders, tickets,
steps, subtasks, waits. Any item can go inside any other, as deep as needed. `lf`, the web UI's
Outline editor, the agent and any text editor read and write the same file. The parser is
`src/vault/outline.ts`; the fixtures in `outline-format/fixtures/` (`*.md` with the expected tree in
`*.json`) are the conformance set any other parser must pass.

```markdown
# Outline

- Mobile ^p2q3
  - PROJ-1 · Login crash on swipe ^a7c4
    - [x] reproduce on iOS 26 · done 2026-10-13 10:20 ^k3f9
    - [ ] research issue #123 ^m4p2
      - [x] discuss with Tom ^c4d5
        > Tom: the crash is in the swipe handler, not the cache
      - [ ] #android review ^e6f7
        - [ ] wait for Jim's review · from Jim · by 2026-10-15 12:00 · else: ping in #ios · opened 2026-10-14 10:00 ^L7
    - PROJ-3 · Crash in the image cache ^b5d6
- PROJ-2 · Payments ✓ ^r6s7
- No ticket ^n4p5
  - [ ] ask Lena about onboarding · from Lena · by 2026-10-16 ^n2p3
```

## Lines

| Line | Meaning |
|---|---|
| `- [ ] text ^id` | an open task; `[x]` (or `[X]`) done; `*` or `+` work as the bullet too |
| `- text ^id` | a bullet: an item without a checkbox (a folder, a note, a heading for what is under it) |
| `- KEY · title ^id` | a bullet that stands for a ticket (`- KEY` alone too); a trailing ` ✓` marks it closed |
| `> text` | context of the item right above it (its line or its other `>` lines); a bare `>` is an empty context line |
| anything else | free text: kept as it is; it ends every item indented as deep or deeper |

Text before the first item is a preamble (`# Outline`): kept, never parsed as items.

**Nesting** is by indentation: an item belongs to the closest item above it with less indentation.
lf writes 2 spaces per level; a tab counts as 2. Moving an item re-indents its whole block.

**Tickets.** An item belongs to the nearest ticket above it: loops under `PROJ-3` are `PROJ-3`'s even
though `PROJ-1` is further up. A ticket inside another ticket is its sub-ticket: lf writes `parent:
PROJ-1` into `PROJ-3`'s `notes.md` when it is put there (and removes it when it is taken out), so the
ticket list shows the same tree. Loops without a ticket go under a `No ticket` bullet. Only a bullet
stands for a ticket: `- [ ] PROJ-1 · …` is a task that mentions it.

**Before one tree** (LFLOW-024/025) tickets were `## KEY · title` headings with the items under them.
Such a file is read as this tree (each heading a top bullet, `## title ✓` without a key a checked
task, everything under it one level in) and the next write stores it so; ids and history are kept.

## Ids

`^id` at the end of an item is its permanent id: moves, rewording and checking off keep it, and the
history follows items by it.

- lf hands out 4-character ids: letter, digit, letter, digit (`k3f9`), without `l`, `o`, `0`, `1`.
  Old loop ids `L7` stay as they are. Any other `^word` typed by hand is accepted as an id.
- An item without an id gets a **derived** one (a hash of its ticket or top item and its text): the same on every
  read, written into the line by the next write. Reads never write the file.
- A duplicate id typed by hand: the first keeps it, the others get new ones on the next write.
- Referenced elsewhere (a Log line, `after`), an id is `L7` or the 4-character form.

## Loops

A task (`[ ]`) whose text has a `by` field is an open loop: lf reminds about it, `loops.md` lists it,
the board and the standup see it. Fields are joined by ` · ` and recognised by shape, in any order:

| Field | Meaning |
|---|---|
| `#tag text` or a `#tag` field | branch of the ticket's work; items under a `#tag` parent inherit it |
| `from WHO` / `от WHO` | who the next move is waiting on; absent means me |
| `by WHEN` / `до WHEN` | the deadline: `YYYY-MM-DD` (end of that day) or `YYYY-MM-DD HH:MM` |
| `after ID` / `после ID` | the step this one follows |
| `else: …` / `иначе: …` | what to do when the deadline passes |
| `opened DATE` / `открыто DATE` | when the loop was opened |

The ticket is the nearest ticket above the item; the id is the `^id`. A `by` that is not a date ("tomorrow", "+2h",
"18:00", "eod") is turned into one when the item is saved through lf or the editor, and `opened` is
stamped then. An unreadable `by` is kept as typed; the item is then not a loop.

Checking a loop off (`[x]`, `lf done`, `lf outline check`) leaves it in place and writes a line to
the ticket's `## Log` (`outcome (k3f9 #android, after L6: text, from Jim)`), as `lf done` always did.

Any item checked off through lf, the editor or `[x]` in loops.md gets `done YYYY-MM-DD HH:MM`
(`сделано …` is read too) as its last field, loop or not; unchecking takes it away. So the line
itself says when it was closed, without git. A box ticked by hand in outline.md gets no date (the
history still has the day). Steps brought in from the Logs by `--migrate` carry the Log line's date.

## loops.md

`loops.md` lists the open loops one line each and stays editable:

```
- [ ] ^k3f9 · 2026-10-14 10:00 · PROJ-1 · #android · wait for Jim's review · from Jim · by 2026-10-15 12:00 · else: ping in #ios
```

- lf keeps, in `.localflow/state.json`, each loop's line as it last wrote it (the baseline). A line
  that differs from it is a hand edit and goes into the outline item; a new line becomes a new item
  under its ticket; a deleted line **removes the item and everything under it** (the vault's git
  keeps it).
- A loop edited in both files since the last write is a conflict: both versions stay where they
  are and every operation on that loop is refused until the two agree.
- Reads merge in memory; the next write of any operation stores both files.

## Writes

Every write is a compare-and-swap of both files: if either changed after it was read, the operation
runs again on the fresh content; an operation on an item whose own line or context changed in
between is refused (`409` in the web UI). An operation rewrites only the lines it is about; every
other byte stays.

## History

Every write is a commit of `outline.md` and `loops.md` in the vault's local git (`outline (lf): …`
at once from the CLI, `outline (ui): …` after a short pause from the web UI, `outline (hand): …` for
edits made in another editor, picked up by the running UI or by `lf watch`). From that:

- `lf outline --at DAY` — the outline as it was at the end of a day;
- `lf outline --history KEY|ID` — how a ticket's part, or one item and everything under it, evolved;
- `lf outline --days` — what changed, day by day;
- the Outline page's History panel shows the same.
