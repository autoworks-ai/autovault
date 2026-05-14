# AutoVault

<p align="center">
  <a href="https://www.npmjs.com/package/@autoworks-ai/autovault"><img alt="npm" src="https://img.shields.io/npm/v/%40autoworks-ai%2Fautovault?color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@autoworks-ai/autovault"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40autoworks-ai%2Fautovault?color=cb3837"></a>
  <a href="https://github.com/autoworks-ai/homebrew-tap/blob/main/Formula/autovault.rb"><img alt="Homebrew tap" src="https://img.shields.io/badge/homebrew-autoworks--ai%2Ftap%2Fautovault-FBB040?logo=homebrew"></a>
  <a href="https://github.com/autoworks-ai/autovault/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/autoworks-ai/autovault/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/autoworks-ai/autovault/actions/workflows/security.yml"><img alt="Security" src="https://github.com/autoworks-ai/autovault/actions/workflows/security.yml/badge.svg"></a>
  <a href="package.json"><img alt="Node >=24" src="https://img.shields.io/badge/node-%3E%3D24-339933"></a>
  <a href="LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="docs/adr/0001-transport.md"><img alt="MCP stdio + HTTP" src="https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-6f42c1"></a>
</p>

<p align="center"><code>[ SKILL.md ] -> [ validate ] -> [ sign ] -> [ scope ] -> [ render ]</code></p>

<p align="center"><strong>A local-first vault for the skills your agents actually use.</strong></p>

`SKILL.md` files already move through GitHub repos, team docs, public indexes,
Slack threads, and agent-written drafts. AutoVault gives those files one
canonical home: validate them at admission time, sign what passes, track where
they came from, and render the right view for each agent without maintaining
forks by hand.

AutoVault is a Node/TypeScript capability library, CLI, and MCP server. It has
local stdio and remote Streamable HTTP MCP entry points, both backed by the same
filesystem vault and SQLite capability index.

It does **not** execute skills through the MCP server. The server validates and
serves skill content; the host agent decides how to use that content inside its
own tool sandbox. The separate user-invoked `autovault skill <action>` CLI can
run signed `bin:` actions from installed skills, and that surface is documented
under [Security Model](#security-model).

Docs and public site: <https://autovault.dev>

## Why AutoVault

The SKILL.md format is intentionally plain. The hard part is everything around
it:

- **Skill drift** - the same skill gets copy-pasted into Claude Code, Codex,
  Cursor, and project folders with no upstream tracking.
- **Supply-chain risk** - remote skill bytes should be treated like untrusted
  package contents until they pass a gate.
- **Duplicate explosion** - agents can author near-identical skills unless new
  proposals are deduplicated before storage.
- **Platform mismatch** - one agent says `read`, another says `file_read`, and a
  third expects a different filesystem tool name.
- **Scope leakage** - local dev skills should not silently show up in prod or in
  another client's project.

AutoVault's answer is deliberately simple: keep one canonical skill folder,
record provenance, sign the admitted content, and sync or serve agent-specific
views from that source.

## Quick Start

Requirements:

- Node.js `>=24.0.0`
- `curl`, `tar`, and `npm`
- macOS 13+, Linux x64/arm64, or Windows through WSL2

Install the local vault:

```bash
curl -fsSL https://autovault.sh | sh
export PATH="$HOME/.autovault/bin:$PATH"
autovault doctor
autovault setup --review
autovault skill list
```

Install with Homebrew:

```bash
brew install autoworks-ai/tap/autovault
autovault setup
```

Install the packaged CLI/library directly from npm:

```bash
npm install -g @autoworks-ai/autovault
autovault setup --review
autovault doctor
```

Manual source install:

```bash
git clone https://github.com/autoworks-ai/autovault.git
cd autovault
npm ci
npm run build
node scripts/bootstrap-skills.mjs
node dist/cli.js doctor
```

The shell installer builds the app under `~/.autovault/app`, preserves
`~/.autovault` as user-owned vault storage, installs the `autovault` CLI shim,
and bootstraps bundled skills unless `AUTOVAULT_NO_BOOTSTRAP=1` is set.

## What Ships Today

AutoVault supports:

- local filesystem storage under `AUTOVAULT_STORAGE_PATH`
- a SQLite capability index for callers, profiles, tool groups, aliases,
  context rules, and MCP servers
- per-agent and tag-filtered profile symlink generation
- vault-local skill transforms that render agent-specific variants without
  forking upstream `SKILL.md`
- install, update, proposal, bulk-import, removal, resource-read, and drift-check
  workflows
- source adapters for GitHub, `agentskills`, arbitrary HTTPS URLs, local bundles,
  and inline MCP-proposed content
- three-tier deduplication for proposals
- Ed25519 signatures and manifest checks for stored skills and executable
  resources
- local stdio MCP and remote Streamable HTTP MCP at `/mcp` with OAuth-backed
  bearer auth

The npm package and Homebrew formula are live. The shell installer is still the
easiest local bootstrap path because it provisions `~/.autovault`, installs the
CLI shim, and seeds bundled skills in one pass.

Distribution:

- Source and releases: <https://github.com/autoworks-ai/autovault>
- NPM package page: <https://www.npmjs.com/package/@autoworks-ai/autovault>
- Homebrew tap: <https://github.com/autoworks-ai/homebrew-tap>
- Container image: `ghcr.io/autoworks-ai/autovault:<tag>`

## CLI Surface

The CLI is the local operator surface:

```text
autovault add-local <skill-dir> --source <repo-or-url> [--sync-profiles] [--link agent=/path/to/skills] [--json]
autovault remove <skill-name> [--discover|--no-discover] [--link agent=/path/to/skills] [--json]
autovault sync-profiles [--discover] [--link agent=/path/to/skills]
autovault profiles list [--json]
autovault setup [--json] [--review] [--advanced]
autovault doctor [skill-name] [--clean] [--repair] [--json]
autovault audit-repo --repo /path/to/repo [--format json|markdown]
autovault import-autohub --tool-filters /path/tool-filters.json [--mcp-servers /path/mcp-servers.json] [--reset]
autovault resolve --caller <id> --platform <name> [--channel <id>] --query <text>
autovault serve [--help]
autovault skill list
autovault skill search <query> [--top-k N]
autovault skill which <name> [<action>]
autovault skill <action> <name>
```

Common flows:

```bash
# Inspect vault health and integrity.
autovault doctor
autovault doctor --clean
autovault doctor --repair

# Import a local skill bundle through the same gate used by MCP installs.
autovault add-local ./path/to/your-skill \
  --source vendor/skills \
  --sync-profiles

# Search installed skills locally.
autovault skill search code-review --top-k 5

# Remove a vaulted skill and refresh managed profile links.
autovault remove skill-author --json
```

`autovault setup` is the first-run adoption wizard. It scans the vault, bundled
skills, and discovered native roots such as `~/.claude/skills`,
`~/.codex/skills`, and `~/.cursor/skills`, then asks how to adopt each skill.
Run it from a real terminal; without a TTY the installer defers setup and tells
you to rerun the wizard manually.

## MCP Tool Surface

MCP hosts can spawn the local stdio server with `node dist/index.js`, while
remote clients connect to `dist/remote.js` at `/mcp`.

Registered tools:

- `get_skill` - search by query or fetch by exact name, optionally rendering for
  an agent and including packaged resources.
- `add_skill` - install a known skill from `github`, `agentskills`, `url`, or
  `local`.
- `propose_skill` - submit newly authored SKILL.md bytes for validation,
  security scan, deduplication, signing, and storage.
- `bulk_import` - import every immediate child directory containing a `SKILL.md`.
- `update_skill` - refresh from the recorded source or replace from a new
  source, local bundle, or inline bytes.
- `delete_skill` - remove an installed skill and its vault-local transforms,
  then refresh generated profiles.
- `check_updates` - compare installed skills against upstream source state and
  report drift or transform-review work.

Tool handlers return plain objects. `src/mcp/server.ts` wraps and serializes
them into the MCP `content[0].text` envelope. Remote mode applies an additional
policy layer for scopes and skill visibility.

## Library Surface

The source package exports the same helpers used by the CLI and MCP server:

- `resolveCapabilities()` / `resolve_capabilities()`
- `syncProfiles()` and `discoverProfileRoots()`
- `addSkill()`, `updateSkill()`, `deleteSkill()`, `installSkill()`,
  `addLocalSkill()`, `proposeSkill()`, and `bulkImport()`
- `proposeSkillTransform()`, `listSkillTransforms()`,
  `removeSkillTransform()`, and `renderSkillForAgent()`
- `auditRepo()`
- `importAutohubCapabilities()` / `ensureAutohubSeeded()`

Unknown callers fail closed. Register callers explicitly or map unknown users to
a restricted caller such as `guest`.

## Validation Gate

Every install, update, proposal, and bulk import runs through the same
validation path:

1. Repair and normalize frontmatter formatting.
2. Parse YAML frontmatter with `gray-matter`.
3. Validate schema with `zod`.
4. Scan content against the denylist in `scripts/security/patterns.json`.
5. Cross-check declared capabilities against observed behavior.
6. Deduplicate exact, near-exact, and functionally similar proposals.
7. Write the skill, source sidecar, signed manifest, and Ed25519 signature.

In strict mode (`AUTOVAULT_SECURITY_STRICT=true`, the default), denylist hits
block writes. In non-strict mode they become warnings.

## Storage Layout

Default storage is `~/.autovault`; override it with
`AUTOVAULT_STORAGE_PATH`.

```text
$AUTOVAULT_STORAGE_PATH/
  autovault.sqlite             # capability index
  .signing-key.json            # Ed25519 keypair, mode 0600
  skills/
    <name>/
      SKILL.md
      .autovault-source.json   # source, hash, timestamps
      .autovault-signature     # detached Ed25519 signature, mode 0600
      .autovault-manifest      # signed manifest for declared resources/bin
      <resources...>
  transforms/
    <base-skill>/<transform>/
      TRANSFORM.md
      BASE_SKILL.md
      .autovault-transform.json
      .autovault-manifest
  rendered/
    <agent>/<skill>/            # generated variants
  profiles/
    <agent>/<skill-name> -> ../../skills/<skill-name> or ../../rendered/<agent>/<skill-name>
    <named-profile>/<skill-name> -> ../../skills/<skill-name> or ../../rendered/<agent>/<skill-name>
  profiles.config.json
```

Skills are plain files. Back them up like dotfiles:

```bash
tar -czf autovault-backup-$(date +%F).tgz -C "$HOME" .autovault
```

## Skill Transforms

Transforms let a workspace or agent adjust a skill without editing the upstream
`SKILL.md`. AutoVault stores the transform under the vault, appends transform
instructions to the base skill at render time, applies declared capability
metadata overrides, and materializes generated variants under `rendered/`.

Example `TRANSFORM.md`:

```yaml
---
name: perplexity
base: research-skill
description: Use Perplexity instead of the default web search path.
targets:
  agents: [codex]
priority: 100
capability_overrides:
  network: true
  tools:
    add: [mcp__perplexity__search]
    remove: [web_search]
metadata:
  version: "1.0.0"
---

Use `mcp__perplexity__search` instead of `web_search` for research.
```

When the base skill changes, `check_updates` continues rendering the transform
but returns `transform_reviews` with the pinned old base so the delta can be
reviewed.

## Remote Deploy

Remote mode is for a shared or managed vault. It serves Streamable HTTP MCP at
`/mcp`, uses OAuth for client registration/login/token issuance, and stores the
vault under the mounted `AUTOVAULT_STORAGE_PATH`.

```bash
npm run build
AUTOVAULT_MODE=remote \
AUTOVAULT_PUBLIC_URL=http://localhost:3000 \
AUTOVAULT_ADMIN_EMAIL=admin@example.com \
AUTOVAULT_ADMIN_PASSWORD=replace-with-a-long-random-password \
npm run start:remote
```

Docker:

```bash
AUTOVAULT_ADMIN_EMAIL=admin@example.com \
AUTOVAULT_ADMIN_PASSWORD=replace-with-a-long-random-password \
docker compose up --build
```

Remote mode cannot create symlinks on client machines. `sync-profiles` is
local-only because a remote MCP server has no filesystem access to
`~/.codex/skills`, `~/.claude/skills`, or other host roots. Remote clients
should discover and read skills directly through `get_skill`.

## Configuration

Runtime environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTOVAULT_MODE` | `local` | `local` for stdio/library use, `remote` for HTTP MCP. |
| `AUTOVAULT_STORAGE_PATH` | `~/.autovault` | Root path for installed skills. |
| `AUTOVAULT_DB_PATH` | `$AUTOVAULT_STORAGE_PATH/autovault.sqlite` | SQLite capability index. |
| `AUTOVAULT_PROFILE_LINKS` | unset | Comma-separated `agent=/skills/root` links for profile sync. |
| `AUTOVAULT_PROFILE_CONFIG_PATH` | `$AUTOVAULT_STORAGE_PATH/profiles.config.json` | Optional named profile config. |
| `AUTOVAULT_SKILL_INSTALL` | `prefer-autovault` | Vendor routing: `prefer-autovault`, `both`, `native`, `native-only`, or `off`. |
| `AUTOVAULT_SECURITY_STRICT` | `true` | Block denylist hits when true; warn when false. |
| `AUTOVAULT_SEARCH_MODE` | `text` | Search backend. Metadata text search is the current implementation. |
| `AUTOVAULT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `AUTOVAULT_PUBLIC_URL` | required in remote mode | Public origin for OAuth metadata and callbacks. |
| `AUTOVAULT_HTTP_PORT` | `3000` | HTTP port when `PORT` is not injected by the platform. |
| `AUTOVAULT_ALLOWED_ORIGINS` | unset | Optional CORS allowlist for remote mode. |
| `AUTOVAULT_ADMIN_EMAIL` | required until owner exists | First remote owner email. |
| `AUTOVAULT_ADMIN_PASSWORD` | required until owner exists | First remote owner password, at least 12 characters. |
| `GITHUB_TOKEN` | unset | Optional GitHub API rate-limit headroom. |
| `AUTOVAULT_AGENTSKILLS_BASE` | `https://agentskills.io/api/v1` | Override the agentskills API base. |

Installer-only environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTOVAULT_HOME` | `~/.autovault` | Install root for app, shim, and default storage. |
| `AUTOVAULT_BIN_DIR` | `$AUTOVAULT_HOME/bin` | Directory for the `autovault` shim. |
| `AUTOVAULT_REF` | `main` | GitHub branch or tag downloaded by `autovault.sh`. |
| `AUTOVAULT_TARBALL_URL` | derived from `AUTOVAULT_REF` | Fully override the source archive URL. |
| `AUTOVAULT_NO_BOOTSTRAP` | `0` | Set to `1` to skip bundled-skill bootstrap. |

## Security Model

AutoVault has two execution surfaces with different boundaries.

**The MCP servers** (`dist/index.js` over stdio and `dist/remote.js` over
Streamable HTTP) are storage-and-validation services. They never execute skill
content. Remote sources are treated as untrusted input and must pass schema,
security, capability, dedup, signing, and path-safety checks before any write.
All diagnostics go to stderr so stdout stays reserved for stdio MCP framing.
Remote mode additionally requires OAuth bearer tokens and filters skill
visibility for non-owner users.

**The `autovault skill <action>` CLI** is a user-invoked execution surface for
skills that declare signed `bin:` actions. It runs the script as the invoking
user, with that user's filesystem and network access. Before execution, the CLI
hard-fails if the signed manifest, `SKILL.md`, or declared bin resources have
been changed post-install.

Important limits:

- The trust root is the keypair at `$AUTOVAULT_STORAGE_PATH/.signing-key.json`.
  Treat storage-root write access as full vault compromise.
- `autovault doctor --clean` removes only ignored OS/editor metadata such as
  `.DS_Store`, `Thumbs.db`, `desktop.ini`, and AppleDouble `._*` files.
- Unknown hidden files, symlinks, special files, unsigned helpers, and changed
  signed files remain integrity failures.
- The CLI requires an interactive TTY for bin actions as defense in depth, but a
  pseudo-terminal can satisfy that check. The hard boundary is validation plus
  manifest signing, not proof of a human at the keyboard.

For the full model and accepted risks, read
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Development

```bash
npm ci
npm run build
npm test
node scripts/smoke.mjs
node scripts/remote-smoke.mjs
node scripts/probe.mjs
```

The smoke, probe, and remote-smoke scripts require `npm run build` first because
they spawn compiled files from `dist/`.

Architecture map:

- `src/index.ts` - local stdio MCP entry point
- `src/remote.ts` - remote Streamable HTTP MCP entry point
- `src/mcp/` - tool registration and serialization
- `src/tools/` - MCP tool handlers
- `src/cli/` - local operator CLI and UI
- `src/library.ts` - public ESM exports
- `src/capabilities/` - SQLite schema, resolver, AutoHub import
- `src/profiles/` - profile discovery, filtering, and symlink sync
- `src/validation/` - frontmatter repair, schema, security, dedup
- `src/sources/` - source adapters
- `src/storage/` - filesystem storage, locks, manifests, signing
- `src/util/` - shared helpers

Release and operations docs:

- [`INSTALL.md`](INSTALL.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`docs/RELEASE.md`](docs/RELEASE.md)
- [`docs/adr/0001-transport.md`](docs/adr/0001-transport.md)

## Roadmap

Likely next areas:

- stronger key storage for signature enforcement
- semantic search via local embeddings
- additional source adapters such as ClawHub, LobeHub, and Tessl
- local mirror helper for permitted remote skills
- secret resolver design, without storing secret values in the vault
