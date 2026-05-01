# Installing AutoVault

This guide walks through setting up AutoVault as a local capability library and
compatibility MCP server for Claude Code, Cursor, Codex, AutoHub, or any other
local agent host.

## Prerequisites

- Node.js **>= 20.0.0** (use `node --version` to confirm)
- An MCP-compatible host (Claude Code, Cursor, Codex, etc.)
- Git (for cloning the repo)

## 1. Clone and build

```bash
git clone https://github.com/autoworks-ai/autovault.git
cd autovault
npm ci
npm run build
```

`npm run build` compiles TypeScript into `dist/`. The library entry point is
`dist/library.js`; the compatibility MCP server entry point is `dist/index.js`.

## 2. Choose a storage path (optional)

By default, AutoVault stores installed skills in `~/.autovault/` and capability
metadata in `~/.autovault/autovault.sqlite`. Override with
`AUTOVAULT_STORAGE_PATH` or `AUTOVAULT_DB_PATH` if you prefer a different
location.

```bash
export AUTOVAULT_STORAGE_PATH=~/.autovault   # default
export AUTOVAULT_DB_PATH=~/.autovault/autovault.sqlite
```

See [`README.md`](README.md#configuration) for the full list of environment
variables.

## 3. Seed the skill library

AutoVault ships with three skills in `skills/`:

- `autovault-skill` — meta-skill explaining how to discover and propose skills
- `commit-message` — generic demo: drafts a conventional-commit message from staged changes
- `skill-author` — generic demo: walks through authoring a valid SKILL.md

Seed them into your storage path:

```bash
npm run build            # if you haven't already
node scripts/bootstrap-skills.mjs
```

Expected output (abbreviated):

```text
Bootstrapping 3 skill(s) into /Users/you/.autovault
--- installing autovault-skill ---
{ "success": true, "name": "autovault-skill", ... }
--- installing commit-message ---
{ "success": true, "name": "commit-message", ... }
--- installing skill-author ---
{ "success": true, "name": "skill-author", ... }
--- list_skills ---
{ "skills": [ ... ] }
```

Each install runs the full validation gate (schema, security denylist,
capability cross-check). If any skill is rejected, the gate will explain why.

## 4. Generate per-agent skill profiles

Installed skills stay in `$AUTOVAULT_STORAGE_PATH/skills/<name>/SKILL.md`.
Profile sync reads each skill's `agents` frontmatter and creates symlinks under
`$AUTOVAULT_STORAGE_PATH/profiles/<agent>/`.

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
        "AUTOVAULT_STORAGE_PATH": "/Users/you/.autovault"
      }
    }
  }
}
```

Reload Claude Code. The `list_skills`, `search_skills`, `get_skill`,
`read_skill_resource`, `install_skill`, `propose_skill`, and `check_updates`
tools should all appear.

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
env = { AUTOVAULT_STORAGE_PATH = "/Users/you/.autovault" }
```

Check Codex docs for your specific version; the stanza shape may vary.

## 6. Verify

From your MCP host, run:

```
list_skills
```

You should see the three seeded skills. Then try:

```
search_skills("commit")
get_skill("commit-message")
search_skills("author a new skill")
get_skill("skill-author")
```

## 6a. Make the agent reach for the vault (recommended)

By default, the agent only consults AutoVault when you name it
("use autovault to..."). To make the agent check the vault reflexively for
every task, add the following instruction to your project's `AGENTS.md`,
`CLAUDE.md`, or the equivalent for your host:

```markdown
## Skill Discovery

Before performing any task the user asks for, call
`mcp__autovault__search_skills` with a short query describing the task. If
any result scores highly, call `mcp__autovault__get_skill` and follow the
returned SKILL.md instead of improvising from scratch. Only skip this step
if the user has explicitly said not to use AutoVault.
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
    "@autoworks/autovault": "file:../autovault"
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

## Updating AutoVault

```bash
git pull
npm ci
npm run build
```

If the bundled skills have changed, re-run the bootstrap:

```bash
node scripts/bootstrap-skills.mjs
```

`install_skill` overwrites existing skills, so re-running bootstrap is safe and
idempotent.

## Checking for upstream drift

For skills installed from `github`, `agentskills`, or `url`, AutoVault can
detect when the upstream source has changed:

```
check_updates                 # all skills
check_updates("skill-name")   # specific skill
```

Inline skills (including the bundled ones) never drift.

## Troubleshooting

### "Invalid AutoVault configuration" on startup

`AUTOVAULT_STORAGE_PATH` must be a non-empty string. If you set it explicitly,
confirm the value is quoted. If unset, AutoVault expands `~/.autovault`.

### Skills not showing up

- Confirm `AUTOVAULT_STORAGE_PATH` points to the same location the bootstrap
  script wrote to.
- Check `ls $AUTOVAULT_STORAGE_PATH/skills/` — each skill must be a directory
  containing `SKILL.md`.
- Look at stderr from the MCP host for JSON-structured logs from AutoVault.

### Signature mismatch warnings in logs

AutoVault signs each skill with an Ed25519 key stored under
`$AUTOVAULT_STORAGE_PATH/.signing-key.json`. If you hand-edit an installed
SKILL.md, the signature will stop verifying and AutoVault will log a warning.
V1 enforcement is log-only; the skill still loads. Re-run bootstrap or
`install_skill` to re-sign.

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
