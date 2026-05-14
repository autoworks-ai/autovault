# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
while it remains in pre-1.0 development.

## [0.3.0](https://github.com/autoworks-ai/autovault/compare/v0.2.1...v0.3.0) (2026-05-14)


### Features

* **cli:** add remove command for vaulted skills ([#56](https://github.com/autoworks-ai/autovault/issues/56)) ([61cf25a](https://github.com/autoworks-ai/autovault/commit/61cf25a2a587d3e8f225054ac6af2fccfddd4129))
* **doctor:** add --repair for unsigned local skills; dedupe signature warnings ([#51](https://github.com/autoworks-ai/autovault/issues/51)) ([0c0d78a](https://github.com/autoworks-ai/autovault/commit/0c0d78acfcfbfbd47201f96eb0e96ca16b089650))
* **profiles:** add tag-filtered project profiles ([#50](https://github.com/autoworks-ai/autovault/issues/50)) ([386f4cc](https://github.com/autoworks-ai/autovault/commit/386f4cc5b7240e9645605c913b96f051ee7f5610))
* **skills:** harden v1 migration imports ([#41](https://github.com/autoworks-ai/autovault/issues/41)) ([4a3475a](https://github.com/autoworks-ai/autovault/commit/4a3475ad0750496cc362701639a2338b8c950157))


### Bug Fixes

* **cli:** smooth onboarding setup and serve UX ([#58](https://github.com/autoworks-ai/autovault/issues/58)) ([aa90ee5](https://github.com/autoworks-ai/autovault/commit/aa90ee56ee07c523125880cb8d21c58f9cc91e64))
* **installer:** resolve TTY, Node version, and setup wizard friction ([#48](https://github.com/autoworks-ai/autovault/issues/48)) ([3c23d46](https://github.com/autoworks-ai/autovault/commit/3c23d46b4bb841a218521c6f89fc94191b035392))

## [Unreleased]

### Added
- Named profiles can opt in to emitting a Claude Code `skillOverrides` block
  alongside the project-local symlink farm. Without this, the per-project
  `<project>/.claude/skills/` symlinks are purely additive to
  `~/.claude/skills/` — Claude Code merges both sources, so the manifest a
  project sees never shrinks. Set `export_skill_overrides: true` on a
  `claude-code` profile to write `<dirname(target)>/settings.json` with
  `"<slug>": "off"` for every claude-code skill the profile's tag filter
  excluded. A string value resolves to an explicit settings path (relative
  paths anchor at `dirname(target)`).
- AutoVault owns the `skillOverrides` key for managed projects — manual
  edits to that key are overwritten on next sync. Other top-level keys
  (`mcpServers`, `env`, hooks, etc.) are preserved verbatim. Plugin-namespaced
  skills (`foo:bar`) are intentionally never written — Claude Code's
  `skillOverrides` does not affect plugin skills (manage those via `/plugin`).

## [0.2.1] - 2026-05-09

### Added
- Three bundled skills shipping with AutoVault, all generic and
  dependency-free:
  - `autovault-skill` — meta-skill explaining how to discover and
    propose skills via AutoVault's MCP surface.
  - `commit-message` — drafts a conventional-commit message from the
    repository's staged changes (Bash-only, `network: false`).
  - `skill-author` — walks through authoring a valid SKILL.md with
    correct frontmatter and capability declarations
    (`filesystem: readwrite`, tools: `[Read, Edit, Write]`).
  All three pass the full validation gate cleanly.
- `scripts/bootstrap-skills.mjs` seeds every bundled skill into
  `$AUTOVAULT_STORAGE_PATH` via the real `install_skill` validation path.
  Supersedes the single-purpose `install-meta-skill.mjs`.
- `INSTALL.md` with complete setup instructions for Claude Code, Cursor, and
  Codex MCP hosts, plus verification and troubleshooting sections.
- Three-tier deduplication in `propose_skill`: exact content-hash match,
  near-exact similarity (≥0.9), and functional-overlap warning (≥0.75).
  Novel proposals accept without friction; functional matches accept with a
  warning pointing at the similar skill.
- Capability-declaration cross-check in the validation gate. A skill
  declaring `network: false` that contains `curl`/`wget`/`fetch` is blocked;
  a `tools: [Bash]`-only skill that invokes Python/Node is blocked;
  `filesystem: readonly` with writes to `~/`, `/etc/`, or `/tmp/` is blocked.
- Ed25519 signing via `tweetnacl`. Every installed skill gets a detached
  `.autovault-signature` sidecar signed with a keypair stored at
  `$AUTOVAULT_STORAGE_PATH/.signing-key.json` (0600). Verification is
  log-only in this release — tampering warns but does not block reads.
- Expanded security denylist (now 12 patterns): AWS credential reads, wget
  pipe-to-shell, hex-decoded shell execution, `eval $VAR`, setuid/setgid
  chmod, and `--insecure`/`--no-check-certificate` flags.
- Capability resolver layer backed by SQLite (tools, MCP servers, profiles,
  callers, aliases, context rules), exposed via `resolveCapabilities()`.
- Remote Streamable HTTP MCP service (`dist/remote.js`) with OAuth dynamic
  client registration, PKCE, and role-aware tool access.
- Vault-local skill transforms: per-agent overlays applied on top of upstream
  skill content without forking the source.
- `autovault add-local` for installing a local skill bundle through the same
  validation/signing pipeline used for remote sources.
- `autovault audit-repo` to classify repo-local scripts, tools, workflows, and
  shims for migration into AutoVault skills.
- `autovault setup` interactive wizard and polished installer/doctor flow.
- Container image publishing to GHCR on GitHub Release (`docker-publish.yml`)
  with provenance + SBOM, multi-arch (linux/amd64, linux/arm64).
- npm publishing readiness: `@autoworks-ai/autovault` scope, `files`
  allowlist, `publishConfig.access: public`, `prepublishOnly` test gate.

### Changed
- `propose_skill` response shape: successful proposals now include a
  `dedup: { tier, similarity, similar_to }` block so callers can see the
  near-miss context even on acceptance. `duplicate` outcomes carry a
  `match_type` of `exact` or `near_exact` to distinguish hash matches from
  similarity matches.
- README updated to reflect the signing sidecar, storage layout, validation
  capabilities, and the new bootstrap workflow.
- Simplified the MCP tool surface to the core skill lifecycle operations.
- Aligned the Node engine floor across runtime, package.json, and CI.

### Removed
- Dead empty `skills.lock` file. AutoVault tracks provenance via per-skill
  sidecars; `skills.lock` was never read or written by the implementation.
- `scripts/install-meta-skill.mjs` (superseded by `bootstrap-skills.mjs`).

## [0.2.0] - 2026-04-19

### Added
- Stdio-only MCP server runtime for AutoVault with tools for listing, searching,
  retrieving, proposing, installing, reading resources, and checking updates.
- Typed environment configuration with fail-fast validation.
- Filesystem-backed storage for skills plus `.autovault-source.json` provenance
  sidecars and content hashing for drift detection.
- Source adapters for GitHub, `agentskills`, and arbitrary `https` URLs.
- Validation pipeline: frontmatter repair/parsing, zod schema checks,
  denylist-based content scanning, and similarity-based duplicate detection.
- Threat model (`docs/THREAT-MODEL.md`), transport ADR
  (`docs/adr/0001-transport.md`), release guide (`docs/RELEASE.md`), and
  AutoVault meta-skill documentation.
- Automated test harness, smoke/probe scripts, and source-adapter regression
  tests.

### Changed
- Replaced the previous `skill-manager` / `skill-importer` scaffold with a
  focused TypeScript MCP server implementation.
- Standardized on a stdio-first deployment story across `README.md`,
  `Dockerfile`, and `docker-compose.yml`.
- Structured logging now honors `AUTOVAULT_LOG_LEVEL` across all log levels.
- Source fetching is hardened:
  - `url` fetches enforce `https` across every redirect hop.
  - GitHub `@HEAD` fetches fail fast when SHA resolution fails instead of
    guessing `main`.

### Security
- Security patterns now come from a single source of truth:
  `scripts/security/patterns.json`.
- Tool boundaries validate skill names to block traversal attempts.
- `propose_skill` pre-validates resource paths before any write so invalid
  proposals do not partially persist on disk.
- Invalid config values such as typo'd booleans now fail fast at startup.

### Removed
- Direct `js-yaml` and `@types/js-yaml` dependencies; `gray-matter` continues to
  supply YAML parsing transitively.

## Notes
- `tweetnacl` remains intentionally present for the documented signed-bundle
  roadmap; signature enforcement is not yet implemented in this release.
