#!/bin/sh
# LinkShell installer — curl -fsSL https://linkshell.dev/install.sh | sh
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
  if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js v${NODE_VER} found, but >= 18 is required. Please upgrade Node.js first."
  fi
  ok "Node.js v${NODE_VER}"
else
  fail "Node.js not found. Please install Node.js >= 18 first: https://nodejs.org"
fi

# ── Check npm ───────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found. Please install Node.js >= 18 which includes npm."
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
  echo "    linkshell start              # start a bridge session"
  echo "    linkshell doctor             # check your environment"
  echo "    linkshell setup              # interactive configuration"
  echo ""
else
  echo ""
  info "Note: 'linkshell' command not found in PATH."
  info "You may need to restart your terminal or add npm's global bin to PATH."
  echo ""
fi
