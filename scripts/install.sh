#!/bin/sh
set -eu

REPO="autoworks-ai/autovault"
REF="${AUTOVAULT_REF:-main}"
HOME_DIR="${AUTOVAULT_HOME:-$HOME/.autovault}"
APP_DIR="$HOME_DIR/app"
BIN_DIR="${AUTOVAULT_BIN_DIR:-$HOME_DIR/bin}"
STORAGE_PATH="${AUTOVAULT_STORAGE_PATH:-$HOME_DIR}"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'autovault install failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

need curl
need tar
need node
need npm

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js >= 20 is required; found $(node --version)"

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

log "Installing AutoVault from $REPO@$REF"
log "  app:     $APP_DIR"
log "  storage: $STORAGE_PATH"
log "  bin:     $BIN_DIR/autovault"

curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/autovault.tgz"
mkdir -p "$TMP_DIR/src"
tar -xzf "$TMP_DIR/autovault.tgz" -C "$TMP_DIR/src" --strip-components=1

[ -f "$TMP_DIR/src/package.json" ] || fail "downloaded archive does not look like AutoVault"

cd "$TMP_DIR/src"
npm ci
npm run build

if [ "${AUTOVAULT_NO_BOOTSTRAP:-0}" != "1" ]; then
  AUTOVAULT_STORAGE_PATH="$STORAGE_PATH" node scripts/bootstrap-skills.mjs
fi

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

log ""
log "AutoVault installed."
log "Add this to your PATH if it is not already present:"
log "  export PATH=\"$BIN_DIR:\$PATH\""
log ""
log "Try:"
log "  autovault skill list"
