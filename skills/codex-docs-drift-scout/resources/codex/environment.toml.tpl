# THIS IS AUTOVAULT-MANAGED RENDERED STATE. DO NOT EDIT THE RENDERED FILE.
# Source template: codex-docs-drift-scout/resources/codex/environment.toml.tpl
version = 1
name = "autohub"

[setup]
script = '''
set -euo pipefail
cd "$CODEX_WORKTREE_PATH"

npm_config_prefer_offline=true \
npm_config_audit=false \
npm_config_fund=false \
bash scripts/with-node-version.sh node scripts/setup-worktree.js
'''

# Cleanup is intentionally scoped to the disposable Codex worktree.
[cleanup]
script = '''
cd "$CODEX_WORKTREE_PATH"
bash scripts/reset-all.sh || true
'''
