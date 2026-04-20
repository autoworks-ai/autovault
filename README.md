# AutoVault

AutoVault is a Model Context Protocol (MCP) server that **stores, validates,
and serves curated agent skills**. It does not execute skills.

The server runs over **stdio only** (see [`docs/adr/0001-transport.md`](docs/adr/0001-transport.md)).
An MCP host (Cursor, Claude Desktop, custom agent) is expected to spawn the
process and communicate over stdin/stdout. AutoVault never opens a network
listener.

## Features

- MCP tools: `list_skills`, `search_skills`, `get_skill`, `read_skill_resource`,
  `install_skill`, `propose_skill`, `check_updates`.
- Validation pipeline: frontmatter parse + repair, schema validation,
  configurable security denylist, content-similarity dedup gate.
- Pluggable source adapters: `github` (owner/repo[@ref][:path]), `agentskills`
  (slug[@version]), `url` (https only).
- Drift detection via per-skill source metadata sidecar (`.autovault-source.json`)
  and content hashes.
- Structured JSON logs to stderr; stdout is reserved for MCP framing.

## Quick Start

```bash
cp .env.example .env
npm install
npm run build
node dist/index.js   # spawned by your MCP host, not run interactively
```

For development:

```bash
npm run dev          # tsx watch
npm test             # vitest
```

## Configuration

All configuration is via environment variables. Invalid values fail fast at
startup with a descriptive error.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTOVAULT_MODE` | `local` | Reserved for future modes. |
| `AUTOVAULT_STORAGE_PATH` | `~/.autovault` | Root path for installed skills. |
| `AUTOVAULT_SECURITY_STRICT` | `true` | If true, security denylist hits block install/propose. If false, hits become warnings. |
| `AUTOVAULT_SEARCH_MODE` | `text` | Search backend (only `text` shipped today). |
| `AUTOVAULT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `GITHUB_TOKEN` | _unset_ | Optional. Used for GitHub API rate-limit headroom. |
| `AUTOVAULT_AGENTSKILLS_BASE` | `https://agentskills.io/api/v1` | Override agentskills base URL. |

## Project Layout

- `src/mcp/` MCP server wiring.
- `src/tools/` tool handlers (one file per tool).
- `src/validation/` frontmatter, schema, security, dedup.
- `src/sources/` upstream source adapters (`github`, `agentskills`, `url`).
- `src/storage/` filesystem-backed skill storage.
- `src/util/` logging and hashing helpers.
- `scripts/security/patterns.json` security denylist (single source of truth).
- `docs/adr/` architecture decision records.
- `docs/THREAT-MODEL.md` threat model.

## Storage Layout

```
$AUTOVAULT_STORAGE_PATH/
  skills/
    <name>/
      SKILL.md
      .autovault-source.json   # source provenance + content hash
      <resources...>
```

## Backup and Restore

Skills are plain files, so backup is a `tar`/`rsync` of
`$AUTOVAULT_STORAGE_PATH/skills/`. To restore, drop the directory back in
place; AutoVault re-reads metadata on each request.

```bash
tar -czf autovault-backup-$(date +%F).tgz -C "$HOME" .autovault
```

For a release/rollback checklist, see [`docs/RELEASE.md`](docs/RELEASE.md).

## Docker

Docker is provided for build/distribution; AutoVault is still stdio-only.

```bash
docker compose build
docker compose run --rm autovault   # attach an MCP client over stdio
```

The image does not expose any port and does not run as a detached daemon.

## Status

Current release target: `0.2.0`.

This is a working v1 branch. Roadmap items: signed skill bundles
(`tweetnacl`-backed), richer remote source ranking, optional semantic
search.
