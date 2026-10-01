// Runs the user's secret-fetching command (e.g. Bitwarden CLI) and returns its stdout.
// The command is an argv array — never a shell string — and only stdout is captured: stdin and
// stderr stay attached to the terminal, so a password manager can ask for its master password.
// The value is never logged; callers must not print it either.

import { spawnSync } from "node:child_process";
import { UserError } from "./util.ts";

export function runSecretCommand(argv: string[]): string {
  const [cmd, ...args] = argv;
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], env: process.env });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    throw new UserError(code === "ENOENT" ? `Token command not found: ${cmd}` : `Token command failed: ${res.error.message}`);
  }
  if (res.status !== 0) throw new UserError(`Token command exited with status ${res.status}: ${argv.join(" ")}`);
  const value = (res.stdout ?? "").trim();
  if (!value) throw new UserError(`Token command printed nothing: ${argv.join(" ")}`);
  return value;
}
