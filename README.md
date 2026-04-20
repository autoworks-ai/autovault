# AutoVault

AutoVault is a **stdio-first Model Context Protocol (MCP) server for agent skills**.
It gives MCP hosts like Cursor or Claude Desktop a single place to store,
validate, search, install, inspect, and update reusable `SKILL.md` files.

In plain English: AutoVault is a skill registry that runs locally, speaks MCP,
and helps agents reuse curated workflows instead of rewriting them from scratch.
It does **not** execute skills itself. It validates and serves them; the MCP
host or downstream agent decides how to use them.

## What It Is

AutoVault is a Node/TypeScript MCP server that:

- stores skills on the local filesystem
- validates submitted or imported skill content
- exposes those skills over MCP tools
- tracks where installed skills came from
- detects when a remotely sourced skill has drifted upstream

The server runs over **stdio only**. An MCP host is expected to spawn
`node dist/index.js` and communicate over stdin/stdout.

See [`docs/adr/0001-transport.md`](docs/adr/0001-transport.md) for the runtime decision.

## What It Does

AutoVault supports the full skill lifecycle for a local MCP environment:

1. **Discover** installed skills via search or listing
2. **Inspect** a skill's full `SKILL.md`, metadata, capabilities, and provenance
3. **Read** resource files packaged alongside a skill
4. **Propose** new skills with validation, dedup, and security gating
5. **Install** skills from GitHub, agentskills, or arbitrary HTTPS URLs
6. **Track provenance** with a per-skill sidecar file and content hash
7. **Check updates** to detect upstream drift

## Why Use It

AutoVault is useful when you want:

- a consistent source of truth for reusable agent skills
- a safer workflow than ad hoc copy/paste skill files
- deduplication before new skills get added
- a lightweight local registry that works well with MCP-native tools
- provenance and drift visibility for imported skills

## Core Capabilities

### MCP Tool Surface

AutoVault exposes 7 MCP tools:

- `list_skills` - list installed skill summaries
- `search_skills` - search by name, description, tags, and category
- `get_skill` - fetch the full skill plus parsed metadata and provenance
- `read_skill_resource` - read packaged resource files safely
- `install_skill` - install from `github`, `agentskills`, or `url`
- `propose_skill` - validate and store a newly proposed skill
- `check_updates` - compare installed content to upstream source state

### Validation and Safety

Every install/propose path goes through a validation pipeline that includes:

- frontmatter parsing and normalization
- schema validation via `zod`
- denylist-based security scanning
- duplicate detection based on content similarity
- safe path handling for skill names and resource reads/writes

### Source Adapters

AutoVault currently supports:

- `github`: `owner/repo[@ref][:path/to/SKILL.md]`
- `agentskills`: `slug[@version]`
- `url`: HTTPS URLs only

Remote content is treated as untrusted until it passes validation.

### Provenance and Drift Detection

Installed skills are stored with a sidecar file:

- `.autovault-source.json`

That sidecar records source metadata, content hash, and timestamps so
`check_updates` can detect upstream drift.

## Benefits

- **Reusable**: skills become searchable and retrievable through MCP
- **Safer**: malformed or obviously risky content is gated before persistence
- **Traceable**: imported skills keep source metadata and drift info
- **Simple**: plain filesystem storage, plain `SKILL.md` files, easy backup
- **MCP-native**: works naturally with hosts like Cursor that can spawn local stdio servers

## Architecture Overview

The server is intentionally simple:

- `src/mcp/` - MCP server wiring and tool registration
- `src/tools/` - tool handlers
- `src/validation/` - parsing, schema validation, security scanning, dedup
- `src/sources/` - remote source adapters
- `src/storage/` - local skill storage and provenance sidecars
- `src/util/` - shared helpers

Storage layout:

```text
$AUTOVAULT_STORAGE_PATH/
  skills/
    <name>/
      SKILL.md
      .autovault-source.json
      <resources...>
```

## Quick Start

```bash
cp .env.example .env
npm install
npm run build
node dist/index.js
```

Note: `node dist/index.js` is meant to be **spawned by an MCP host**, not used
as a long-running interactive CLI.

For development:

```bash
npm run dev
npm test
```

## Using It With Cursor

Cursor supports project-local MCP config via `.cursor/mcp.json`.

Example:

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

After saving the config, reload Cursor and verify the server under
`Tools & MCP`.

## Configuration

All config is environment-based and validated at startup.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTOVAULT_MODE` | `local` | Reserved for future modes. |
| `AUTOVAULT_STORAGE_PATH` | `~/.autovault` | Root path for installed skills. |
| `AUTOVAULT_SECURITY_STRICT` | `true` | If true, denylist hits block install/propose; if false, they become warnings. |
| `AUTOVAULT_SEARCH_MODE` | `text` | Search backend (currently `text` only). |
| `AUTOVAULT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `GITHUB_TOKEN` | _unset_ | Optional. Used for GitHub API rate-limit headroom. |
| `AUTOVAULT_AGENTSKILLS_BASE` | `https://agentskills.io/api/v1` | Override the agentskills base URL. |

## Security Model

AutoVault is a storage-and-validation service, not a sandbox or execution engine.

- It **does not execute** skill content.
- It treats remote sources as **untrusted input**.
- It blocks common unsafe patterns via a denylist.
- It validates paths to prevent traversal.
- It writes diagnostics to **stderr** so stdout stays reserved for MCP framing.

For the full threat model, see [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Backup and Restore

Skills are plain files, so backup is straightforward:

```bash
tar -czf autovault-backup-$(date +%F).tgz -C "$HOME" .autovault
```

To restore, place the skill directory back under `AUTOVAULT_STORAGE_PATH`.

For release/rollback guidance, see [`docs/RELEASE.md`](docs/RELEASE.md).

## Testing and Verification

The project includes:

- unit and integration tests via `vitest`
- end-to-end smoke verification in `scripts/smoke.mjs`
- negative-path probing in `scripts/probe.mjs`
- GitHub Actions CI for build, test, and audit checks

Run locally:

```bash
npm run build
npm test -- --coverage
node scripts/smoke.mjs
node scripts/probe.mjs
```

## Docker

Docker is provided for packaging and distribution, but the runtime model is
still stdio-only.

```bash
docker compose build
docker compose run --rm autovault
```

The image does not expose a network port and is not intended to run as a
detached HTTP service.

## Release Status

Current release: `v0.2.0`

See:

- [`CHANGELOG.md`](CHANGELOG.md)
- [`docs/RELEASE.md`](docs/RELEASE.md)

## Roadmap

Likely next areas of expansion:

- signed skill bundles (`tweetnacl` roadmap)
- richer provenance and trust controls
- stronger release automation
- more advanced search modes
