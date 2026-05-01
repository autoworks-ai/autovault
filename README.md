# AutoVault

AutoVault is a **local capability library backed by SQLite**, with a stdio
Model Context Protocol (MCP) server kept as a compatibility wrapper. It gives
agents and agent hosts a single local place to resolve tools, MCP servers, and
reusable `SKILL.md` files.

In plain English: AutoVault is the local capability layer. It stores capability
metadata in SQLite, keeps skills as filesystem-native directories, generates
per-agent skill profiles, and helps agents reuse curated workflows instead of
rewriting them from scratch. It does **not** execute skills itself. It validates
and serves content; the host or downstream agent decides how to use it.

## What It Is

AutoVault is a Node/TypeScript library and compatibility MCP server that:

- stores skills on the local filesystem
- indexes profiles, callers, tool groups, aliases, context rules, and MCP servers in SQLite
- resolves scoped capabilities through `resolveCapabilities()`
- generates per-agent skill profile symlinks
- validates submitted or imported skill content
- exposes existing skill lifecycle operations over MCP tools
- tracks where installed skills came from
- detects when a remotely sourced skill has drifted upstream

The compatibility server runs over **stdio only**. An MCP host can spawn
`node dist/index.js` and communicate over stdin/stdout, while local callers can
import `@autoworks/autovault` directly.

See [`docs/adr/0001-transport.md`](docs/adr/0001-transport.md) for the runtime decision.

## What It Does

AutoVault supports local capability resolution plus the skill lifecycle:

1. **Resolve** tools, skills, and MCP servers for a caller/context
2. **Sync** skills into per-agent profile directories
3. **Discover** installed skills via search or listing
4. **Inspect** a skill's full `SKILL.md`, metadata, capabilities, and provenance
5. **Read** resource files packaged alongside a skill
6. **Propose** new skills with validation, dedup, and security gating
7. **Install** skills from GitHub, agentskills, or arbitrary HTTPS URLs
8. **Track provenance** with a per-skill sidecar file and content hash
9. **Check updates** to detect upstream drift

## Why Use It

AutoVault is useful when you want:

- a consistent source of truth for agent capabilities
- per-caller and per-channel capability scoping
- a safer workflow than ad hoc copy/paste skill files
- deduplication before new skills get added
- filesystem-native skill profiles for Claude Code, Codex, and other agents
- a lightweight local registry that still works with MCP-native tools
- provenance and drift visibility for imported skills

## Core Capabilities

### MCP Tool Surface

AutoVault still exposes 7 MCP tools:

- `list_skills` - list installed skill summaries
- `search_skills` - search by name, description, tags, and category
- `get_skill` - fetch the full skill plus parsed metadata and provenance
- `read_skill_resource` - read packaged resource files safely
- `install_skill` - install from `github`, `agentskills`, or `url`
- `propose_skill` - validate and store a newly proposed skill
- `check_updates` - compare installed content to upstream source state

### Library Surface

AutoVault exports an ESM library API:

- `resolveCapabilities()` / `resolve_capabilities()` - resolve tools, skills, and MCP servers for a scoped caller request
- `syncProfiles()` - regenerate per-agent profile symlinks from skill frontmatter
- `installSkill()` - install and validate a skill from a configured source
- `proposeSkill()` - validate, deduplicate, and store proposed skill content
- `importAutohubCapabilities()` / `ensureAutohubSeeded()` - import legacy AutoHub JSON state into SQLite

Unknown callers fail closed. Register callers explicitly or map unknown users to
a known restricted caller such as `guest`.

### Validation and Safety

Every install/propose path goes through a validation pipeline that includes:

- frontmatter parsing and normalization
- schema validation via `zod`
- denylist-based security scanning (12 patterns, extensible)
- capability-declaration cross-check (e.g., `network: false` vs. a `curl` in content)
- three-tier deduplication: exact content-hash match, near-exact text similarity, functional-overlap warning
- Ed25519 signing of every stored skill (log-only verification in V1)
- safe path handling for skill names and resource reads/writes

### Source Adapters

AutoVault currently supports:

- `github`: `owner/repo[@ref][:path/to/SKILL.md]`
- `agentskills`: `slug[@version]`
- `url`: HTTPS URLs only

Remote content is treated as untrusted until it passes validation.

### Provenance and Drift Detection

Installed skills are stored with two sidecar files:

- `.autovault-source.json` — source, identifier, upstream SHA, content hash, timestamps
- `.autovault-signature` — detached Ed25519 signature over the SKILL.md content

`check_updates` uses the content hash to detect upstream drift. The signature
detects post-install tampering (log-only warning in V1).

## Benefits

- **Reusable**: skills become searchable and retrievable through MCP
- **Safer**: malformed or obviously risky content is gated before persistence
- **Traceable**: imported skills keep source metadata and drift info
- **Simple**: plain filesystem storage, plain `SKILL.md` files, easy backup
- **MCP-native**: works naturally with hosts like Cursor that can spawn local stdio servers

## Architecture Overview

The server is intentionally simple:

- `src/mcp/` - MCP server wiring and tool registration
- `src/library.ts` - public library exports
- `src/capabilities/` - SQLite schema, AutoHub import, and capability resolver
- `src/profiles/` - per-agent skill profile symlink generation
- `src/tools/` - tool handlers
- `src/validation/` - parsing, schema validation, security scanning, dedup
- `src/sources/` - remote source adapters
- `src/storage/` - local skill storage and provenance sidecars
- `src/util/` - shared helpers

Storage layout:

```text
$AUTOVAULT_STORAGE_PATH/
  autovault.sqlite            # capability index
  .signing-key.json            # Ed25519 keypair (0600)
  skills/
    <name>/
      SKILL.md
      .autovault-source.json   # source, hash, timestamps
      .autovault-signature     # detached Ed25519 signature (0600)
      <resources...>
  profiles/
    <agent>/
      <skill-name> -> ../../skills/<skill-name>
```

## Quick Start

```bash
cp .env.example .env
npm ci
npm run build
node scripts/bootstrap-skills.mjs   # seed the bundled skills into ~/.autovault
npm run sync:profiles               # generate ~/.autovault/profiles/<agent> links
```

Note: `node dist/index.js` is meant to be **spawned by an MCP host**, not used
as a long-running interactive CLI. Use `npx autovault sync-profiles` or
`node dist/cli.js sync-profiles` for profile sync. See [`INSTALL.md`](INSTALL.md)
for complete setup instructions.

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
| `AUTOVAULT_DB_PATH` | `$AUTOVAULT_STORAGE_PATH/autovault.sqlite` | SQLite path for capability metadata. |
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

- signature verification enforcement (currently log-only)
- semantic search via local embeddings
- description optimization loop (from skill-creator)
- Hermes-style agent filesystem watchers for post-hoc consolidation
- remote HTTP+SSE mode with OAuth 2.1
- additional source adapters (ClawHub, LobeHub, Tessl)
- secret resolver (brainstorm pending)
