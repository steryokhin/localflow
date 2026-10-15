---
name: localflow-outline
description: Trial week of LFLOW-024 — keeps <vault>/outline.md, a hand-kept tree of tickets → actions → subtasks → waits, next to lf's loops. Use when the user asks to convert the current loops into outline.md, to add/close/move items in the outline, to show "what is active" or another filtered view of it, or mentions outline.md, "outline", "аутлайн", "переведи петли в outline", "что в работе по дереву". Also after any lf loop / done / bump while outline.md exists.
---

# Local Flow outline — trial week (LFLOW-024)

`<vault>/outline.md` is the tree the user will later edit in the Outline editor. For now `lf` does
**not** read it: it is kept by hand (the user's editor) and by you. The point of the week is to
try the format on real tickets and collect what is missing. All rules of the `localflow` skill
still apply; in particular nothing leaves the machine.

**Source of truth during the trial:** loops (waits, deadlines, reminders, `## Log`) stay in `lf`
and `loops.md` exactly as before. `outline.md` mirrors them and adds the plain steps around them.
Keeping the two in step is your job, not the user's.

## Format

```markdown
# Outline

## PROJ-1 · Login crash on swipe
- [x] reproduce on iOS 26
- [ ] research issue #123
  - [x] call Jim
  - [x] discuss with Tom
    > Tom: the crash is in the swipe handler, not the cache
  - [ ] #android
    - [x] ask Jim to review
      > approved, 2 comments
    - [ ] wait for Jim's re-review · from Jim · by 2026-10-17 12:00 · else: ping in #ios ^L7

## Без тикета
- [ ] ask Lena about onboarding access · from Lena · by 2026-10-16 · else: ask Mark ^L9

## Friction
- 2026-10-15 — wanted only my waits across all tickets (lens)
```

- `## KEY · title` is a ticket root; `## Без тикета` holds items with no ticket. A closed ticket
  gets ` ✓` at the end of its heading and stays in place.
- Items are `- [ ]` / `- [x]`, nested by **2 spaces**. Closed items stay where they are.
- `>` lines right under an item are its context (outcome, quotes, links), indented like its children.
- A wait/promise is an item with the same fields as `loops.md`, joined by ` · `: `from WHO`,
  `by WHEN`, `else: …`. A branch tag is a parent item `- [ ] #tag` with the branch's steps under it.
- A loop item ends with `^L<n>`, its `lf` id. Plain items get **no** id (lf will add ids later).
- `## Friction` is always the last section.

## Converting the current loops (first run)

When `outline.md` does not exist or the user asks to convert:

1. `lf loops` — open loops by ticket, and tracked tickets with no loop.
2. For each ticket with loops: `lf loops --key KEY` — closed steps (from `## Log`, with outcomes)
   then the open ones, by branch. Title from the ticket's `ticket.md` (`lf path KEY`).
3. Build one `## KEY · title` per ticket, in the order `lf loops` prints them:
   - steps without a tag directly under the heading, tagged steps under `- [ ] #tag`;
   - in each branch, oldest first: closed steps as `- [x] text` with `> outcome` under them,
     then open loops as `- [ ] text · from … · by … · else: … ^L<n>`;
   - steps chained with `after` are siblings in that order, not nested deeper.
4. Tracked tickets with no open loop: the heading alone, plus `- [ ] next step?` so the gap shows.
5. Loops without a key go under `## Без тикета`. End with an empty `## Friction`.
6. If `outline.md` already exists, **never overwrite it**: add only what is missing and say what.
7. Show the user the tree (or a summary if long), say where the file is, and `lf commit`.

Do not copy `actions.md` plans into the outline unless the user asks; that decision comes after
the week.

## Keeping it during the week

- **Re-read the file before every edit**; the user edits it by hand. Change only the lines you
  mean to change (Edit, not a rewrite); never reformat, re-indent or reorder the rest.
- **Mirror every loop action in both places, in one go:**
  - `lf loop …` → add the item under its ticket (under `#tag` if it has one) with its `^L<n>`.
  - `lf done L<n> "outcome" --next …` → mark that item `[x]`, add `> outcome` under it, add the
    next loop as the following sibling with its new id.
  - `lf bump L<n> …` → update `by` / `else` on the item.
  Confirm in one line: "L7 closed, L8 added under PROJ-1 #android (also in outline)".
- **Plain steps** the user mentions ("call Jim", "discuss with Tom") with no one to wait on and no
  deadline go **only** into the outline, as items under the right parent. Anything with a wait or
  a promise is a loop: `lf loop` first, then the item.
- **Drift check at the start of a session** (and when asked): compare `^L` items with `lf loops`.
  An item marked `[x]` by hand while the loop is still open → ask "close L7 in lf? outcome?".
  An open loop missing from the outline → add it. A `^L` item whose loop is gone → ask.
- **Views on request.** "What is active", "my waits", "what expired", "standup by the tree":
  print the matching items **with all their ancestors** (the headings and parents), nothing else,
  in the terminal. Do not write filtered copies into the vault.

## Friction log

This list is the deliverable of the week: it decides the lenses and the editor operations.

- When the user wants a filter, complains about an edit, or asks for a view you had to build by
  hand, append one line to `## Friction`: `- YYYY-MM-DD — <what, in the user's words>` and tag it
  `(lens)`, `(edit)` or `(format)`. Quote the user verbatim where you can.
- Your own observations (an ambiguity in the format, a mirror step that was awkward) go there too,
  marked `(claude)`.
- At the end of the week, when asked: group the lines by tag and count them; that summary goes to
  LFLOW-024.
