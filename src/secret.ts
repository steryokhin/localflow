// Runs the user's secret-fetching command (e.g. Bitwarden CLI) and returns its stdout.
// The command is an argv array — never a shell string. In a terminal, stdin and stderr stay
// attached to it, so a password manager can ask for its master password. Without a terminal
// (an agent's shell) nobody can answer a prompt: stderr is captured instead, and a failure shows
// one hint rather than the tool's stack trace. The value is never logged; callers must not print it.

import { spawnSync } from "node:child_process";
import { UserError } from "./util.ts";

export const UNLOCK_HINT = "Unlock the password manager in the shell that runs lf (e.g. `export BW_SESSION=$(bw unlock --raw)`) and retry.";

export function runSecretCommand(argv: string[], interactive = !!process.stdin.isTTY && !!process.stderr.isTTY): string {
  const [cmd, ...args] = argv;
  const stdio = interactive ? (["inherit", "pipe", "inherit"] as const) : (["inherit", "pipe", "pipe"] as const);
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: [...stdio], env: process.env });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    throw new UserError(code === "ENOENT" ? `Token command not found: ${cmd}` : `Token command failed: ${res.error.message}`);
  }
  // The captured stderr is dropped, not shown: it is the password manager's noise, not ours.
  if (res.status !== 0) throw new UserError(`Token command exited with status ${res.status}: ${argv.join(" ")}${interactive ? "" : `. ${UNLOCK_HINT}`}`);
  const value = (res.stdout ?? "").trim();
  if (!value) throw new UserError(`Token command printed nothing: ${argv.join(" ")}`);
  return value;
}
