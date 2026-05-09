# Installing AutoVault

This guide walks through setting up AutoVault as a local capability library,
stdio MCP server, or remote Streamable HTTP MCP service for Claude Code,
Cursor, Codex, AutoHub, Railway, Docker, or any other MCP-compatible host.

## Prerequisites

- Node.js **>= 20.19.0** (use `node --version` to confirm)
- `curl`, `tar`, and `npm`
- An MCP-compatible host (Claude Code, Cursor, Codex, etc.)
- Git, if you choose the manual clone path

## Quick install

```bash
curl -fsSL https://autovault.sh | sh
```

The installer downloads the AutoVault source release, builds the Node app under
`~/.autovault/app`, preserves the rest of `~/.autovault/` as vault storage, and
creates a shim at `~/.autovault/bin/autovault`.

Useful installer overrides:

```bash
AUTOVAULT_HOME=~/.local/share/autovault curl -fsSL https://autovault.sh | sh
AUTOVAULT_BIN_DIR=~/bin curl -fsSL https://autovault.sh | sh
AUTOVAULT_NO_BOOTSTRAP=1 curl -fsSL https://autovault.sh | sh
AUTOVAULT_REF=v0.3.0 curl -fsSL https://autovault.sh | sh
```

If `~/.autovault/bin` is not already on your `PATH`, add it:

```bash
export PATH="$HOME/.autovault/bin:$PATH"
```

Check vault health at any time:

```bash
autovault doctor
autovault doctor --clean   # remove ignored OS/editor metadata only
```

## 1. Clone and build

```bash
git clone https://github.com/autoworks-ai/autovault.git
cd autovault
npm ci
npm run build
```

`npm run build` compiles TypeScript into `dist/`. The library entry point is
`dist/library.js`; the local stdio MCP entry point is `dist/index.js`; the
remote HTTP MCP entry point is `dist/remote.js`.

## 2. Choose a storage path (optional)

By default, AutoVault stores installed skills in `~/.autovault/` and capability
metadata in `~/.autovault/autovault.sqlite`. Override with
`AUTOVAULT_STORAGE_PATH` or `AUTOVAULT_DB_PATH` if you prefer a different
location.

```bash
export AUTOVAULT_STORAGE_PATH=~/.autovault   # default
export AUTOVAULT_DB_PATH=~/.autovault/autovault.sqlite
export AUTOVAULT_PROFILE_LINKS="codex=~/.codex/skills,claude-code=~/.claude/skills"
```

See [`README.md`](README.md#configuration) for the full list of environment
variables.

## 3. Seed the skill library

AutoVault ships two bundled meta-skills in `skills/` (`autovault-skill` and
`skill-author`). Seed every `skills/*/SKILL.md` bundle into your storage path
and refresh host-visible profiles:

```bash
npm run build            # if you haven't already
node scripts/bootstrap-skills.mjs
```

Expected output (abbreviated):

```text
Bootstrapping 2 skill(s) into /Users/you/.autovault and syncing profiles
--- installing autovault-skill ---
{ "success": true, "name": "autovault-skill", ... }
--- installing skill-author ---
{ "success": true, "name": "skill-author", ... }
--- get_skill query ---
{ "matches": [ ... ], "skill": { ... } }
```

Each install runs the full validation gate (schema, security denylist,
capability cross-check). Bootstrap also passes profile sync with native root
discovery enabled, so existing `~/.claude/skills`, `~/.codex/skills`, and
`~/.cursor/skills` roots are refreshed automatically. If any skill is rejected,
the gate will explain why.

## 4. Generate per-agent skill profiles

Installed skills stay in `$AUTOVAULT_STORAGE_PATH/skills/<name>/SKILL.md`.
Profile sync reads each skill's `agents` frontmatter and creates symlinks under
`$AUTOVAULT_STORAGE_PATH/profiles/<agent>/`. If a vault-local transform matches
that agent, sync first materializes a disposable generated variant under
`$AUTOVAULT_STORAGE_PATH/rendered/<agent>/<name>/` and links the profile to
that rendered directory.

```bash
npm run sync:profiles
```

To expose those generated profiles inside an existing host skill root without
replacing the whole directory, pass managed external roots:

```bash
node dist/cli.js sync-profiles \
  --link claude-code="$HOME/.claude/skills" \
  --link codex="$HOME/.codex/skills"
```

This creates or updates managed links inside those roots and leaves unrelated
system or manually installed skills intact.
Set `AUTOVAULT_PROFILE_LINKS` to make `add_skill`, `update_skill`,
`propose_skill`, `delete_skill`, and plain `sync-profiles` refresh those roots
automatically.

AutoVault can also discover existing native roots:

```bash
autovault sync-profiles --discover
```

Discovery only reports roots that already exist. If a host has not created its
skill directory yet, create it or pass an explicit link:

```bash
mkdir -p "$HOME/.codex/skills"
autovault sync-profiles --link codex="$HOME/.codex/skills"
```

Audit an AutoHub-style repository before migrating local scripts into vault
skills:

```bash
autovault audit-repo --repo /path/to/autohub --format markdown
```

Discovery currently checks:

- `~/.claude/skills` as `claude-code`
- `~/.codex/skills` as `codex`
- `~/.cursor/skills` as `cursor`

## 4b. Add a local skill bundle

Third-party installers should use `add-local` when they already have a local
skill directory on disk:

```bash
autovault add-local ./path/to/your-skill --source vendor/skills --sync-profiles
```

The command requires `SKILL.md`, walks sibling resources in deterministic
order, skips AutoVault metadata files, refuses symlinks, runs the same
validation/signing pipeline as other install paths, and records honest
`source: "local"` provenance. Local installs are reported as unchecked by
`check_updates`; rerun the vendor installer to refresh them.

Machine-readable output:

```bash
autovault add-local ./path/to/your-skill --source vendor/skills --sync-profiles --json
```

Vendor drop-in pattern:

```sh
. ./scripts/vendor-autovault-install.sh

install_native() {
  # vendor's existing copied-directory install
  :
}

autovault_install_skill_bundle "$source_dir" "$REPO" install_native
```

`AUTOVAULT_SKILL_INSTALL` controls routing:

| Mode | Behavior |
|------|----------|
| unset, `prefer`, `prefer-autovault` | AutoVault first, native fallback. |
| `both` | AutoVault and native. |
| `native` | Native first, AutoVault fallback. |
| `native-only` | Native only. |
| `off` | Skip skill installation. |

## 5. Configure your MCP host

AutoVault's primary interface is the library package. The compatibility MCP
server remains available for MCP-native hosts; point the host at
`node dist/index.js`.

### Claude Code

Add to your project's `.mcp.json` (or `~/.claude/mcp.json` for global):

```json
{
  "mcpServers": {
    "autovault": {
      "command": "node",
      "args": ["/absolute/path/to/autovault/dist/index.js"],
      "env": {
        "AUTOVAULT_STORAGE_PATH": "/Users/you/.autovault",
        "AUTOVAULT_PROFILE_LINKS": "claude-code=/Users/you/.claude/skills"
      }
    }
  }
}
```

Reload Claude Code. The `get_skill`, `add_skill`, `update_skill`,
`delete_skill`, `propose_skill`, and `check_updates` tools should all appear.

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "autovault": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["${workspaceFolder}/dist/index.js"]
    }
  }
}
```

Reload Cursor and verify under **Tools & MCP**.

### Codex CLI

Codex uses `~/.codex/config.toml`. Add a server entry:

```toml
[mcp_servers.autovault]
command = "node"
args = ["/absolute/path/to/autovault/dist/index.js"]
env = { AUTOVAULT_STORAGE_PATH = "/Users/you/.autovault", AUTOVAULT_PROFILE_LINKS = "codex=/Users/you/.codex/skills" }
```

Check Codex docs for your specific version; the stanza shape may vary.

## 5b. Deploy remote MCP (Docker or Railway)

Remote mode is the shortest path for a team/shared vault or a managed service.
It exposes MCP at `/mcp`, OAuth discovery at
`/.well-known/oauth-authorization-server`, and protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp`.

Local Docker:

```bash
export AUTOVAULT_ADMIN_EMAIL=admin@example.com
export AUTOVAULT_ADMIN_PASSWORD=replace-with-a-long-random-password
docker compose up --build
```

Then connect remote MCP clients to:

```text
http://localhost:3000/mcp
```

Railway:

1. Create a Railway service from this repository.
2. Add a persistent volume mounted at `/data/autovault`.
3. Set these service variables:

```bash
AUTOVAULT_MODE=remote
AUTOVAULT_STORAGE_PATH=/data/autovault
AUTOVAULT_PUBLIC_URL=https://<service>.up.railway.app
AUTOVAULT_ADMIN_EMAIL=admin@example.com
AUTOVAULT_ADMIN_PASSWORD=replace-with-a-long-random-password
AUTOVAULT_SECURITY_STRICT=true
```

Railway sets `PORT`; AutoVault binds to `0.0.0.0:$PORT`. If your deployment
does not provide `PORT`, set `AUTOVAULT_HTTP_PORT=3000`.

Remote MCP URL:

```text
https://<service>.up.railway.app/mcp
```

First boot seeds an owner account from `AUTOVAULT_ADMIN_EMAIL` and
`AUTOVAULT_ADMIN_PASSWORD`. OAuth dynamic client registration is enabled; the
client will register, send you through `/login`, exchange an authorization code
with PKCE, and then call `/mcp` with a bearer token.

Remote mode intentionally does not run `sync-profiles` against client machines.
The server cannot create symlinks in a user's `~/.codex/skills`,
`~/.claude/skills`, or Cursor skill roots over remote MCP. Use direct MCP reads
through `get_skill` for remote clients. If filesystem-native host skills are
required later, add a local mirror helper that pulls the permitted remote skills
into the local profile roots.

## 6. Verify

From your MCP host, run:

```
get_skill({ "query": "skill", "top_k": 10 })
```

You should see the two seeded skills. Then try:

```
get_skill({ "query": "what is autovault" })
get_skill({ "name": "autovault-skill" })
get_skill({ "query": "author a new skill" })
get_skill({ "name": "skill-author" })
```

## 6a. Make the agent reach for the vault (recommended)

By default, the agent only consults AutoVault when you name it
("use autovault to..."). To make the agent check the vault reflexively for
every task, add the following instruction to your project's `AGENTS.md`,
`CLAUDE.md`, or the equivalent for your host:

```markdown
## Skill Discovery

Before performing any task the user asks for, call
`mcp__autovault__get_skill` with a short query describing the task. If a skill
matches, follow the returned SKILL.md instead of improvising from scratch. Only
skip this step if the user has explicitly said not to use AutoVault.
```

For a user-wide default (all projects), put the same block in
`~/.claude/CLAUDE.md` (Claude Code), `~/.codex/AGENTS.md` (Codex), or your
host's global agent instructions.

Without this instruction, AutoVault still works — you just have to ask
for it explicitly.

## AutoHub library integration

AutoHub can depend on AutoVault directly:

```json
{
  "dependencies": {
    "@autoworks-ai/autovault": "file:../autovault"
  }
}
```

Then seed legacy AutoHub capability config into SQLite:

```bash
node dist/cli.js import-autohub \
  --tool-filters /absolute/path/to/autohub/config/tool-filters.json \
  --mcp-servers /absolute/path/to/autohub/config/mcp-servers.json
```

The importer stores required environment variable names only. Literal secret
values from MCP config are not written to SQLite.

## 7. First-test sanity checks (optional)

Run the included smoke script against your built server:

```bash
node scripts/smoke.mjs
```

Negative-path probing:

```bash
node scripts/probe.mjs
```

Both scripts spawn `dist/index.js` via stdio and exercise the tool surface.

Remote smoke test:

```bash
npm run build
node scripts/remote-smoke.mjs
```

This starts `dist/remote.js` on an ephemeral localhost port, completes OAuth
login/token exchange, proposes a skill as the owner, and calls `get_skill`
through Streamable HTTP MCP.

## Updating AutoVault

If you installed with `autovault.sh`, rerun the installer:

```bash
curl -fsSL https://autovault.sh | sh
```

For a manual clone:

```bash
git pull
npm ci
npm run build
```

If the bundled skills have changed, re-run the bootstrap:

```bash
node scripts/bootstrap-skills.mjs
```

`add_skill` overwrites existing local bundled skills, so re-running bootstrap is
safe and idempotent.

## Checking for upstream drift

AutoVault can detect when an installed skill has drifted from its source:

- Skills installed from `github`, `agentskills`, or `url` are compared against the current upstream content.
- Bundled inline skills are checked against the repo's `skills/<name>/SKILL.md`.
- Other inline skills have no upstream to compare and are reported as unchecked.
- Transforms are compared against their pinned base `SKILL.md`; changed bases
  appear in `transform_reviews` with the old pinned base content for review.

```
check_updates                 # all skills
check_updates("skill-name")   # specific skill
```

## Troubleshooting

### "Invalid AutoVault configuration" on startup

`AUTOVAULT_STORAGE_PATH` must be a non-empty string. If you set it explicitly,
confirm the value is quoted. If unset, AutoVault expands `~/.autovault`.

### Skills not showing up

- Confirm `AUTOVAULT_STORAGE_PATH` points to the same location the bootstrap
  script wrote to.
- If the MCP host says `auth unsupported`, that is expected for the local
  stdio server. It means the host asked for remote auth status, not that
  AutoVault credentials are broken.
- Check `ls $AUTOVAULT_STORAGE_PATH/skills/` — each skill must be a directory
  containing `SKILL.md`.
- Check `AUTOVAULT_PROFILE_LINKS` or rerun `sync-profiles --link ...` if
  skills exist in the vault but are missing from Codex/Claude native skill
  directories.
- Look at stderr from the MCP host for JSON-structured logs from AutoVault.

### Signature mismatch warnings in logs

AutoVault signs each skill with an Ed25519 key stored under
`$AUTOVAULT_STORAGE_PATH/.signing-key.json`. If you hand-edit an installed
SKILL.md, the signature will stop verifying and AutoVault will log a warning.
V1 enforcement is log-only; the skill still loads. Re-run bootstrap or
`update_skill` to re-sign.

Finder and editors may add benign metadata files such as `.DS_Store`,
`Thumbs.db`, `desktop.ini`, or AppleDouble `._*` files. AutoVault ignores those
for integrity decisions and reports them through `autovault doctor`; remove
them with:

```bash
autovault doctor --clean
```

Unknown extra files, symlinks, FIFOs, changed `SKILL.md`, and changed signed
resources are still treated as integrity failures. Reinstall the skill if
doctor reports those.

### Permission denied on `.signing-key.json`

The key file is written `0600`. If you restored from a backup that changed
permissions, fix them:

```bash
chmod 600 "$AUTOVAULT_STORAGE_PATH/.signing-key.json"
```

## Uninstall

```bash
rm -rf "$AUTOVAULT_STORAGE_PATH"     # default: ~/.autovault
```

Then remove the AutoVault entry from your MCP host config.
