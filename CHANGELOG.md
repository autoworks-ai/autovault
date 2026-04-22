# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
while it remains in pre-1.0 development.

## [Unreleased]

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

### Changed
- `propose_skill` response shape: successful proposals now include a
  `dedup: { tier, similarity, similar_to }` block so callers can see the
  near-miss context even on acceptance. `duplicate` outcomes carry a
  `match_type` of `exact` or `near_exact` to distinguish hash matches from
  similarity matches.
- README updated to reflect the signing sidecar, storage layout, validation
  capabilities, and the new bootstrap workflow.

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
