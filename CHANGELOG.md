# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
while it remains in pre-1.0 development.

## [0.5.0](https://github.com/autoworks-ai/autovault/compare/v0.4.0...v0.5.0) (2026-08-26)


### Features

* **add:** unify skill add UX ([#86](https://github.com/autoworks-ai/autovault/issues/86)) ([0fb5c5b](https://github.com/autoworks-ai/autovault/commit/0fb5c5b09339d7bda69f032f061a2e8dd4b04e07))
* **cli:** add autovault link with Cloud slug expansion ([#125](https://github.com/autoworks-ai/autovault/issues/125)) ([35361af](https://github.com/autoworks-ai/autovault/commit/35361af156ebd89219c3b0f14817be5824780104))
* **cli:** harden update UX ([#83](https://github.com/autoworks-ai/autovault/issues/83)) ([8245c5e](https://github.com/autoworks-ai/autovault/commit/8245c5efe904945e62f6b5dccd2813f03e96db9f))
* **cli:** repair add-local frontmatter interactively ([#77](https://github.com/autoworks-ai/autovault/issues/77)) ([b76c67c](https://github.com/autoworks-ai/autovault/commit/b76c67cd2a844d924c140634d1c86cfd3e1d6699))
* **cli:** show update notice in version output ([#79](https://github.com/autoworks-ai/autovault/issues/79)) ([83157c6](https://github.com/autoworks-ai/autovault/commit/83157c6b191c0dcf7c1bbc2e64c1c90ebd96687d))
* **cli:** start Cloud pairing from autovault link with no argument ([#129](https://github.com/autoworks-ai/autovault/issues/129)) ([862db03](https://github.com/autoworks-ai/autovault/commit/862db0345f8031a4b4037b03d6e1d1f76867ba47))
* **doctor:** verify Codex render fidelity ([#108](https://github.com/autoworks-ai/autovault/issues/108)) ([60fed11](https://github.com/autoworks-ai/autovault/commit/60fed1181bc51332f57d37f6cf51325eb0616019))
* **skills:** harden bundle imports and provenance ([#109](https://github.com/autoworks-ai/autovault/issues/109)) ([06e232d](https://github.com/autoworks-ai/autovault/commit/06e232d7a832ecfd2da953114b4078e849d0ad47))
* **sync:** enroll HTTPS signed catalogs ([#124](https://github.com/autoworks-ai/autovault/issues/124)) ([5f124e6](https://github.com/autoworks-ai/autovault/commit/5f124e605c431b0d0d9aef201a8f5fbbf50e4b7f))
* **ui:** add local dashboard and signed delivery ([#82](https://github.com/autoworks-ai/autovault/issues/82)) ([9156798](https://github.com/autoworks-ai/autovault/commit/9156798fe44222dcfe2e701b5d14c4816995f553))
* **ui:** add management dashboard and signed sync ([#84](https://github.com/autoworks-ai/autovault/issues/84)) ([11becaa](https://github.com/autoworks-ai/autovault/commit/11becaa60a4013c4f04b29d0c4f38813dbd45cf1))
* **ui:** share skill template across surfaces and report add-skill outcomes ([#87](https://github.com/autoworks-ai/autovault/issues/87)) ([b166b2f](https://github.com/autoworks-ai/autovault/commit/b166b2f164016bf74f758d87f6e2d1262ba8ea68))


### Bug Fixes

* **ci:** always squash dependabot auto-merge so PRs enter the merge queue ([#94](https://github.com/autoworks-ai/autovault/issues/94)) ([df9dad0](https://github.com/autoworks-ai/autovault/commit/df9dad08bfe76a0fea1465a60165bb0d297b6777))
* **ci:** restore production npm audit gate ([#120](https://github.com/autoworks-ai/autovault/issues/120)) ([9c4b5da](https://github.com/autoworks-ai/autovault/commit/9c4b5daa97293195ed0de0eed852820b109912d1))
* **ci:** use app token for docs drift ([#75](https://github.com/autoworks-ai/autovault/issues/75)) ([262ee94](https://github.com/autoworks-ai/autovault/commit/262ee94d4bdee2829d8d4157b62d24153948fc31))
* **cli:** treat unpublished Cloud catalogs as a waiting state ([#126](https://github.com/autoworks-ai/autovault/issues/126)) ([61dd24c](https://github.com/autoworks-ai/autovault/commit/61dd24c3b1cb0da01159e7fe6b15e13997397527))
* exit orphaned stdio MCP servers on parent death ([#114](https://github.com/autoworks-ai/autovault/issues/114)) ([588160c](https://github.com/autoworks-ai/autovault/commit/588160c0d62560c3bed4a133a4053ebbd1357a4d))
* **sync:** default omitted pairing interval and OS pairing lock ([#132](https://github.com/autoworks-ai/autovault/issues/132)) ([e761045](https://github.com/autoworks-ai/autovault/commit/e76104506348beb1e703fd8d606eee07369ae367))

## [0.4.0](https://github.com/autoworks-ai/autovault/compare/v0.3.0...v0.4.0) (2026-05-22)


### Features

* **cli:** improve install and setup review UX ([#65](https://github.com/autoworks-ai/autovault/issues/65)) ([9227df4](https://github.com/autoworks-ai/autovault/commit/9227df40332034631ff430791e363996615dff81))
* **skills:** add agentgonewild-publisher community skill ([#66](https://github.com/autoworks-ai/autovault/issues/66)) ([adb4b95](https://github.com/autoworks-ai/autovault/commit/adb4b95bfe68d8a309618ebbe67a43fc784fd1d1))


### Bug Fixes

* **ci:** retry dependabot automerge after CI ([#64](https://github.com/autoworks-ai/autovault/issues/64)) ([ad80579](https://github.com/autoworks-ai/autovault/commit/ad805798e5ebecc3d5baab5eb3c17d2e7d9af0b8))
* **cli:** smooth add-local local imports ([#60](https://github.com/autoworks-ai/autovault/issues/60)) ([443eac7](https://github.com/autoworks-ai/autovault/commit/443eac765f72377ba1380d608d722a0fdc6a0848))
* **cli:** standardize public output ([#71](https://github.com/autoworks-ai/autovault/issues/71)) ([40cfbd8](https://github.com/autoworks-ai/autovault/commit/40cfbd858d2c03ae91cc345194f094ee305cc93a))
* **deps:** align node typings with runtime policy ([#67](https://github.com/autoworks-ai/autovault/issues/67)) ([ca06e74](https://github.com/autoworks-ai/autovault/commit/ca06e74ef67fba2685c4fbfa74c01d13f397ea95))

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
- `autovault doctor` now reports `plugin-shadowed` warnings when Cursor or
  Claude Code plugin caches contain a `SKILL.md` name that collides with an
  installed vault skill. JSON includes per-skill `plugin_shadows` records and
  `summary.plugin_shadowed`; AutoVault never changes host plugins.
- HTTPS catalog enrollment for AutoVault Cloud. `autovault init
  https://autovault.dev/v/<slug>` POSTs a device public key, stores it pending
  until the owner admits the device, then discovers and installs signed
  releases from `catalog.json` and `bundles/<bundle_hash>.json`. Requests are
  signed with the device key (`X-AutoVault-Device` / `-Timestamp` /
  `-Signature`). Beta limitation: rotating the publishing key requires every
  device to re-enroll.
- `autovault link` with no argument starts RFC 8628-shaped Cloud pairing:
  the CLI prints a confirmation code, opens `/cloud/pair`, and learns its
  slug after the owner confirms. `autovault link <slug>` remains the
  fallback for older enrollments (`init` stays an alias). Slugs expand to
  `https://autovault.dev/v/<slug>`; override the origin with
  `AUTOVAULT_CLOUD_ORIGIN`. On a TTY the command waits for confirm/admit.
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

### Changed
- Local write paths now sync generated profiles and discover known host roots by
  default. `--no-sync-profiles` / `sync_profiles: false` and
  `--no-discover` / `discover_profile_roots: false` remain explicit opt-outs.
- `autovault sync-profiles` and skill deletion now discover existing host
  skill roots by default. Use `--no-discover` or
  `discover_profile_roots: false` for an explicit opt-out. MCP `delete_skill`
  now exposes `discover_profile_roots` and `profile_roots`.

### Fixed
- `autovault sync-profiles --help` now exits successfully after printing usage
  without running a sync.
- Doctor no longer recommends reinstalling a tampered local skill from its own
  vault directory; it tells operators to copy the bundle out first while
  retaining `doctor --repair` as the intentional recovery path.

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
