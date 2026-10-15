// `lf outline`: the tree in the terminal through a lens, the outline as it was on a day, the
// history of an item or a ticket, what changed day by day, the migration from loops.md, and small
// edits by id for the agent (add, check, edit, note, move, rm).

import { LENSES, eventLine, renderHistory, renderOutline, sectionTitle, standupSince, visibleFor } from "./render/outline.ts";
import type { Lens } from "./render/outline.ts";
import { UserError } from "./util.ts";
import { fmtDay, normalizeId } from "./vault/loopfields.ts";
import { OUTLINE_FILE, findSection } from "./vault/outline.ts";
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
  if (!o.sections.length) {
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
    const s = readModel(vault).o.sections.find((x) => x.key === key);
    write(renderHistory(`${s ? sectionTitle(s) : key} — history`, ticketHistory(vault, key, now)));
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
  out(`${OUTLINE_FILE}: ${r.sections} sections, ${r.items} items (${r.closed} closed steps from the Logs). loops.md now follows it.`);
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
    if (!findSection(readModel(vault).o, key)) applyOps(vault, [{ op: "section", key }], new Date());
    return { parent: null, section: key, index: p.top ? 0 : undefined };
  }
  throw new UserError("Where? --key KEY, --under ID or --after ID.");
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
    default:
      throw new UserError(`Unknown: lf outline ${action}. See lf help.`);
  }
  const r = applyOps(vault, ops, now);
  const m = readModel(vault);
  const ref = r.ids.new ?? (args[0] ? normalizeId(args[0]) : "");
  const it = m.o.byRef.get(ref);
  if (action === "rm") out(`removed ^${ref} (and what was under it); the vault's git keeps it`);
  else if (it) out(`${action === "add" ? "added" : action === "move" ? "moved" : "updated"} ^${it.ref} under ${sectionTitle(it.section)}${it.parent ? ` › ${it.parent.text}` : ""}: ${it.check === "x" ? "✓ " : ""}${it.text}`);
}
