import { spawnSync } from "node:child_process";

function onPath(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", cmd]).status === 0;
}

/** Open a folder or file in the user's editor: $LOCALFLOW_EDITOR, then VS Code, then the OS default. */
export function openInEditor(target: string): void {
  const custom = process.env.LOCALFLOW_EDITOR;
  const cmd = custom || (onPath("code") ? "code" : process.platform === "darwin" ? "open" : "xdg-open");
  spawnSync(cmd, [target], { stdio: "inherit" });
}
