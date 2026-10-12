// `lf watch`: one check of the open loops, meant to run every 15 minutes from launchd.
// Rewrites NUDGES.md and ACTIONS.md, and raises a local notification for loops that expired or
// are about to since the last check — once per loop and deadline, never during quiet hours.

import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { notify } from "./notify.ts";
import { ACTIONS_FILE, NUDGES_FILE, ensureIgnored, nudgeMessage, nudges, renderActions, renderNudges } from "./render/loops.ts";
import type { Nudges } from "./render/loops.ts";
import { readTextIfExists, writeFileAtomic } from "./util.ts";
import { syncLoops } from "./vault/loops.ts";
import type { Loop } from "./vault/loops.ts";
import { listTickets } from "./vault/store.ts";

const WATCH_FILE = "watch.json";
export const DEFAULT_QUIET_HOURS = "20:00-08:00";

/** Rewrites ACTIONS.md from loops.md; returns the open loops. */
export function refreshActions(vault: string, now: Date): Loop[] {
  const loops = syncLoops(vault);
  ensureIgnored(vault, [ACTIONS_FILE, NUDGES_FILE]);
  writeFileAtomic(path.join(vault, ACTIONS_FILE), renderActions(loops, listTickets(vault), now));
  return loops;
}

/** "20:00-08:00" (may wrap past midnight), plus weekends unless quietWeekends is false. */
export function isQuiet(now: Date, config: Config): boolean {
  const loops = config.loops ?? {};
  if (loops.quietWeekends !== false && (now.getDay() === 0 || now.getDay() === 6)) return true;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec((loops.quietHours ?? DEFAULT_QUIET_HOURS).trim());
  if (!m) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export interface WatchResult extends Nudges {
  /** Loops this check notified about (or would have, with notifications off). */
  fresh: Nudges;
  notified: boolean;
  quiet: boolean;
}

export function watchOnce(vault: string, now: Date, opts: { notify?: boolean; notifier?: (title: string, message: string) => boolean } = {}): WatchResult {
  const config = loadConfig(vault);
  const loops = refreshActions(vault, now);
  const n = nudges(loops, now);
  writeFileAtomic(path.join(vault, NUDGES_FILE), renderNudges(n, now));

  // Remember what was announced, per loop and deadline: a bumped loop is announced again.
  const file = path.join(vault, STATE_DIR, WATCH_FILE);
  let seen: Record<string, string> = {};
  try {
    seen = JSON.parse(readTextIfExists(file) ?? "{}").announced ?? {};
  } catch {
    seen = {};
  }
  const tag = (l: Loop): string => `${l.id}@${l.due}`;
  const fresh: Nudges = {
    expired: n.expired.filter((l) => seen[tag(l)] !== "expired"),
    soon: n.soon.filter((l) => !seen[tag(l)]),
  };
  const quiet = isQuiet(now, config);
  let notified = false;
  const any = fresh.expired.length + fresh.soon.length > 0;
  if (any && !quiet && opts.notify !== false) notified = (opts.notifier ?? notify)("Local Flow", nudgeMessage(fresh));
  const open = new Set(loops.map(tag));
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(seen)) if (open.has(k)) next[k] = v;
  // In quiet hours nothing is marked, so the notification comes once they end.
  if (!quiet) {
    for (const l of fresh.expired) next[tag(l)] = "expired";
    for (const l of fresh.soon) next[tag(l)] = "soon";
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ announced: next }, null, 2) + "\n");
  return { ...n, fresh, notified, quiet };
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A launchd agent that runs `lf watch` every 15 minutes. Printed, never installed by lf. */
export function launchdPlist(vault: string): string {
  const lf = path.resolve(import.meta.dirname, "..", "bin", "lf");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.localflow.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(lf)}</string>
    <string>watch</string>
    <string>--vault</string>
    <string>${xml(vault)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${xml(path.join(vault, STATE_DIR, "watch.log"))}</string>
</dict>
</plist>
`;
}
