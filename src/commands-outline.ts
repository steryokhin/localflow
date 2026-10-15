// `lf outline`: the tree in the terminal through a lens, the outline as it was on a day, the
// history of an item or a ticket, what changed day by day, the migration from loops.md, and small
// edits by id for the agent (add, check, edit, note, move, rm).

import { LENSES, eventLine, placeLine, renderHistory, renderOutline, standupSince, visibleFor } from "./render/outline.ts";
import type { Lens } from "./render/outline.ts";
import { refreshInbox } from "./render/inbox.ts";
import { UserError } from "./util.ts";
import { fmtDay, normalizeId } from "./vault/loopfields.ts";
import { OUTLINE_FILE, ticketItem } from "./vault/outline.ts";
import { changesByDay, checkedSince, itemHistory, outlineAt, ticketHistory } from "./vault/outline-history.ts";
import { applyOps } from "./vault/outline-ops.ts";
import type { Op, PlaceIn } from "./vault/outline-ops.ts";
import { migrateOutline } from "./vault/outline-migrate.ts";
import { readModel } from "./vault/outline-store.ts";
import { KEY_ONLY_RE } from "./vault/store.ts";

const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const write = (text: string): void => void process.stdout.write(text.replace(CONTROL_RE, ""));
const out = (line = ""): void => write(`${line}\n`);

export interface OutlineViewOptions {
  lens?: string;
  key?: string;
  find?: string;
  at?: string;
  ids?: boolean;
}

function lensOf(raw: string | undefined): Lens {
  const lens = (raw ?? "all").toLowerCase();
  if (!(LENSES as readonly string[]).includes(lens)) throw new UserError(`No lens "${raw}". Lenses: ${LENSES.join(", ")}.`);
  return lens as Lens;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayOf(raw: string, now: Date): string {
  const s = raw.trim().toLowerCase();
  if (s === "today") return fmtDay(now);
  if (s === "yesterday") return fmtDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const m = /^-(\d+)d$/.exec(s);
  if (m) return fmtDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(m[1])));
  if (!DAY_RE.test(s)) throw new UserError(`Not a day: "${raw}". Use YYYY-MM-DD, today, yesterday or -3d.`);
  return s;
}

export function cmdOutlineView(vault: string, opts: OutlineViewOptions): void {
  const now = new Date();
  const lens = lensOf(opts.lens);
  let o = readModel(vault).o;
  let title = "";
  if (opts.at) {
    const day = dayOf(opts.at, now);
    const v = outlineAt(vault, day, now);
    if (!v) throw new UserError(`No outline on ${day} yet: its history starts with the first commit of ${OUTLINE_FILE}.`);
    o = v.o;
    title = `As of the end of ${day}${v.sha ? ` (commit ${v.sha.slice(0, 10)}, ${v.date.slice(0, 16).replace("T", " ")})` : ""}`;
  }
  if (!o.items.length) {
    out(`${OUTLINE_FILE} is empty. Add a loop (lf loop …), an item (lf outline add …), or move loops.md in: lf outline --migrate`);
    return;
  }
  const checked = lens === "standup" ? checkedSince(vault, standupSince(now), now) : undefined;
  const visible = lens === "all" && !opts.key && !opts.find ? undefined : visibleFor(o, lens, now, { key: opts.key, query: opts.find, checkedSince: checked });
  if (title) {
    out(title);
    out();
  }
  if (visible && !visible.matched && lens !== "all") {
    out(`Nothing in the ${lens} lens${opts.key ? ` for ${opts.key.toUpperCase()}` : ""}${opts.find ? ` matching "${opts.find}"` : ""}.`);
    return;
  }
  write(renderOutline(o, now, { visible, ids: opts.ids }));
}

/** History of a ticket's part of the outline (KEY) or of one item and what grew under it (id). */
export function cmdOutlineHistory(vault: string, target: string): void {
  const now = new Date();
  const t = target.trim();
  if (KEY_ONLY_RE.test(t.toUpperCase()) && /-\d+$/.test(t)) {
    const key = t.toUpperCase();
    const t = ticketItem(readModel(vault).o, key);
    write(renderHistory(`${t ? t.text : key} — history`, ticketHistory(vault, key, now)));
    return;
  }
  const id = normalizeId(t);
  const events = itemHistory(vault, id, {}, now);
  const it = readModel(vault).o.byRef.get(id);
  const name = it ? `"${it.text}" ^${id}` : events.length ? `"${events[events.length - 1].text}" ^${id} (no longer in the outline)` : `^${id}`;
  write(renderHistory(`${name} — history`, events));
}

export function cmdOutlineDays(vault: string, opts: { since?: string; until?: string }): void {
  const now = new Date();
  const since = opts.since ? dayOf(opts.since, now) : dayOf("-6d", now);
  const until = opts.until ? dayOf(opts.until, now) : undefined;
  const days = changesByDay(vault, { since, until }, now);
  if (!days.length) {
    out(`No changes to ${OUTLINE_FILE} since ${since}.`);
    return;
  }
  for (const d of days) {
    out(`${d.day} — ${d.events.length} change${d.events.length === 1 ? "" : "s"}`);
    let section = "";
    for (const e of d.events) {
      if (e.section !== section) {
        out(`  ${e.section}`);
        section = e.section;
      }
      out(`    ${e.sha ? e.date.slice(11, 16) : "now  "}  ${eventLine(e)}`);
    }
    out();
  }
}

export function cmdOutlineMigrate(vault: string, opts: { dryRun?: boolean; log?: boolean }): void {
  const r = migrateOutline(vault, opts);
  if (opts.dryRun) {
    write(r.text || "(empty)\n");
    out();
    out(`dry run: ${r.items} items (${r.closed} closed steps from the Logs); nothing written.`);
    return;
  }
  out(`${OUTLINE_FILE}: ${r.tickets} tickets, ${r.items} items (${r.closed} closed steps from the Logs). loops.md now follows it.`);
}

// ---------- small edits for the agent ----------

export interface EditPlace {
  key?: string;
  under?: string;
  after?: string;
  top?: boolean;
}

function placeOf(vault: string, p: EditPlace): PlaceIn {
  if (p.after) return { after: normalizeId(p.after) };
  if (p.under) return { parent: normalizeId(p.under), index: p.top ? 0 : undefined };
  if (p.key) {
    const key = p.key.toUpperCase();
    if (!ticketItem(readModel(vault).o, key)) applyOps(vault, [{ op: "ticket", key }], new Date());
    return { parent: ticketItem(readModel(vault).o, key)!.ref, index: p.top ? 0 : undefined };
  }
  if (p.top) return { parent: null };
  throw new UserError("Where? --key KEY, --under ID, --after ID or --top (the top level).");
}

export function cmdOutlineEdit(vault: string, action: string, args: string[], opts: EditPlace & { note?: boolean }): void {
  const now = new Date();
  const id = (): string => {
    if (!args[0]) throw new UserError(`Usage: lf outline ${action} ID …`);
    return normalizeId(args[0]);
  };
  const text = (from: number): string => args.slice(from).join(" ").trim();
  let ops: Op[];
  switch (action) {
    case "add": {
      const t = text(0);
      if (!t) throw new UserError('Usage: lf outline add "TEXT" (--key KEY | --under ID | --after ID) [--note]');
      ops = [{ op: "insert", temp: "new", place: placeOf(vault, opts), item: { text: t, check: opts.note ? null : " " } }];
      break;
    }
    case "check":
      ops = [{ op: "check", id: id(), check: "x", outcome: text(1) }];
      break;
    case "uncheck":
      ops = [{ op: "check", id: id(), check: " " }];
      break;
    case "edit":
      if (!text(1)) throw new UserError('Usage: lf outline edit ID "NEW TEXT"');
      ops = [{ op: "text", id: id(), text: text(1) }];
      break;
    case "note": {
      const it = readModel(vault).o.byRef.get(id());
      if (!it) throw new UserError(`No item ^${id()}.`);
      if (!text(1)) throw new UserError('Usage: lf outline note ID "a line of context"');
      ops = [{ op: "context", id: id(), context: [...it.context, text(1)] }];
      break;
    }
    case "move":
      ops = [{ op: "move", id: id(), place: placeOf(vault, opts) }];
      break;
    case "rm":
      ops = [{ op: "delete", id: id() }];
      break;
    case "ticket": {
      // lf outline ticket ID          — that item becomes a new local ticket
      // lf outline ticket KEY [place] — an existing ticket into the outline
      // lf outline ticket "title" [place] — a new local ticket
      const arg = text(0);
      if (!arg) throw new UserError('Usage: lf outline ticket (ID | KEY | "new ticket title") [--under ID | --after ID | --top]');
      const hasPlace = opts.under || opts.after || opts.top;
      const place = hasPlace ? placeOf(vault, { ...opts, key: undefined }) : { parent: null };
      if (args.length === 1 && readModel(vault).o.byRef.has(normalizeId(arg))) ops = [{ op: "ticket", id: normalizeId(arg) }];
      else if (KEY_ONLY_RE.test(arg.toUpperCase()) && /-\d+$/.test(arg)) ops = [{ op: "ticket", key: arg, place, temp: "new" }];
      else ops = [{ op: "ticket", title: arg, place, temp: "new" }];
      break;
    }
    default:
      throw new UserError(`Unknown: lf outline ${action}. See lf help.`);
  }
  const r = applyOps(vault, ops, now);
  if (r.created.length) refreshInbox(vault);
  for (const k of r.created) out(`created local ticket ${k}`);
  const m = readModel(vault);
  const ref = r.ids.new ?? (args[0] ? normalizeId(args[0]) : "");
  const it = m.o.byRef.get(ref);
  if (action === "rm") out(`removed ^${ref} (and what was under it); the vault's git keeps it`);
  else if (it) out(`${action === "add" || action === "ticket" ? "added" : action === "move" ? "moved" : "updated"} ^${it.ref} under ${placeLine(it)}: ${it.check === "x" ? "✓ " : ""}${it.text}`);
}
