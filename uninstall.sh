#!/usr/bin/env bash
# Removes what install.sh installed. Your config and cached sounds stay unless
# you pass --purge.
set -euo pipefail

PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/red-alert"
BIN="$HOME/.local/bin/red-alert"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/red-alert"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/red-alert"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/red-alert.service"
MOD_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/red-alert"

purge=0
case "${1:-}" in
  --purge) purge=1 ;;
  "") ;;
  *) echo "Usage: ./uninstall.sh [--purge]" >&2; exit 2 ;;
esac

if [ -f "$UNIT" ]; then
  # Without your user manager (su, sudo -u, no login session) the service could
  # not be stopped: removing its files would leave it running, then broken.
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "cannot reach your systemd user manager; run this from your own login session" >&2
    exit 1
  fi
  systemctl --user disable --now red-alert.service >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl --user daemon-reload || true
  echo "removed the service"
fi
rm -f "$BIN"
rm -rf "$PREFIX"
echo "removed the daemon and CLI"

if [ -L "$MOD_DIR" ] || [ -f "$MOD_DIR/.installed-by-red-alert" ]; then
  rm -rf "$MOD_DIR"
  echo "removed the Claude Code mod"
fi

if [ "$purge" = 1 ]; then
  rm -rf "$CONFIG_DIR" "$CACHE_DIR"
  echo "removed the config and cached sounds"
else
  echo "kept $CONFIG_DIR (use --purge to remove it and the sound cache)"
fi
