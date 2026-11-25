#!/bin/sh
# LinkShell installer — curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh
set -eu

# ── ANSI colors (gated on TTY and NO_COLOR per no-color.org) ────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  ESC=$(printf '\033')
  BOLD="${ESC}[1m"
  DIM="${ESC}[2m"
  GREEN="${ESC}[32m"
  YELLOW="${ESC}[33m"
  RED="${ESC}[31m"
  RESET="${ESC}[0m"
else
  BOLD=""
  DIM=""
  GREEN=""
  YELLOW=""
  RED=""
  RESET=""
fi

info()  { printf "  %s%s%s\n" "$BOLD" "$1" "$RESET"; }
note()  { printf "  %s%s%s\n" "$DIM" "$1" "$RESET"; }
ok()    { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
warn()  { printf "  %s!%s %s\n" "$YELLOW" "$RESET" "$1"; }
fail()  { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1" >&2; exit 1; }

# ── OS / Linux environment detection ────────────────────────────────
OS_NAME=$(uname -s 2>/dev/null || echo "unknown")
DISTRO_ID=""
DISTRO_LIKE=""
IS_ALPINE=0
IS_MUSL=0
IS_WSL=0
IS_HEADLESS=0

if [ "$OS_NAME" = "Linux" ]; then
  if [ -r /etc/os-release ]; then
    DISTRO_ID=$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '"' | tr '[:upper:]' '[:lower:]')
    DISTRO_LIKE=$(sed -n 's/^ID_LIKE=//p' /etc/os-release | head -n 1 | tr -d '"' | tr '[:upper:]' '[:lower:]')
  fi
  if [ "$DISTRO_ID" = "alpine" ] || (ldd --version 2>&1 | grep -qi musl); then
    IS_MUSL=1
  fi
  if [ "$DISTRO_ID" = "alpine" ]; then
    IS_ALPINE=1
  fi
  if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
    IS_WSL=1
  fi
  if [ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ] || { [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; }; then
    IS_HEADLESS=1
  fi
elif [ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]; then
  IS_HEADLESS=1
fi

# ── Node 22.13+ version check & user Node manager probing ───────────
node_version_ok() {
  _bin="$1"
  [ -x "$_bin" ] || return 1
  _ver=$("$_bin" -v 2>/dev/null | sed 's/^v//') || return 1
  _maj=$(printf "%s" "$_ver" | cut -d. -f1)
  _min=$(printf "%s" "$_ver" | cut -d. -f2)
  case "$_maj$_min" in
    ""|*[!0-9]*) return 1 ;;
  esac
  if [ "$_maj" -gt 22 ] || { [ "$_maj" -eq 22 ] && [ "$_min" -ge 13 ]; }; then
    return 0
  fi
  return 1
}

prepend_path_dir() {
  _dir="$1"
  [ -d "$_dir" ] || return 0
  case ":${PATH}:" in
    *":${_dir}:"*) ;;
    *) PATH="${_dir}:${PATH}"; export PATH ;;
  esac
}

probe_node_managers() {
  # Non-interactive `curl | sh` sessions over SSH often skip ~/.bashrc / ~/.zshrc,
  # so probe common user-scoped Node managers for a Node 22.13+ binary.
  _nvm_base="${NVM_DIR:-$HOME/.nvm}"
  if [ -d "$_nvm_base/versions/node" ]; then
    _nvm_best=""
    for _d in "$_nvm_base"/versions/node/v*/bin; do
      if [ -x "$_d/node" ] && node_version_ok "$_d/node"; then
        _nvm_best="$_d"
      fi
    done
    if [ -n "$_nvm_best" ]; then
      prepend_path_dir "$_nvm_best"
      return 0
    fi
  fi

  for _cand in \
    "$HOME/.fnm/aliases/default/bin" \
    "$HOME/.local/share/fnm/aliases/default/bin" \
    "$HOME/.volta/bin" \
    "$HOME/.local/share/mise/shims" \
    "$HOME/.mise/shims" \
    "$HOME/.asdf/shims" \
    "/home/linuxbrew/.linuxbrew/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"
  do
    if [ -x "$_cand/node" ] && node_version_ok "$_cand/node"; then
      prepend_path_dir "$_cand"
      return 0
    fi
  done

  for _fnm_root in "$HOME/.fnm/node-versions" "$HOME/.local/share/fnm/node-versions"; do
    if [ -d "$_fnm_root" ]; then
      _fnm_best=""
      for _d in "$_fnm_root"/v*/installation/bin; do
        if [ -x "$_d/node" ] && node_version_ok "$_d/node"; then
          _fnm_best="$_d"
        fi
      done
      if [ -n "$_fnm_best" ]; then
        prepend_path_dir "$_fnm_best"
        return 0
      fi
    fi
  done

  return 1
}

print_node_install_hint() {
  printf "\n" >&2
  if [ "$OS_NAME" = "Darwin" ]; then
    printf "  Install Node.js 22+ on macOS:\n" >&2
    printf "    brew install node@22\n" >&2
    printf "    # or: nvm install 22\n" >&2
  elif [ "$IS_ALPINE" -eq 1 ]; then
    printf "  Install Node.js 22+ and build tools for node-pty on Alpine Linux:\n" >&2
    printf "    apk add --no-cache nodejs npm python3 make g++ linux-headers\n" >&2
  elif [ "$DISTRO_ID" = "ubuntu" ] || [ "$DISTRO_ID" = "debian" ] || printf "%s" "$DISTRO_LIKE" | grep -qE 'debian|ubuntu'; then
    printf "  Install Node.js 22+ on Debian/Ubuntu:\n" >&2
    printf "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n" >&2
    printf "    sudo apt-get install -y nodejs\n" >&2
    printf "    # or with nvm (no sudo): curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22\n" >&2
  elif [ "$DISTRO_ID" = "fedora" ] || [ "$DISTRO_ID" = "rhel" ] || [ "$DISTRO_ID" = "centos" ] || [ "$DISTRO_ID" = "rocky" ] || [ "$DISTRO_ID" = "almalinux" ] || printf "%s" "$DISTRO_LIKE" | grep -qE 'rhel|fedora'; then
    printf "  Install Node.js 22+ on Fedora/RHEL:\n" >&2
    printf "    sudo dnf module install -y nodejs:22\n" >&2
    printf "    # or: curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs\n" >&2
  elif [ "$DISTRO_ID" = "arch" ] || [ "$DISTRO_ID" = "manjaro" ] || printf "%s" "$DISTRO_LIKE" | grep -q 'arch'; then
    printf "  Install Node.js 22+ on Arch Linux:\n" >&2
    printf "    sudo pacman -S nodejs npm\n" >&2
  elif [ "$DISTRO_ID" = "opensuse-tumbleweed" ] || [ "$DISTRO_ID" = "opensuse-leap" ] || printf "%s" "$DISTRO_LIKE" | grep -q 'suse'; then
    printf "  Install Node.js 22+ on openSUSE:\n" >&2
    printf "    sudo zypper install -y nodejs22 npm22\n" >&2
  else
    printf "  Install Node.js 22.13+ from https://nodejs.org or via nvm:\n" >&2
    printf "    nvm install 22\n" >&2
  fi
  printf "\n" >&2
}

printf "\n"
info "LinkShell Installer"
printf "\n"

# ── Check Node.js ───────────────────────────────────────────────────
CURRENT_NODE=$(command -v node 2>/dev/null || true)
if [ -z "$CURRENT_NODE" ] || ! node_version_ok "$CURRENT_NODE"; then
  probe_node_managers || true
fi

if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
  NODE_VER=$(node -v | sed 's/^v//')
  # The host keeps its sessions in node:sqlite (unflagged from 22.13).
  if ! node_version_ok "$NODE_BIN"; then
    print_node_install_hint
    fail "Node.js v${NODE_VER} found (${NODE_BIN}), but LinkShell needs 22.13 or newer."
  fi
  ok "Node.js v${NODE_VER} (${NODE_BIN})"
else
  print_node_install_hint
  fail "Node.js not found. LinkShell requires Node.js 22.13 or newer."
fi

if [ "$IS_ALPINE" -eq 1 ] || [ "$IS_MUSL" -eq 1 ]; then
  if ! command -v g++ >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    warn "musl/Alpine detected without full native build toolchain; if node-pty compiles from source, run:"
    note "  apk add --no-cache python3 make g++ linux-headers"
  fi
fi

# ── Check npm ───────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  print_node_install_hint
  fail "npm not found. Please install Node.js 22.13 or newer with npm."
fi

# ── Writable global prefix check (avoid EACCES on Linux) ────────────
USER_LOCAL_PREFIX=""
NPM_PREFIX=$(npm prefix -g 2>/dev/null || true)
NEED_USER_PREFIX=0

if [ "$(id -u)" -ne 0 ]; then
  if [ -z "$NPM_PREFIX" ] || [ ! -w "$NPM_PREFIX" ]; then
    NEED_USER_PREFIX=1
  elif [ -d "$NPM_PREFIX/lib/node_modules" ] && [ ! -w "$NPM_PREFIX/lib/node_modules" ]; then
    NEED_USER_PREFIX=1
  elif [ -d "$NPM_PREFIX/bin" ] && [ ! -w "$NPM_PREFIX/bin" ]; then
    NEED_USER_PREFIX=1
  fi
fi

# ── Install ─────────────────────────────────────────────────────────
if [ "$NEED_USER_PREFIX" -eq 1 ]; then
  USER_LOCAL_PREFIX="$HOME/.npm-global"
  mkdir -p "$USER_LOCAL_PREFIX/bin" "$USER_LOCAL_PREFIX/lib/node_modules"
  warn "Global npm prefix (${NPM_PREFIX:-system}) is not writable; installing to ${USER_LOCAL_PREFIX}"
  info "Installing linkshell-cli via npm..."
  printf "\n"
  NPM_CONFIG_PREFIX="$USER_LOCAL_PREFIX" npm install -g linkshell-cli@latest
  prepend_path_dir "$USER_LOCAL_PREFIX/bin"
else
  info "Installing linkshell-cli via npm..."
  printf "\n"
  npm install -g linkshell-cli@latest
fi

printf "\n"
ok "LinkShell installed successfully!"
printf "\n"

# ── Verify ──────────────────────────────────────────────────────────
if command -v linkshell >/dev/null 2>&1; then
  VER=$(linkshell --version 2>/dev/null || echo "unknown")
  ok "linkshell ${VER} ($(command -v linkshell))"

  if [ -n "$USER_LOCAL_PREFIX" ]; then
    printf "\n"
    warn "Add ~/.npm-global/bin to your shell profile so 'linkshell' stays in PATH:"
    printf "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\"\n"
    note "  (Add that line to ~/.bashrc or ~/.zshrc, then restart your shell.)"
  fi

  printf "\n"
  if [ "$OS_NAME" = "Linux" ] && [ "$IS_HEADLESS" -eq 1 ]; then
    info "Next steps (headless Linux / SSH):"
    printf "    linkshell login --email you@example.com  # sign in without a local browser\n"
    if [ "$IS_WSL" -eq 0 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      printf "    linkshell host install-service           # run under systemd --user (auto-start on boot)\n"
    else
      printf "    linkshell host --daemon                  # start the background host\n"
    fi
    printf "    linkshell doctor                         # verify PTY, SQLite, permissions & gateway\n"
    printf "    linkshell claude                         # Claude Code you can hand to your phone\n"
  else
    info "Next: set this computer up (the host, screen permissions, your phone):"
    printf "    linkshell setup\n"
    printf "\n"
    info "Then, any time:"
    printf "    linkshell claude             # Claude Code you can hand to your phone\n"
  fi
  printf "\n"
else
  printf "\n"
  warn "'linkshell' command not found in PATH."
  if [ -n "$USER_LOCAL_PREFIX" ]; then
    printf "  Add to your shell profile (~/.bashrc or ~/.zshrc):\n"
    printf "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\"\n\n"
  else
    note "You may need to restart your terminal or add npm's global bin ($(npm prefix -g 2>/dev/null || echo '<npm-prefix>')/bin) to PATH."
    printf "\n"
  fi
fi
