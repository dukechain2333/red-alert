#!/usr/bin/env bash
# Installs red-alert for the current user:
#   - the daemon and CLI   ~/.local/share/red-alert, ~/.local/bin/red-alert
#   - its config           ~/.config/red-alert/config.toml (kept if present)
#   - a systemd user unit  started now and at every boot (via lingering)
#   - the Claude Code mod  ~/.claude/skills/red-alert (loads in new sessions)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/red-alert"
BIN="$HOME/.local/bin"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/red-alert"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
MOD_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/red-alert"
MARKER=".installed-by-red-alert"

with_service=1
with_mod=1
link_mod=0

usage() {
  cat <<USAGE
Usage: ./install.sh [--no-service] [--no-mod] [--link-mod]

  --no-service   install the files but do not set up the systemd service
  --no-mod       do not install the Claude Code mod
  --link-mod     symlink the mod to this checkout instead of copying it
                 (for developing the mod; edits apply to new sessions)
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --no-service) with_service=0 ;;
    --no-mod) with_mod=0 ;;
    --link-mod) link_mod=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;38;2;0;0;0;48;2;255;153;0m RED ALERT \033[0m %s\n' "$*"; }
warn() { printf '\033[1;38;2;255;204;51m  warning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;38;2;255;85;85m  error:\033[0m %s\n' "$*" >&2; exit 1; }

# -- Python 3.11+ (for tomllib) -------------------------------------------------
find_python() {
  local candidate path
  for candidate in /usr/bin/python3 python3.13 python3.12 python3.11 python3; do
    path="$(command -v "$candidate" 2>/dev/null)" || continue
    if "$path" -c 'import sys, tomllib; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
      echo "$path"
      return 0
    fi
  done
  return 1
}
PYTHON="$(find_python)" || die "red-alert needs Python 3.11 or newer (for tomllib)"
say "using $PYTHON ($("$PYTHON" -c 'import platform; print(platform.python_version())'))"

# -- daemon, CLI and config -----------------------------------------------------
mkdir -p "$PREFIX" "$BIN" "$CONFIG_DIR"
install -m 0755 "$REPO/red_alert.py" "$PREFIX/red_alert.py"
install -m 0644 "$REPO/config.example.toml" "$PREFIX/config.example.toml"
cat > "$BIN/red-alert" <<WRAPPER
#!/bin/sh
exec "$PYTHON" "$PREFIX/red_alert.py" "\$@"
WRAPPER
chmod 0755 "$BIN/red-alert"
say "installed the daemon and CLI: $BIN/red-alert"

if [ -f "$CONFIG_DIR/config.toml" ]; then
  say "kept your config: $CONFIG_DIR/config.toml"
else
  install -m 0644 "$REPO/config.example.toml" "$CONFIG_DIR/config.toml"
  say "wrote the default config: $CONFIG_DIR/config.toml"
fi
"$PYTHON" -c 'import sys; sys.path.insert(0, sys.argv[1]); import red_alert; red_alert.load_config()' "$PREFIX" \
  || die "the config does not load; fix $CONFIG_DIR/config.toml and run this again"

player=""
for candidate in pw-play paplay ffplay mpv mpg123; do
  if command -v "$candidate" >/dev/null 2>&1; then player="$candidate"; break; fi
done
if [ -z "$player" ]; then
  warn "no audio player found: install pipewire-bin, pulseaudio-utils, ffmpeg or mpv"
fi

# -- systemd user service -------------------------------------------------------
if [ "$with_service" = 1 ]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found (use --no-service and run 'red-alert serve' yourself)"
  mkdir -p "$UNIT_DIR"
  sed -e "s|@PYTHON@|$PYTHON|g" -e "s|@PREFIX@|$PREFIX|g" \
    "$REPO/systemd/red-alert.service" > "$UNIT_DIR/red-alert.service"
  systemctl --user daemon-reload
  systemctl --user enable red-alert.service >/dev/null 2>&1
  systemctl --user restart red-alert.service
  say "service enabled and started: systemctl --user status red-alert"

  user="${USER:-$(id -un)}"
  if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
    if loginctl enable-linger "$user" 2>/dev/null; then
      say "enabled lingering: the service now starts at boot, before anyone logs in"
    else
      warn "could not enable lingering; to start at boot run: sudo loginctl enable-linger $user"
    fi
  fi

  for _ in $(seq 1 20); do
    if "$BIN/red-alert" status >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  "$BIN/red-alert" status || warn "the daemon is not answering yet: journalctl --user -u red-alert"
fi

# -- Claude Code mod ------------------------------------------------------------
if [ "$with_mod" = 1 ]; then
  if [ -e "$MOD_DIR" ] && [ ! -L "$MOD_DIR" ] && [ ! -f "$MOD_DIR/$MARKER" ]; then
    warn "$MOD_DIR exists and was not installed by red-alert; left it alone"
  else
    rm -rf "$MOD_DIR"
    mkdir -p "$(dirname "$MOD_DIR")"
    if [ "$link_mod" = 1 ]; then
      ln -s "$REPO/plugin" "$MOD_DIR"
      say "linked the Claude Code mod: $MOD_DIR -> $REPO/plugin"
    else
      mkdir -p "$MOD_DIR"
      tar -C "$REPO/plugin" --exclude=./tests --exclude=./.claude --exclude=./node_modules -cf - . \
        | tar -C "$MOD_DIR" -xf -
      touch "$MOD_DIR/$MARKER"
      say "installed the Claude Code mod: $MOD_DIR"
    fi
    say "start a new Claude Code session to load it (it shows up as red-alert@skills-dir)"
  fi
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn "$BIN is not on your PATH; add it to use the red-alert command" ;;
esac

say "done. Try: red-alert test"
