#!/bin/sh
# LinkShell installer — curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh
set -e

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
RESET="\033[0m"

info()  { printf "  ${BOLD}%s${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail()  { printf "  ${RED}✗${RESET} %s\n" "$1"; exit 1; }

echo ""
info "LinkShell Installer"
echo ""

# ── Check Node.js ───────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
  # The host keeps its sessions in node:sqlite (unflagged from 22.13).
  if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
    fail "Node.js v${NODE_VER} found, but LinkShell needs 22.13 or newer. Upgrade Node.js first (nvm install 22, or brew upgrade node)."
  fi
  ok "Node.js v${NODE_VER}"
else
  fail "Node.js not found. Please install Node.js 22.13 or newer first: https://nodejs.org"
fi

# ── Check npm ───────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found. Please install Node.js 22.13 or newer, which includes npm."
fi

# ── Install ─────────────────────────────────────────────────────────
info "Installing linkshell-cli via npm..."
echo ""

npm install -g linkshell-cli@latest

echo ""
ok "LinkShell installed successfully!"
echo ""

# ── Verify ──────────────────────────────────────────────────────────
if command -v linkshell >/dev/null 2>&1; then
  VER=$(linkshell --version 2>/dev/null || echo "unknown")
  ok "linkshell ${VER}"
  echo ""
  info "Get started:"
  echo "    linkshell host --daemon      # start LinkShell in the background"
  echo "    linkshell login              # Pro: the official gateway, no pairing"
  echo "    linkshell pair               # or pair a phone through your own gateway"
  echo "    linkshell claude             # Claude Code you can hand to your phone"
  echo ""
else
  echo ""
  info "Note: 'linkshell' command not found in PATH."
  info "You may need to restart your terminal or add npm's global bin to PATH."
  echo ""
fi
