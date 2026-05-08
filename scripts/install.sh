#!/bin/sh
set -eu

REPO="autoworks-ai/autovault"
REF="${AUTOVAULT_REF:-main}"
HOME_DIR="${AUTOVAULT_HOME:-$HOME/.autovault}"
APP_DIR="$HOME_DIR/app"
BIN_DIR="${AUTOVAULT_BIN_DIR:-$HOME_DIR/bin}"
STORAGE_PATH="${AUTOVAULT_STORAGE_PATH:-$HOME_DIR}"
ENV_FILE="$HOME_DIR/env"

if [ -t 1 ] && [ -z "${NO_COLOR-}" ]; then
  BOLD="$(tput bold 2>/dev/null || printf '')"
  GREY="$(tput setaf 8 2>/dev/null || tput setaf 0 2>/dev/null || printf '')"
  RED="$(tput setaf 1 2>/dev/null || printf '')"
  GREEN="$(tput setaf 2 2>/dev/null || printf '')"
  YELLOW="$(tput setaf 3 2>/dev/null || printf '')"
  BLUE="$(tput setaf 4 2>/dev/null || printf '')"
  MAGENTA="$(tput setaf 5 2>/dev/null || printf '')"
  CYAN="$(tput setaf 6 2>/dev/null || printf '')"
  RESET="$(tput sgr0 2>/dev/null || printf '')"
else
  BOLD=""
  GREY=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  MAGENTA=""
  CYAN=""
  RESET=""
fi

info()      { printf '%s\n' "${BOLD}${GREY}>${RESET} $*"; }
warn()      { printf '%s\n' "${YELLOW}! $*${RESET}"; }
error()     { printf '%s\n' "${RED}x $*${RESET}" >&2; }
completed() { printf '%s\n' "${GREEN}✓${RESET} $*"; }
plain()     { printf '%s\n' "$*"; }

fail() {
  error "$*"
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

confirm() {
  if [ -n "${AUTOVAULT_YES-}" ]; then
    return 0
  fi
  if [ -t 0 ]; then
    printf '%s' "${MAGENTA}?${RESET} $* ${BOLD}[y/N]${RESET} "
    read -r yn || yn=""
  elif (: </dev/tty) 2>/dev/null; then
    printf '%s' "${MAGENTA}?${RESET} $* ${BOLD}[y/N]${RESET} "
    read -r yn </dev/tty 2>/dev/null || yn=""
  else
    fail "no TTY available; rerun with AUTOVAULT_YES=1 to skip the confirmation"
  fi
  case "$yn" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) fail "aborted by user" ;;
  esac
}

detect_platform() {
  uname_s="$(uname -s 2>/dev/null || printf 'unknown')"
  case "$uname_s" in
    Darwin) printf 'macOS' ;;
    Linux)  printf 'Linux' ;;
    *BSD)   printf '%s' "$uname_s" ;;
    MINGW*|MSYS*|CYGWIN*) printf 'Windows' ;;
    *) printf '%s' "$uname_s" ;;
  esac
}

detect_arch() {
  uname_m="$(uname -m 2>/dev/null || printf 'unknown')"
  case "$uname_m" in
    x86_64|amd64)  printf 'x86_64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) printf '%s' "$uname_m" ;;
  esac
}

path_contains_bin() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_shell_profile() {
  if [ -n "${AUTOVAULT_PROFILE_FILE:-}" ]; then
    printf '%s\n' "$AUTOVAULT_PROFILE_FILE"
    return 0
  fi

  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)
      printf '%s\n' "$HOME/.zshrc"
      ;;
    bash)
      if [ -f "$HOME/.bash_profile" ]; then
        printf '%s\n' "$HOME/.bash_profile"
      elif [ -f "$HOME/.bashrc" ]; then
        printf '%s\n' "$HOME/.bashrc"
      else
        printf '%s\n' "$HOME/.bashrc"
      fi
      ;;
    sh|dash|ksh)
      printf '%s\n' "$HOME/.profile"
      ;;
    *)
      return 1
      ;;
  esac
}

write_env_file() {
  cat > "$ENV_FILE" <<EOF
# AutoVault environment
case ":\$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) export PATH="$BIN_DIR:\$PATH" ;;
esac
EOF
}

ensure_profile_sources_env() {
  [ "${AUTOVAULT_NO_PROFILE_UPDATE:-0}" != "1" ] || return 2
  path_contains_bin && return 3

  profile_file="$(detect_shell_profile)" || return 1
  profile_dir="$(dirname "$profile_file")"
  mkdir -p "$profile_dir"
  touch "$profile_file" 2>/dev/null || return 1

  if grep -F "$ENV_FILE" "$profile_file" >/dev/null 2>&1; then
    printf '%s\n' "$profile_file"
    return 0
  fi

  {
    printf '\n'
    printf '# AutoVault\n'
    printf '[ -f "%s" ] && . "%s"\n' "$ENV_FILE" "$ENV_FILE"
  } >> "$profile_file" || return 1

  printf '%s\n' "$profile_file"
  return 0
}

print_banner() {
  printf '\n'
  printf '%s\n' "${BOLD}${MAGENTA}  AutoVault installer${RESET}"
  printf '%s\n' "${GREY}  curated skill vault for Claude Code, Codex, and Cursor${RESET}"
  printf '\n'
}

print_celebration() {
  printf '\n'
  printf '%s\n' "${MAGENTA}        _         __     __         _ _   ${RESET}"
  printf '%s\n' "${MAGENTA}   __ _| |_ _   _ \\ \\   / /_ _ _   _| | |_ ${RESET}"
  printf '%s\n' "${MAGENTA}  / _\` | __| | | | \\ \\ / / _\` | | | | | __|${RESET}"
  printf '%s\n' "${MAGENTA} | (_| | |_| |_| |  \\ V / (_| | |_| | | |_ ${RESET}"
  printf '%s\n' "${MAGENTA}  \\__,_|\\__|\\__,_|   \\_/ \\__,_|\\__,_|_|\\__|${RESET}"
  printf '\n'
  printf '%s\n' "         ${GREEN}AutoVault is ready.${RESET}"
  printf '\n'
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

print_banner

need curl
need tar
need node
need npm

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"
NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//' || printf 'unknown')"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"

info "Detecting platform…"
completed "$PLATFORM $ARCH / Node $NODE_VERSION"

[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js >= 20 is required; found $(node --version 2>/dev/null || printf 'unknown')"

plain ""
plain "${BOLD}Install plan${RESET}"
plain "  ${GREY}repo    ${RESET} $REPO@$REF"
plain "  ${GREY}app     ${RESET} $APP_DIR"
plain "  ${GREY}storage ${RESET} $STORAGE_PATH"
plain "  ${GREY}shim    ${RESET} $BIN_DIR/autovault"
plain ""

confirm "Install AutoVault to $HOME_DIR and seed bundled skills?"

# ---------------------------------------------------------------------------
# Download + build
# ---------------------------------------------------------------------------

case "$REF" in
  v*|[0-9]*)
    DEFAULT_TARBALL="https://github.com/$REPO/archive/refs/tags/$REF.tar.gz"
    ;;
  *)
    DEFAULT_TARBALL="https://github.com/$REPO/archive/refs/heads/$REF.tar.gz"
    ;;
esac

TARBALL_URL="${AUTOVAULT_TARBALL_URL:-$DEFAULT_TARBALL}"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t autovault)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

plain ""
info "Downloading source…"
curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/autovault.tgz"
mkdir -p "$TMP_DIR/src"
tar -xzf "$TMP_DIR/autovault.tgz" -C "$TMP_DIR/src" --strip-components=1
[ -f "$TMP_DIR/src/package.json" ] || fail "downloaded archive does not look like AutoVault"
completed "Fetched $REF"

cd "$TMP_DIR/src"

info "Installing dependencies…"
npm ci --silent >/dev/null 2>&1 || npm ci
completed "npm ci done"

info "Building…"
npm run build --silent >/dev/null 2>&1 || npm run build
completed "Built dist/"

# ---------------------------------------------------------------------------
# Bootstrap bundled skills (validation gate runs here)
# ---------------------------------------------------------------------------

if [ "${AUTOVAULT_NO_BOOTSTRAP:-0}" != "1" ]; then
  info "Seeding bundled skills…"
  AUTOVAULT_STORAGE_PATH="$STORAGE_PATH" node scripts/bootstrap-skills.mjs >/dev/null
  completed "Bundled skills bootstrapped"
fi

# ---------------------------------------------------------------------------
# Atomic swap into $APP_DIR + write shim
# ---------------------------------------------------------------------------

info "Installing shim…"
mkdir -p "$HOME_DIR" "$BIN_DIR"
rm -rf "$APP_DIR.next"
mkdir -p "$APP_DIR.next"
cp -R "$TMP_DIR/src/." "$APP_DIR.next/"

if [ -d "$APP_DIR" ]; then
  rm -rf "$APP_DIR.previous"
  mv "$APP_DIR" "$APP_DIR.previous"
fi

mv "$APP_DIR.next" "$APP_DIR"
rm -rf "$APP_DIR.previous"

cat > "$BIN_DIR/autovault" <<EOF
#!/bin/sh
: "\${AUTOVAULT_STORAGE_PATH:=$STORAGE_PATH}"
: "\${AUTOVAULT_DB_PATH:=\$AUTOVAULT_STORAGE_PATH/autovault.sqlite}"
export AUTOVAULT_STORAGE_PATH AUTOVAULT_DB_PATH
exec node "$APP_DIR/dist/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/autovault"
write_env_file
completed "$BIN_DIR/autovault"

# ---------------------------------------------------------------------------
# Shell PATH wiring
# ---------------------------------------------------------------------------

plain ""
if path_contains_bin; then
  completed "autovault is already on your PATH"
elif profile_updated="$(ensure_profile_sources_env)"; then
  completed "Wired into $profile_updated"
  plain "  ${GREY}use it in this terminal:${RESET} . \"$ENV_FILE\""
  plain "  ${GREY}new terminals pick it up automatically${RESET}"
else
  warn "Could not update your shell profile automatically."
  plain "  ${GREY}use it in this terminal:${RESET} . \"$ENV_FILE\""
  plain "  ${GREY}or add this to your profile:${RESET} [ -f \"$ENV_FILE\" ] && . \"$ENV_FILE\""
fi

# ---------------------------------------------------------------------------
# Hand off to the interactive setup wizard (or defer for non-TTY installs)
# ---------------------------------------------------------------------------

if [ "${AUTOVAULT_NO_SETUP:-0}" = "1" ]; then
  plain ""
  warn "Setup wizard skipped (AUTOVAULT_NO_SETUP=1)."
  plain "${BOLD}> Run this when ready to migrate native skills:${RESET}"
  plain "    autovault setup"
  print_celebration
  exit 0
fi

if [ -t 0 ] || (: </dev/tty) 2>/dev/null; then
  plain ""
  info "Launching the setup wizard…"
  plain ""
  setup_status=0
  if [ -t 0 ]; then
    "$BIN_DIR/autovault" setup || setup_status=$?
  else
    # curl|sh case — stdin is the script; reattach the terminal for the wizard.
    exec </dev/tty
    "$BIN_DIR/autovault" setup || setup_status=$?
  fi
  if [ "$setup_status" -eq 0 ]; then
    print_celebration
  else
    warn "Setup wizard exited with status $setup_status."
    plain "${BOLD}> AutoVault installed; rerun setup when ready:${RESET}"
    plain "    autovault setup"
  fi
  exit 0
fi

plain ""
warn "Non-interactive shell detected. Skipping setup wizard."
plain "${BOLD}> Run this when ready to migrate native skills:${RESET}"
plain "    autovault setup"
print_celebration
