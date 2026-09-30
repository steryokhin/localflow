#!/bin/sh
# Installs Local Flow for the current user: the `lf` launcher and the Claude Code skill.
# Only creates symlinks into the home directory; re-running is safe.
#
#   ~/.local/bin/lf                       -> <repo>/bin/lf
#   ~/.claude/skills/imacdev-localflow    -> <repo>/skills/imacdev-localflow

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${LF_BIN_DIR:-$HOME/.local/bin}"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

link() {
  target="$1"; dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "skip: $dest exists and is not a symlink — remove it first" >&2
    return 1
  fi
  ln -sfn "$target" "$dest"
  echo "linked $dest -> $target"
}

chmod +x "$ROOT/bin/lf"
link "$ROOT/bin/lf" "$BIN_DIR/lf"
link "$ROOT/skills/imacdev-localflow" "$SKILLS_DIR/imacdev-localflow"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on PATH — add to your shell rc:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

if command -v node >/dev/null 2>&1 || command -v bun >/dev/null 2>&1; then
  "$BIN_DIR/lf" help >/dev/null && echo "lf works: $("$BIN_DIR/lf" help | head -1)"
else
  echo "note: neither node (>= 22.18) nor bun found on PATH — lf needs one of them" >&2
fi

cat <<EOF

Next:
  lf init ~/LocalFlow --jira-url https://<jira-host> --project <KEY> --local-prefix WORK
  mkdir -p ~/.config/localflow && printf '%s' 'TOKEN' > ~/.config/localflow/jira-token && chmod 600 ~/.config/localflow/jira-token
  lf doctor
EOF
