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
  MINT="$(printf '\033[38;2;90;214;192m')"
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
  MINT=""
  RESET=""
fi

STAGE_COUNTER_WIDTH=9
STAGE_LABEL_WIDTH=7
DETAIL_INDENT=14
STEP_CURRENT=0
STEP_TOTAL=6
NEEDS_ENV_COMMAND=0
RUN_LOG_COUNT=0

detail_line() {
  printf '%*s%s\n' "$DETAIL_INDENT" "" "$*"
}

info()      { detail_line "${BOLD}${GREY}>${RESET} $*"; }
warn()      { detail_line "${YELLOW}!${RESET} $*"; }
error()     { printf '%s\n' "${RED}x $*${RESET}" >&2; }
completed() { detail_line "${GREEN}✓${RESET} $*"; }
plain()     { printf '%s\n' "$*"; }

step() {
  STEP_CURRENT=$((STEP_CURRENT + 1))
  counter="stage $STEP_CURRENT/$STEP_TOTAL"
  printf '   %s%*s%s  %s%-*s%s  %s%s%s\n' \
    "$GREY" "$STAGE_COUNTER_WIDTH" "$counter" "$RESET" \
    "$MINT" "$STAGE_LABEL_WIDTH" "$1" "$RESET" \
    "$BOLD" "$2" "$RESET"
}

warning_card() {
  title="$1"
  shift
  bar="${GREY}│${RESET}"
  printf '\n   %s[ shell ]%s  %s  %s%s%s\n' "$YELLOW" "$RESET" "$bar" "$YELLOW" "$title" "$RESET"
  while [ "$#" -gt 0 ]; do
    printf '%*s%s  %s\n' "$DETAIL_INDENT" "" "$bar" "$1"
    shift
  done
  printf '\n'
}

fail() {
  error "$*"
  exit 1
}

run_quiet() {
  label="$1"
  shift
  RUN_LOG_COUNT=$((RUN_LOG_COUNT + 1))
  log_file="$TMP_DIR/step-$RUN_LOG_COUNT.log"

  if [ -t 1 ]; then
    "$@" >"$log_file" 2>&1 &
    cmd_pid=$!
    frame=0
    while kill -0 "$cmd_pid" 2>/dev/null; do
      case "$frame" in
        0) glyph="⠋" ;;
        1) glyph="⠙" ;;
        2) glyph="⠹" ;;
        3) glyph="⠸" ;;
        4) glyph="⠼" ;;
        5) glyph="⠴" ;;
        6) glyph="⠦" ;;
        7) glyph="⠧" ;;
        8) glyph="⠇" ;;
        *) glyph="⠏" ;;
      esac
      printf '\r%*s%s %s' "$DETAIL_INDENT" "" "${MINT}${glyph}${RESET}" "$label"
      frame=$(( (frame + 1) % 10 ))
      sleep 0.08
    done
    if wait "$cmd_pid"; then
      status=0
    else
      status=$?
    fi
    printf '\r%80s\r' " "
  else
    if "$@" >"$log_file" 2>&1; then
      status=0
    else
      status=$?
    fi
  fi

  if [ "$status" -ne 0 ]; then
    error "$label failed"
    if [ -s "$log_file" ]; then
      warn "Last log lines:"
      tail -40 "$log_file" >&2 || true
    fi
    return "$status"
  elif [ "${AUTOVAULT_VERBOSE:-0}" = "1" ] && [ -s "$log_file" ]; then
    info "$label log tail"
    tail -20 "$log_file" | sed 's/^/  /' || true
  fi
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

node_meets_minimum() {
  [ "$NODE_MAJOR" -ge 24 ]
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
  if [ "${AUTOVAULT_ASCII:-0}" = "1" ]; then
    printf '%s\n' "${MINT}   .----. ${RESET}  ${BOLD}AutoVault${RESET}"
    printf '%s\n' "${MINT}   |  | | ${RESET}  ${GREY}validate -> sign -> vault${RESET}"
    printf '%s\n' "${MINT}   | O  | ${RESET}  ${GREY}curated skill vault for Claude Code, Codex, and Cursor${RESET}"
    printf '%s\n' "${MINT}   '+--+' ${RESET}"
    printf '%s\n' "${MINT}    |  |  ${RESET}"
  else
    printf '%s\n' "${MINT}   ╓─────╖ ${RESET}  ${BOLD}AutoVault${RESET}"
    printf '%s\n' "${MINT}   ║  ╷  ║ ${RESET}  ${GREY}validate → sign → vault${RESET}"
    printf '%s\n' "${MINT}   ║ ⊙   ║ ${RESET}  ${GREY}curated skill vault for Claude Code, Codex, and Cursor${RESET}"
    printf '%s\n' "${MINT}   ╙┬───┬╜ ${RESET}"
    printf '%s\n' "${MINT}    ╵   ╵  ${RESET}"
  fi
  printf '\n'
}

print_celebration() {
  skill_count=0
  if [ -d "$STORAGE_PATH/skills" ]; then
    for skill_dir in "$STORAGE_PATH"/skills/*; do
      [ -d "$skill_dir" ] || continue
      skill_count=$((skill_count + 1))
    done
  fi

  profile_roots=""
  if [ -d "$HOME/.claude/skills" ]; then
    profile_roots="${profile_roots}claude-code "
  fi
  if [ -d "$HOME/.codex/skills" ]; then
    profile_roots="${profile_roots}codex "
  fi
  if [ -d "$HOME/.cursor/skills" ]; then
    profile_roots="${profile_roots}cursor "
  fi
  if [ -z "$profile_roots" ]; then
    profile_roots="none detected"
  fi

  printf '\n'
  printf '%s\n' "${MINT}────────────────────────────────────────${RESET}"
  printf '%s\n' "${GREEN}✓${RESET} ${BOLD}AutoVault is ready.${RESET}"
  if [ "${AUTOVAULT_VERBOSE:-0}" = "1" ]; then
    printf '%s\n' "  ${GREY}storage ${RESET} $STORAGE_PATH"
    printf '%s\n' "  ${GREY}shim    ${RESET} $BIN_DIR/autovault"
    printf '%s\n' "  ${GREY}skills  ${RESET} $skill_count vaulted"
    printf '%s\n' "  ${GREY}profiles${RESET} $profile_roots"
  else
    printf '%s\n' "  ${GREY}skills${RESET} $skill_count vaulted"
  fi
  if [ "$NEEDS_ENV_COMMAND" = "1" ]; then
    printf '%s\n' "  ${GREY}next   ${RESET} . \"$ENV_FILE\""
  fi
  printf '%s\n' "  ${GREY}next${RESET} autovault doctor"
  printf '%s\n' "${MINT}────────────────────────────────────────${RESET}"
  printf '\n'
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

print_banner

step "detect" "checking prerequisites and platform"
need curl
need tar
need node
need npm

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"
NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//' || printf 'unknown')"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"
NODE_MINOR="$(node -p "process.versions.node.split('.')[1]" 2>/dev/null || printf '0')"
NODE_PATCH="$(node -p "process.versions.node.split('.')[2]" 2>/dev/null || printf '0')"

completed "$PLATFORM $ARCH / Node $NODE_VERSION"

node_meets_minimum || fail "Node.js >= 24.0.0 is required; found $(node --version 2>/dev/null || printf 'unknown')"

if [ "${AUTOVAULT_VERBOSE:-0}" = "1" ]; then
  plain "${BOLD}Install plan${RESET}"
  plain "  ${GREY}repo     ${RESET} $REPO@$REF"
  plain "  ${GREY}app      ${RESET} $APP_DIR"
  plain "  ${GREY}storage  ${RESET} $STORAGE_PATH"
  plain "  ${GREY}shim     ${RESET} $BIN_DIR/autovault"
  plain ""
fi

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
step "fetch" "downloading AutoVault source"
curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/autovault.tgz"
mkdir -p "$TMP_DIR/src"
tar -xzf "$TMP_DIR/autovault.tgz" -C "$TMP_DIR/src" --strip-components=1
[ -f "$TMP_DIR/src/package.json" ] || fail "downloaded archive does not look like AutoVault"
completed "Fetched $REF"

cd "$TMP_DIR/src"

step "build" "installing dependencies and compiling"
run_quiet "Installing dependencies..." npm ci --silent
completed "npm ci done"

run_quiet "Building AutoVault..." npm run build --silent
completed "Built dist/"

# ---------------------------------------------------------------------------
# Bootstrap bundled skills (validation gate runs here)
# ---------------------------------------------------------------------------

if [ "${AUTOVAULT_NO_BOOTSTRAP:-0}" != "1" ]; then
  step "seed" "validating and installing bundled skills"
  run_quiet "Seeding bundled skills..." env AUTOVAULT_LOG_LEVEL=error AUTOVAULT_STORAGE_PATH="$STORAGE_PATH" node scripts/bootstrap-skills.mjs
  completed "Bundled skills bootstrapped"
else
  step "seed" "skipped by AUTOVAULT_NO_BOOTSTRAP=1"
fi

# ---------------------------------------------------------------------------
# Atomic swap into $APP_DIR + write shim
# ---------------------------------------------------------------------------

step "path" "installing the autovault shim"
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
if [ "${AUTOVAULT_VERBOSE:-0}" = "1" ]; then
  completed "$BIN_DIR/autovault"
else
  completed "autovault shim installed"
fi

# ---------------------------------------------------------------------------
# Shell PATH wiring
# ---------------------------------------------------------------------------

plain ""
if path_contains_bin; then
  completed "autovault is already on your PATH"
elif profile_updated="$(ensure_profile_sources_env)"; then
  NEEDS_ENV_COMMAND=1
  if [ "${AUTOVAULT_VERBOSE:-0}" = "1" ]; then
    completed "Wired into $profile_updated"
  else
    completed "shell profile updated"
  fi
  detail_line "${GREY}use it in this terminal:${RESET} . \"$ENV_FILE\""
  detail_line "${GREY}new terminals pick it up automatically${RESET}"
else
  NEEDS_ENV_COMMAND=1
  warning_card \
    "Could not update your shell profile automatically." \
    "Run this once in this session:" \
    "  . \"$ENV_FILE\"" \
    "${GREY}Rerun with AUTOVAULT_VERBOSE=1 for the profile line.${RESET}"
  if [ "${AUTOVAULT_VERBOSE:-0}" = "1" ]; then
    detail_line "${GREY}or add this to your profile:${RESET} [ -f \"$ENV_FILE\" ] && . \"$ENV_FILE\""
  fi
fi

# ---------------------------------------------------------------------------
# Hand off to the interactive setup wizard (or defer for non-TTY installs)
# ---------------------------------------------------------------------------

if [ "${AUTOVAULT_NO_SETUP:-0}" = "1" ]; then
  plain ""
  step "setup" "skipped by AUTOVAULT_NO_SETUP=1"
  warn "Setup wizard skipped (AUTOVAULT_NO_SETUP=1)."
  plain "${BOLD}> Run this when ready to migrate native skills:${RESET}"
  plain "    autovault setup"
  print_celebration
  exit 0
fi

if [ -t 0 ] || (: </dev/tty) 2>/dev/null; then
  plain ""
  step "setup" "launching guided vault intake"
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
step "setup" "deferred for non-interactive shell"
warn "Non-interactive shell detected. Skipping setup wizard."
plain "${BOLD}> Run this when ready to migrate native skills:${RESET}"
plain "    autovault setup"
print_celebration
