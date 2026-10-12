// A desktop notification on this machine (macOS Notification Center via osascript). Nothing is
// sent anywhere else. Fixed argv, no shell; on other platforms it is a no-op.

import { spawnSync } from "node:child_process";

/** AppleScript string literal: quotes and backslashes escaped, control characters flattened. */
function appleString(s: string): string {
  return `"${s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function notify(title: string, message: string): boolean {
  if (process.platform !== "darwin") return false;
  const script = `display notification ${appleString(message.slice(0, 400))} with title ${appleString(title)} sound name "default"`;
  return spawnSync("osascript", ["-e", script], { stdio: "ignore", timeout: 10_000 }).status === 0;
}
