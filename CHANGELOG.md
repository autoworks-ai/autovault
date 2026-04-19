# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
while it remains in pre-1.0 development.

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
