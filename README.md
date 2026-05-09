# AutoVault

AutoVault is a **capability library backed by SQLite**, with local stdio and
remote Streamable HTTP Model Context Protocol (MCP) entry points. It gives
agents and agent hosts a single place to resolve tools, MCP servers, and
reusable `SKILL.md` files.

In plain English: AutoVault is the capability layer. Locally, it stores
filesystem-native skill directories and can generate per-agent profile symlinks.
Remotely, it serves the same vault over MCP with OAuth and role-aware access
checks. It does **not** execute skills itself. It validates and serves content;
the host or downstream agent decides how to use it.

## What It Is

AutoVault is a Node/TypeScript library and compatibility MCP server that:

- stores skills on the local filesystem or a mounted service volume
- indexes profiles, callers, tool groups, aliases, context rules, and MCP servers in SQLite
- resolves scoped capabilities through `resolveCapabilities()`
- generates per-agent skill profile symlinks in local mode
- applies vault-local skill transforms when generating per-agent profiles
- validates submitted or imported skill content
- exposes existing skill lifecycle operations over MCP tools
- tracks where installed skills came from
- detects when an installed skill has drifted from its upstream source

The local compatibility server still runs over stdio. An MCP host can spawn
`node dist/index.js` and communicate over stdin/stdout, while local callers can
import `@autoworks/autovault` directly. Remote deployments use
`node dist/remote.js` and expose Streamable HTTP MCP at `/mcp`.

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
8. **Add local bundles** from third-party installers with `autovault add-local`
9. **Track provenance** with a per-skill sidecar file and content hash
10. **Check updates** to detect upstream drift
11. **Transform** skills per agent/workspace without forking upstream content

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

AutoVault still exposes the core MCP tools:

- `get_skill` - search by query or fetch by name, with optional packaged resource contents
- `add_skill` - add from `github`, `agentskills`, `url`, or a local bundle
- `update_skill` - refresh or replace an installed skill
- `delete_skill` - remove an installed skill and refresh generated profiles
- `propose_skill` - validate and store a newly proposed skill
- `check_updates` - compare installed content to upstream source state

### Library Surface

AutoVault exports an ESM library API:

- `resolveCapabilities()` / `resolve_capabilities()` - resolve tools, skills, and MCP servers for a scoped caller request
- `syncProfiles()` - regenerate per-agent profile symlinks from skill frontmatter
- `discoverProfileRoots()` - detect existing native host skill roots
- `addSkill()` / `updateSkill()` / `deleteSkill()` - CRUD-oriented skill lifecycle helpers
- `auditRepo()` - classify repo-local scripts, tools, workflows, and shims for migration into AutoVault skills
- `installSkill()` - install and validate a skill from a configured source
- `addLocalSkill()` - install and validate a local skill bundle with local provenance
- `proposeSkill()` - validate, deduplicate, and store proposed skill content
- `proposeSkillTransform()` / `listSkillTransforms()` / `removeSkillTransform()` - manage vault-local skill overlays
- `renderSkillForAgent()` - preview the generated skill body for one agent
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

- `github`: `owner/repo[@ref][:path/to/SKILL.md]`, GitHub blob URLs, or GitHub repo-root/tree URLs for `SKILL.md` discovery
- `agentskills`: `slug[@version]`
- `url`: HTTPS URLs only

Remote content is treated as untrusted until it passes validation.

### Provenance and Drift Detection

Installed skills are stored with two sidecar files:

- `.autovault-source.json` — source, identifier, upstream SHA, content hash, timestamps
- `.autovault-signature` — detached Ed25519 signature over the SKILL.md content

`check_updates` uses the content hash to detect upstream drift for remote
sources and bundled inline skills. Non-bundled inline skills are reported as
unchecked. Transform overlays are compared against their pinned base
`SKILL.md`; changed bases appear in `transform_reviews`. The signature detects
post-install tampering (log-only warning in V1).

## Benefits

- **Reusable**: skills become searchable and retrievable through MCP
- **Safer**: malformed or obviously risky content is gated before persistence
- **Traceable**: imported skills keep source metadata and drift info
- **Simple**: plain filesystem storage, plain `SKILL.md` files, easy backup
- **MCP-native**: works with local stdio hosts and remote MCP clients

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
  transforms/
    <base-skill>/<transform>/
      TRANSFORM.md              # vault-local overlay instructions
      BASE_SKILL.md             # pinned old base snapshot for review
      .autovault-transform.json # pinned hashes and metadata
      .autovault-manifest       # signed transform manifest
  rendered/
    <agent>/<skill>/            # disposable generated variants
  profiles/
    <agent>/
      <skill-name> -> ../../skills/<skill-name> or ../../rendered/<agent>/<skill-name>
```

### Skill Transforms

Transforms let a workspace or agent adjust a skill without forking the upstream
`SKILL.md`. A transform is stored under the vault, not inside the installed
skill directory, and profile sync materializes a generated `SKILL.md` only for
matching agents.

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

Transforms are deterministic compose overlays: AutoVault appends the transform
instructions to the base skill and applies declared capability metadata
overrides. It does not call an LLM during sync. When the base skill changes,
`check_updates` continues rendering the transform but returns
`transform_reviews` with the pinned old base `SKILL.md` so the delta can be
reviewed.

## Quick Start

```bash
curl -fsSL https://autovault.sh | sh
export PATH="$HOME/.autovault/bin:$PATH"
autovault skill list
autovault doctor
```

## Install Once, Render Everywhere

Third-party installers can hand AutoVault a local skill bundle instead of
copying the same files into every host-specific skill directory:

```bash
autovault add-local ./path/to/your-skill --source vendor/skills --sync-profiles
```

`add-local` requires `SKILL.md`, collects sibling resources, refuses symlinks,
runs the normal validation/signing pipeline, records `source: "local"`, and
then optionally syncs rendered profile links. With `--sync-profiles`, AutoVault
discovers existing native roots such as `~/.claude/skills`, `~/.codex/skills`,
and `~/.cursor/skills`, while preserving user-managed native files on conflict.
The MCP `add_skill` local-bundle path syncs configured profile links by default;
pass `sync_profiles: false` only when a caller intentionally wants storage-only
install.

Use `autovault doctor` to inspect vault health. `autovault doctor --clean`
removes only ignored OS/editor metadata artifacts such as `.DS_Store`,
`Thumbs.db`, `desktop.ini`, and AppleDouble `._*` files; unknown extra files
and changed signed content remain integrity failures.

Vendors can use the drop-in helper in
[`scripts/vendor-autovault-install.sh`](scripts/vendor-autovault-install.sh).
The routing mode is controlled by `AUTOVAULT_SKILL_INSTALL`:

| Mode | Behavior |
|------|----------|
| unset, `prefer`, `prefer-autovault` | Use AutoVault when available, otherwise native install. |
| `both` | Install through AutoVault and the vendor's native path. |
| `native` | Try native first, then AutoVault as fallback. |
| `native-only` | Only run the native path. |
| `off` | Skip skill installation. |

Note: `node dist/index.js` is meant to be **spawned by an MCP host**, not used
as a long-running interactive CLI. The installer builds the Node app under
`~/.autovault/app`, keeps installed skills and signatures under `~/.autovault`,
and exposes the user-facing CLI as `~/.autovault/bin/autovault`. See
[`INSTALL.md`](INSTALL.md) for manual clone and MCP host setup instructions.

For development:

```bash
npm run dev
npm test
```

## Repo Tooling Audit

Use `audit-repo` to inventory an AutoHub-style repository before moving local
scripts and operator workflows into AutoVault:

```bash
autovault audit-repo --repo ../autohub --format markdown
autovault audit-repo --repo ../autohub --format json
```

Each item includes `path`, `kind`, `classification`, `target`, `risk`, and
`reasons`. Secret-shaped values are never echoed; the audit reports only
redacted file/key findings.

## Remote Deploy

Remote mode is for a shared or managed vault: Docker, Railway, or any platform
that can run a Node container with a persistent volume. It serves Streamable
HTTP MCP at `/mcp`, uses OAuth for client registration/login/token issuance,
and stores the vault under the mounted `AUTOVAULT_STORAGE_PATH`.

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

Railway:

1. Create a Railway service from this repository.
2. Add a volume mounted at `/data/autovault`.
3. Set `AUTOVAULT_PUBLIC_URL=https://<service>.up.railway.app`.
4. Set `AUTOVAULT_ADMIN_EMAIL` and `AUTOVAULT_ADMIN_PASSWORD`.
5. Deploy the included `Dockerfile`; Railway provides `PORT`, and AutoVault
   binds to `0.0.0.0:$PORT`.

Remote MCP URL:

```text
http://localhost:3000/mcp
https://<service>.up.railway.app/mcp
```

Remote mode cannot create symlinks on client machines. `sync-profiles` remains
local-only because a remote MCP server has no filesystem access to
`~/.codex/skills`, `~/.claude/skills`, or other host skill roots. Remote clients
should discover and read skills directly through `get_skill`. A later local
mirror helper can pull permitted remote skills into local profile directories if
filesystem-native host skills are required.

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
| `AUTOVAULT_MODE` | `local` | `local` for stdio/library use, `remote` for the HTTP MCP service. |
| `AUTOVAULT_STORAGE_PATH` | `~/.autovault` | Root path for installed skills. |
| `AUTOVAULT_DB_PATH` | `$AUTOVAULT_STORAGE_PATH/autovault.sqlite` | SQLite path for capability metadata. |
| `AUTOVAULT_PROFILE_LINKS` | _unset_ | Comma-separated `agent=/skills/root` links to refresh during profile sync, e.g. `codex=~/.codex/skills,claude-code=~/.claude/skills`. |
| `AUTOVAULT_SKILL_INSTALL` | `prefer-autovault` | Vendor installer routing contract for local skill bundles: `prefer-autovault`, `both`, `native`, `native-only`, or `off`. |
| `AUTOVAULT_SECURITY_STRICT` | `true` | If true, denylist hits block install/propose; if false, they become warnings. |
| `AUTOVAULT_SEARCH_MODE` | `text` | Search backend (currently `text` only). |
| `AUTOVAULT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `AUTOVAULT_PUBLIC_URL` | _required in remote mode_ | Public origin for OAuth metadata and Railway/custom-domain callbacks. |
| `AUTOVAULT_HTTP_PORT` | `3000` | Local HTTP port when `PORT` is not provided by the platform. |
| `AUTOVAULT_ALLOWED_ORIGINS` | _unset_ | Optional comma-separated browser origins allowed to call the service. |
| `AUTOVAULT_ADMIN_EMAIL` | _required until an owner exists_ | Email for the first owner account seeded on remote boot. |
| `AUTOVAULT_ADMIN_PASSWORD` | _required until an owner exists_ | Password for the first owner account; must be at least 12 characters. |
| `GITHUB_TOKEN` | _unset_ | Optional. Used for GitHub API rate-limit headroom. |
| `AUTOVAULT_AGENTSKILLS_BASE` | `https://agentskills.io/api/v1` | Override the agentskills base URL. |

Installer-only variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTOVAULT_HOME` | `~/.autovault` | Install root for the app, shim, and default storage. |
| `AUTOVAULT_BIN_DIR` | `$AUTOVAULT_HOME/bin` | Directory where the `autovault` shim is written. |
| `AUTOVAULT_REF` | `main` | GitHub branch or tag downloaded by `autovault.sh`. |
| `AUTOVAULT_TARBALL_URL` | _derived from `AUTOVAULT_REF`_ | Fully override the source archive URL. |
| `AUTOVAULT_NO_BOOTSTRAP` | `0` | Set to `1` to skip bundled-skill bootstrap. |

## Security Model

AutoVault has two distinct surfaces with different execution properties.

**The MCP servers** (`dist/index.js` over stdio and `dist/remote.js` over Streamable HTTP) are storage-and-validation services. They never execute skill content. Agents call their tools to install, propose, search, and read skills; the bytes sit on disk afterward. Remote sources are treated as untrusted input, validated through the schema/security/capability pipeline, and rejected (or, in non-strict mode, warned about) before any write. Path inputs are checked to prevent traversal, and all diagnostics go to stderr so stdout stays reserved for MCP framing on the stdio path. Remote mode additionally requires OAuth bearer tokens and filters skill visibility for non-owner users.

**The `autovault skill <action>` CLI** (e.g. `autovault skill setup <name>`) is a separate, user-invoked surface that *does* execute the bin resources a skill declares in its `bin:` frontmatter block. It is the explicit "user runs this in their own terminal" path for skills that need out-of-band setup (registering MCP servers, writing host config, prompting for secrets). The CLI runs the script as the invoking user, with the user's full filesystem and network access. These checks apply before exec:

- **Manifest signature verification, hard-fail.** Every byte of SKILL.md and every declared bin resource is signed at install time. If either has been mutated post-install, the CLI refuses to run and exits non-zero. This is hard enforcement, not log-only — but the trust root is the keypair at `$AUTOVAULT_STORAGE_PATH/.signing-key.json`, which lives inside the directory the manifest is protecting. The verification therefore detects tampering by callers *outside* the storage-root trust domain (the MCP API, which exposes no key-write tool; accidental corruption; weaker-privilege processes that can read but not write the storage tree). It does **not** defend against a same-uid attacker who already has storage-root writes — they can rewrite the keypair and re-sign tampered bytes. Treat storage-root write access as full vault compromise; see `docs/THREAT-MODEL.md` for the deliberate v1 trade and the v2 keychain lift.
- **Benign metadata ignore.** The open-set integrity walk ignores regular OS/editor metadata artifacts (`.DS_Store`, `Thumbs.db`, `desktop.ini`, and AppleDouble `._*`) because Finder/editor browsing should not look like skill tampering. Symlinks, special files, unknown hidden files, unsigned helpers, and changed signed files are still integrity failures. Run `autovault doctor --clean` to remove ignored artifacts.
- **Storage-root only.** The CLI execs from `$AUTOVAULT_STORAGE_PATH/skills/<name>/`, never from a synced host mirror (`~/.claude/skills/`, `~/.cursor/skills/`). Mirrors are read-only copies maintained by `sync-profiles`; only the storage root carries the manifest the CLI was authored against.
- **Interactive-TTY gate (defense-in-depth).** `bin.<action>.requires-tty` is accepted as declarative metadata, but the CLI currently requires an interactive TTY for every bin action regardless of that value. The gate is unconditional — no environment variable disables it. **Treat the TTY check as advisory, not as proof a human is present**: an agent that can allocate a pseudo-terminal (Node `pty`, Python `pexpect`) will satisfy `process.stdin.isTTY` without any user review. The gate raises the bar against the simplest exfiltration path (`echo $SECRET | autovault skill setup foo`) but does not, on its own, walls off agents from invoking signed bin scripts. The hard boundary is install-time validation + manifest signing, not TTY presence at exec time. See `docs/THREAT-MODEL.md` for the full discussion.

Residual risks the CLI does not protect against: (a) a malicious skill that passes the install-time security scan and then runs legitimately-shaped commands (the user is the gate of last resort — `autovault skill which <name> <action>` prints the resolved script path and full signed argv for review); (b) within-boot PID reuse interacting with a stalled writer (documented in `docs/THREAT-MODEL.md` — manual `.autovault-write-lock` removal is the recourse); (c) an attacker who already holds write access to `$AUTOVAULT_STORAGE_PATH` (same-uid compromise is out of scope for v1 manifest verification).

For the full threat model, including trust boundaries and accepted risks, see [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

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
- remote HTTP/OAuth smoke verification in `scripts/remote-smoke.mjs`
- negative-path probing in `scripts/probe.mjs`
- GitHub Actions CI for build, test, and audit checks

Run locally:

```bash
npm run build
npm test -- --coverage
node scripts/smoke.mjs
node scripts/remote-smoke.mjs
node scripts/probe.mjs
```

## Docker

Docker defaults to the remote service entry point:

```bash
AUTOVAULT_ADMIN_EMAIL=admin@example.com \
AUTOVAULT_ADMIN_PASSWORD=replace-with-a-long-random-password \
docker compose up --build
```

The compose service maps `localhost:3000` to `/mcp` and persists the vault in
the `autovault-data` volume mounted at `/data/autovault`. For local stdio use,
run `node dist/index.js` directly or override the container command.

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
- additional source adapters (ClawHub, LobeHub, Tessl)
- secret resolver (brainstorm pending)
