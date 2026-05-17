#!/bin/sh
set -eu

REPO="autoworks-ai/autovault"
INSTALLER_URL="https://autovault.sh"
RELEASES_URL="https://github.com/$REPO/releases"
REF="${AUTOVAULT_REF:-}"
HOME_DIR="${AUTOVAULT_HOME:-$HOME/.autovault}"
APP_DIR="$HOME_DIR/app"
BIN_DIR="${AUTOVAULT_BIN_DIR:-$HOME_DIR/bin}"
STORAGE_PATH="${AUTOVAULT_STORAGE_PATH:-$HOME_DIR}"
ENV_FILE="$HOME_DIR/env"
DRY_RUN="${AUTOVAULT_DRY_RUN:-0}"
NOTES="${AUTOVAULT_NOTES:-0}"
QUIET="${AUTOVAULT_QUIET:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --yes|-y)
      AUTOVAULT_YES=1
      export AUTOVAULT_YES
      ;;
    --quiet|-q)
      QUIET=1
      AUTOVAULT_QUIET=1
      export AUTOVAULT_QUIET
      ;;
    --verbose)
      AUTOVAULT_VERBOSE=1
      export AUTOVAULT_VERBOSE
      ;;
    --notes)
      NOTES=1
      AUTOVAULT_NOTES=1
      export AUTOVAULT_NOTES
      ;;
    --help|-h)
      printf '%s\n' "Usage: install.sh [--dry-run] [--yes] [--quiet] [--verbose] [--notes]"
      printf '%s\n' "Environment: AUTOVAULT_REF=v0.3.0|main AUTOVAULT_HOME=... AUTOVAULT_BIN_DIR=..."
      exit 0
      ;;
    *)
      printf '%s\n' "Unknown installer flag: $1" >&2
      exit 2
      ;;
  esac
  shift
done

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
  [ "$QUIET" = "1" ] && return 0
  printf '%*s%s\n' "$DETAIL_INDENT" "" "$*"
}

info()      { detail_line "${BOLD}${GREY}>${RESET} $*"; }
warn()      { detail_line "${YELLOW}!${RESET} $*"; }
error()     { printf '%s\n' "${RED}x $*${RESET}" >&2; }
completed() { detail_line "${GREEN}✓${RESET} $*"; }
plain()     { [ "$QUIET" = "1" ] && return 0; printf '%s\n' "$*"; }

step() {
  [ "$QUIET" = "1" ] && return 0
  STEP_CURRENT=$((STEP_CURRENT + 1))
  counter="stage $STEP_CURRENT/$STEP_TOTAL"
  printf '   %s%*s%s  %s%-*s%s  %s%s%s\n' \
    "$GREY" "$STAGE_COUNTER_WIDTH" "$counter" "$RESET" \
    "$MINT" "$STAGE_LABEL_WIDTH" "$1" "$RESET" \
    "$BOLD" "$2" "$RESET"
}

warning_card() {
  [ "$QUIET" = "1" ] && return 0
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
  elif [ "${AUTOVAULT_VERBOSE:-0}" = "1" ] && [ "${AUTOVAULT_SUPPRESS_SUCCESS_LOG:-0}" != "1" ] && [ -s "$log_file" ]; then
    info "$label log tail"
    tail -20 "$log_file" | sed 's/^/  /' || true
  fi
}

run_quiet_no_success_log() {
  old_suppress="${AUTOVAULT_SUPPRESS_SUCCESS_LOG:-}"
  AUTOVAULT_SUPPRESS_SUCCESS_LOG=1
  run_quiet "$@"
  status=$?
  if [ -n "$old_suppress" ]; then
    AUTOVAULT_SUPPRESS_SUCCESS_LOG="$old_suppress"
  else
    unset AUTOVAULT_SUPPRESS_SUCCESS_LOG
  fi
  return "$status"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

is_headless() {
  # Headless when running inside a known agent/CI environment
  [ -n "${CI-}" ] || [ -n "${CLAUDE_CODE-}" ] || [ -n "${CODEX-}" ] || \
  [ -n "${GITHUB_ACTIONS-}" ] || [ -n "${CIRCLECI-}" ] || \
  [ -n "${TRAVIS-}" ] || [ -n "${BUILDKITE-}" ]
}

confirm() {
  if [ -n "${AUTOVAULT_YES-}" ]; then
    return 0
  fi
  # Auto-confirm in known headless/agent/CI environments
  if is_headless; then
    info "Headless environment detected — auto-confirming install"
    return 0
  fi
  if [ -t 0 ]; then
    printf '%s' "${MAGENTA}?${RESET} $* ${BOLD}[y/N]${RESET} "
    read -r yn || yn=""
  elif (: </dev/tty) 2>/dev/null; then
    printf '%s' "${MAGENTA}?${RESET} $* ${BOLD}[y/N]${RESET} "
    read -r yn </dev/tty 2>/dev/null || yn=""
  else
    printf '\n' >&2
    printf '%s\n' "  No TTY detected. Re-run with:" >&2
    printf '%s\n' "    curl -fsSL $INSTALLER_URL | AUTOVAULT_YES=1 sh" >&2
    printf '\n' >&2
    exit 1
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

read_package_version() {
  package_json="$1"
  [ -f "$package_json" ] || {
    printf '%s\n' "none"
    return 0
  }
  node -e 'try { const fs = require("fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(p.version || "unknown")); } catch { process.stdout.write("unknown"); }' "$package_json" 2>/dev/null || printf '%s' "unknown"
  printf '\n'
}

resolve_latest_ref() {
  if [ -n "${AUTOVAULT_LATEST_VERSION:-}" ]; then
    case "$AUTOVAULT_LATEST_VERSION" in
      v*) printf '%s\n' "$AUTOVAULT_LATEST_VERSION" ;;
      *) printf 'v%s\n' "$AUTOVAULT_LATEST_VERSION" ;;
    esac
    return 0
  fi
  latest="$(npm view @autoworks-ai/autovault version --silent 2>/dev/null || true)"
  if [ -n "$latest" ]; then
    printf 'v%s\n' "$latest"
  else
    printf '%s\n' "main"
  fi
}

version_from_ref() {
  case "$1" in
    v[0-9]*)
      printf '%s\n' "${1#v}"
      ;;
    [0-9]*)
      printf '%s\n' "$1"
      ;;
    *)
      printf '%s\n' "unknown"
      ;;
  esac
}

compare_versions() {
  current="$1"
  target="$2"
  node -e '
const a = process.argv[1];
const b = process.argv[2];
if (!/^\d+\.\d+\.\d+/.test(a) || !/^\d+\.\d+\.\d+/.test(b)) {
  process.stdout.write("unknown");
  process.exit(0);
}
const pa = a.split(".").map((v) => Number.parseInt(v, 10));
const pb = b.split(".").map((v) => Number.parseInt(v, 10));
for (let i = 0; i < 3; i += 1) {
  if (pa[i] < pb[i]) { process.stdout.write("-1"); process.exit(0); }
  if (pa[i] > pb[i]) { process.stdout.write("1"); process.exit(0); }
}
process.stdout.write("0");
' "$current" "$target" 2>/dev/null || printf '%s' "unknown"
  printf '\n'
}

detect_install_state() {
  current="$1"
  target="$2"
  ref="$3"
  if [ "$current" = "none" ]; then
    if [ -d "$STORAGE_PATH/skills" ]; then
      printf '%s\n' "repair/adopt existing storage"
    else
      printf '%s\n' "fresh install"
    fi
    return 0
  fi
  if [ "$current" = "unknown" ]; then
    printf '%s\n' "repair/adopt existing app"
    return 0
  fi
  case "$ref" in
    v[0-9]*|[0-9]*)
      cmp="$(compare_versions "$current" "$target")"
      case "$cmp" in
        -1) printf '%s\n' "upgrade" ;;
        0) printf '%s\n' "reinstall" ;;
        1) printf '%s\n' "downgrade" ;;
        *) printf '%s\n' "reinstall" ;;
      esac
      ;;
    *)
      printf '%s\n' "replace from branch"
      ;;
  esac
}

format_target_label() {
  ref="$1"
  target_version="$2"
  case "$ref" in
    v[0-9]*|[0-9]*)
      case "$ref" in
        v*) printf '%s\n' "$ref" ;;
        *) printf 'v%s\n' "$ref" ;;
      esac
      ;;
    *)
      if [ "$target_version" = "unknown" ]; then
        printf '%s\n' "$ref (unreleased branch)"
      else
        printf '%s\n' "$ref (unreleased, package $target_version)"
      fi
      ;;
  esac
}

print_install_plan() {
  plain ""
  plain "${BOLD}Install plan${RESET}"
  detail_line "${GREY}platform${RESET} $PLATFORM $ARCH"
  detail_line "${GREY}node    ${RESET} $NODE_VERSION"
  detail_line "${GREY}app     ${RESET} $APP_DIR"
  detail_line "${GREY}storage ${RESET} $STORAGE_PATH"
  detail_line "${GREY}state   ${RESET} $INSTALL_STATE"
  detail_line "${GREY}current ${RESET} $INSTALLED_VERSION"
  detail_line "${GREY}target  ${RESET} $TARGET_LABEL"
  detail_line "${GREY}notes   ${RESET} $RELEASE_NOTES_URL"
  if [ "${AUTOVAULT_VERBOSE:-0}" = "1" ]; then
    detail_line "${GREY}repo    ${RESET} $REPO@$REF"
    detail_line "${GREY}shim    ${RESET} $BIN_DIR/autovault"
  fi
  plain ""
}

print_changelog_notes() {
  version="$1"
  [ "$NOTES" = "1" ] || return 0
  [ -f "CHANGELOG.md" ] || {
    detail_line "${GREY}release notes:${RESET} $RELEASE_NOTES_URL"
    return 0
  }
  plain ""
  awk -v ver="$version" '
    BEGIN { found = 0 }
    $0 ~ "^## \\[?v?" ver "\\]?" {
      found = 1
    }
    found && /^## / && $0 !~ "^## \\[?v?" ver "\\]?" {
      exit
    }
    found { print }
  ' CHANGELOG.md
  plain ""
}

node_meets_minimum() {
  [ "$NODE_MAJOR" -ge 22 ]
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
  [ "$QUIET" = "1" ] && return 0
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
  [ "$QUIET" = "1" ] && return 0
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
  printf '%s\n' "  ${GREY}next${RESET} autovault --version"
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

completed "$PLATFORM $ARCH / Node $NODE_VERSION"

if ! node_meets_minimum; then
  found_ver="$(node --version 2>/dev/null || printf 'unknown')"
  error "Node.js >= 22.0.0 is required; found $found_ver"
  printf '\n' >&2
  printf '%s\n' "  Upgrade options:" >&2
  printf '%s\n' "    nvm:   nvm install 22 && nvm use 22" >&2
  printf '%s\n' "    fnm:   fnm install 22 && fnm use 22" >&2
  printf '%s\n' "    brew:  brew install node@22" >&2
  printf '\n' >&2
  printf '%s\n' "  Then re-run:" >&2
  printf '%s\n' "    curl -fsSL $INSTALLER_URL | sh" >&2
  printf '\n' >&2
  exit 1
fi

if [ -z "$REF" ]; then
  REF="$(resolve_latest_ref)"
fi

INSTALLED_VERSION="$(read_package_version "$APP_DIR/package.json")"
TARGET_VERSION="$(version_from_ref "$REF")"
TARGET_LABEL="$(format_target_label "$REF" "$TARGET_VERSION")"
case "$REF" in
  v[0-9]*|[0-9]*)
    release_ref="$REF"
    case "$release_ref" in
      v*) ;;
      *) release_ref="v$release_ref" ;;
    esac
    RELEASE_NOTES_URL="$RELEASES_URL/tag/$release_ref"
    ;;
  *)
    RELEASE_NOTES_URL="$RELEASES_URL/latest"
    ;;
esac
INSTALL_STATE="$(detect_install_state "$INSTALLED_VERSION" "$TARGET_VERSION" "$REF")"

print_install_plan

if [ "$DRY_RUN" = "1" ]; then
  plain "Dry run only; no changes made."
  exit 0
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
FETCHED_PACKAGE_VERSION="$(read_package_version "$TMP_DIR/src/package.json")"
FETCHED_TARGET_LABEL="$(format_target_label "$REF" "$FETCHED_PACKAGE_VERSION")"
completed "Fetched $FETCHED_TARGET_LABEL"

cd "$TMP_DIR/src"
case "$REF" in
  v[0-9]*|[0-9]*)
    print_changelog_notes "$FETCHED_PACKAGE_VERSION"
    ;;
  *)
    print_changelog_notes "Unreleased"
    ;;
esac

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
  run_quiet_no_success_log "Seeding bundled skills..." env AUTOVAULT_LOG_LEVEL=error AUTOVAULT_STORAGE_PATH="$STORAGE_PATH" node scripts/bootstrap-skills.mjs
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
warn "Non-interactive shell detected — setup wizard skipped."
plain "  To complete setup, run:"
plain "    ${BOLD}autovault setup${RESET}"
print_celebration
