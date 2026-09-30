---
title: Web UI design — Local Flow stage 2
status: approved
created: 2026-09-30
decided: 2026-09-30
---

# Web UI design — `lf serve`

## РЕШЕНО (2026-09-30) — variant A′: four Finder-style panes

Chosen by the user after seeing the mockups: variant **A** with one structural change.

1. **Pane 1 — nav.** As in A: Local Flow, All open, statuses with unread counts, projects, Notes.
2. **Pane 2 — ticket list.** Flat list for the current filter, with search. No tree/expanding
   rows in this version ("if the flat list is not enough we complicate it in the next version").
3. **Pane 3 — folder contents.** A ticket is always a folder. Selecting a ticket opens a
   Finder-style column listing that folder: the first card is always **Original Task**, pinned
   to the top (= `ticket.md`, the Jira mirror, read-only). Below it the user's own files —
   analyses, architectures, diagrams, experiments, meeting feedback — plus "+ new file".
   Sync-owned `attachments/` and `raw/` are not listed as files (attachments show inside the
   ticket render).
4. **Pane 4 — content.** Original Task renders like the mockup's ticket page (Jira mirror with
   amber "new" highlights). A user file opens in the editor: Markdown + live preview, frontmatter
   as a properties strip (status / priority / taken for `notes.md`).
5. **History instead of "Changes".** A chronological event feed per ticket, like Jira's Activity:
   "status Open → In Progress · 12 Sep", "comment by Olga · 11 Sep", "description changed", one
   after another; unread events highlighted. Source: sync commit bodies from git log; Jira's own
   changelog can be added later when the transport fetches it. Placement (not explicitly decided,
   default until the user says otherwise): a second pinned card **History** under Original Task
   in pane 3.
6. Non-ticket notes: `notes/` tree in pane 1 (as in A); a note opens in pane 4 in the editor;
   pane 3 is empty/hidden for plain notes.
7. Kept from the mockups unless changed later: "Mark seen" is manual; amber = new, blue = nav;
   Jira status and ⚠ "Jira is ahead" on list rows; `local` badge on local tickets;
   ⌘S saves, ⌘K search; light/dark by system.
8. Explicitly not decided yet — revisit when it hurts: sub-item hierarchy (epic → story → task)
   in pane 2; `notes/` layout (flat vs per project); auto-seen on open.

## What exists today (from the code, not imagined)

- Data lives in a vault folder; everything is files, tracked by a local git repo
  (`src/vault/store.ts`, `src/vault/git.ts`).
- A ticket is a folder `projects/<PREFIX>/<KEY>-slug/` with three layers:
  1. `ticket.md` — generated mirror of Jira (frontmatter with all fields, description, acceptance
     criteria, steps, other fields, related issues, attachments list, comments). Read-only.
     Images are relative links into `attachments/`.
  2. `notes.md` + any other user files (`scratchpad.md`, `plan.md`, …). Editable. `notes.md`
     frontmatter holds the user's workflow `status` (`inbox → inprogress → inreview → done`,
     `archived`), optional `priority`, `taken`.
  3. History: git commits. Sync commits carry per-ticket change lines ("status Open → In Progress;
     new comment by X"). "Unread" = change lines newer than the ticket's `seen` commit
     (`src/vault/state.ts`). `lf diff KEY` = git diff seen..HEAD of `ticket.md` + attachments.
- Local tickets (`source: local`) have an editable `ticket.md`.
- `INBOX.md` is a generated overview: unread first, then the board by status.
- CLI: `lf ls`, `lf inbox`, `lf diff`, `lf seen`, `lf start`, `lf status`, `lf note`, `lf create`,
  `lf report`, `lf sync` / `lf import`.

New requirement from the user (2026-09-30): **not everything is a ticket.** Some things are plain
notes that live in the same vault but outside the kanban — project docs, journal, decisions,
architecture notes. They are local only (never synced). Proposed home: `notes/` at the vault root,
optionally with subfolders (`notes/<project>/…`). Same markdown, same editor, same git.

## Constraints

- Node/Bun, zero dependencies, own Markdown renderer, vanilla JS in the page.
- Server binds `127.0.0.1` only; no external resources (fonts, CDNs) — everything inline.
- Light and dark theme (system preference).
- Editor: Markdown textarea with live preview (decided). No WYSIWYG.
- "What's new" is highlighted inside the ticket text (decided): new comments and changed
  paragraphs get a colored bar + a summary at the top; computed from git diff seen..HEAD.

## Screens (common to all variants)

1. **Ticket** — header: key, title, user status (select), Jira status (+ ⚠ when Jira is ahead),
   priority, assignee, link to Jira. Tabs: *Ticket* (mirror, read-only, images inline, new parts
   highlighted) · *Notes* (list of user files; each opens in the editor) · *Changes* (commit list
   for this ticket, click → diff).
2. **Editor** — textarea + live preview side by side; Cmd+S saves; frontmatter shown as a small
   properties strip above the text (status/priority editable there).
3. **Board / list** — tickets filtered by status, project, mine, unread, text search.
4. **Notes (non-ticket)** — tree of `notes/`, open → editor; "new note" button.
5. **Inbox / what's new** — unread tickets with their change summaries; "mark all seen".

## Variants

### A — Three panes (Tolaria-like)

Left nav (statuses with unread counts · saved views · projects · Notes tree · "+ local ticket").
Middle: ticket list for the current filter with search. Right: the selected ticket with tabs.
Notes (non-ticket) open in the same right pane.

- Plus: familiar, everything reachable in one screen, list stays visible while reading.
- Minus: three columns need width (≥1200px comfortable); the middle list eats space on a laptop.
- Complexity: M.

### B — Kanban board + full-page ticket

Home is a board: columns Inbox · In progress · In review · Done (collapsed). Cards: key, priority,
title, Jira status, unread dot, assignee when not mine. Drag between columns = status change.
Clicking a card opens the ticket as a full page (tabs as above) with a "back to board" crumb.
Notes (non-ticket) are a separate top-level section in the top bar ("Board · Inbox · Notes · Report").

- Plus: matches the user's mental model ("канбан"); status change is one drag; readable on a laptop.
- Minus: no list-while-reading; navigation between tickets goes through the board.
- Complexity: M (drag-and-drop in vanilla JS is small; the rest is shared).

### C — Inbox-first (feed)

Home is the "what's new" feed: each unread ticket as a card with its change lines, newest first,
"seen" per card. Below the feed, a compact "in progress" strip. Ticket opens full-page with the
notes editor already visible beside the mirror (two columns: mirror left, notes right). Board and
Notes are secondary pages in the top bar.

- Plus: optimized for the daily loop "what changed → react → note it"; the notes editor is always
  next to the ticket, no tab switching.
- Minus: when nothing is unread the home page is empty-ish; board is second-class.
- Complexity: M.

## Recommendation

**B for navigation, C's ticket page.** The board is the home (the user thinks in kanban and the
status change by drag is the most frequent action after reading); the ticket page shows the
mirror and the notes editor side by side (C), with *Changes* as a tab on the mirror side. Inbox is
one click away and also surfaces as unread dots on cards. Notes (non-ticket) are a section of
their own with a folder tree and the same editor.

## Open questions

1. Board columns: fixed four (inbox, inprogress, inreview, done) + archived hidden, or configurable?
2. Should "Done" be a collapsed column or a separate list page?
3. Notes (non-ticket): flat folder with optional subfolders, or mirror the project structure
   (`notes/<PREFIX>/…`) so a project's docs sit next to its tickets in the nav?
4. Auto-mark a ticket as seen when opened, or only by explicit button?
5. Local tickets: same board, distinguished by a "local" badge — OK?
6. Should the board also show Jira status on the card, or only the user's status column?
