// Moving loops.md into outline.md: every open loop becomes an item under its ticket's heading (ids
// kept), and the closed steps of each ticket's Log come first, checked off, with their outcome as
// context. Idempotent: what is already in the outline is left alone.

import { formatLoopItem } from "./loopfields.ts";
import { closedSteps } from "./loops.ts";
import { notesText, readLog } from "./notes.ts";
import { insertItem, outlineText, parseOutline, withIds } from "./outline.ts";
import { apply, editModel, ensureTicket, readModel } from "./outline-store.ts";
import type { Model } from "./outline-store.ts";
import { listTickets } from "./store.ts";

export interface MigrateResult {
  /** Tickets in the outline. */
  tickets: number;
  items: number;
  /** Closed steps brought in from the Logs. */
  closed: number;
  /** With dryRun: the outline.md it would write. */
  text?: string;
}

function addClosedSteps(vault: string, m: Model): number {
  let n = 0;
  for (const t of listTickets(vault)) {
    const steps = closedSteps(readLog(notesText(t))).filter((c) => !m.o.byRef.has(c.id));
    if (!steps.length) continue;
    const home = ensureTicket(m, t.key).ref;
    steps.forEach((c, i) => {
      const text = formatLoopItem({ id: c.id, created: "", key: t.key, text: c.text, owner: "me", due: "", onExpiry: "", tag: c.tag, after: c.after, done: c.date }, null);
      apply(m, insertItem(m.o, { parent: home, index: i }, { id: c.id, check: "x", text, context: [c.outcome] }));
      n++;
    });
  }
  return n;
}

export function migrateOutline(vault: string, opts: { dryRun?: boolean; log?: boolean } = {}): MigrateResult {
  if (opts.dryRun) {
    const m = readModel(vault);
    const closed = opts.log === false ? 0 : addClosedSteps(vault, m);
    const text = outlineText(withIds(m.o));
    const o = parseOutline(text);
    return { tickets: o.items.filter((it) => it.ticket).length, items: o.items.length, closed, text };
  }
  const closed = editModel(vault, (m) => {
    const added = opts.log === false ? 0 : addClosedSteps(vault, m);
    m.summary.push(`migrate loops.md${added ? ` and ${added} closed steps` : ""}`);
    return { result: added };
  }, () => "outline.md changed during the migration; run it again.");
  const o = readModel(vault).o;
  return { tickets: o.items.filter((it) => it.ticket).length, items: o.items.length, closed };
}
