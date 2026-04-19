# AutoVault Threat Model

- Status: v1 (review by 2026-07-01)
- Owner: AutoVault maintainers
- Scope: AutoVault MCP server (stdio transport), local storage, and the
  remote source adapters (`github`, `agentskills`, `url`).

AutoVault stores and serves skill content. It does **not** execute skills.
The agent that consumes a skill is responsible for sandboxing, capability
checks, and user confirmation for any actions described in the skill.

## Trust Boundaries

1. **Host process boundary** - The MCP host (e.g. Cursor) is fully trusted
   to spawn the AutoVault process. Anyone who can launch the binary can
   invoke any tool. There is no in-process auth.
2. **Local storage boundary** - `AUTOVAULT_STORAGE_PATH` is treated as a
   trusted directory owned by the running user. AutoVault writes only under
   this path.
3. **Remote source boundary** - GitHub, agentskills.io, and arbitrary
   `https` URLs are **untrusted** content sources. Their bytes are subject
   to validation before persistence.

## Assets

- Skill content (`SKILL.md`, resources) - integrity matters; tampering can
  mislead downstream agents.
- Source provenance (`.autovault-source.json`) - integrity matters; used
  for drift checks.
- Operator credentials (e.g. `GITHUB_TOKEN`) - confidentiality matters.

## Abuse Cases and Mitigations

| ID | Abuse Case | Mitigation |
|----|------------|------------|
| A1 | Malicious skill includes shell commands intended to exfiltrate or destroy | Security denylist (`scripts/security/patterns.json`); strict mode blocks installs; agent is still responsible for execution decisions. |
| A2 | Path traversal via `read_skill_resource` or proposed resource paths | Reject absolute paths and `..`; resolve under skill root and re-check prefix. |
| A3 | Path traversal via skill name (e.g. `../etc`) | Reject names containing `/` or `..` at the tool boundary. |
| A4 | Source spoofing (a URL or repo serving different bytes on each fetch) | Persist content hash + upstream sha; `check_updates` reports drift. |
| A5 | Resource exhaustion via huge remote payloads | Operator responsibility; future work: per-fetch byte cap. |
| A6 | Credential leakage via logs | Logs are structured stderr only; tokens are never logged; values such as identifiers are logged but never auth headers. |
| A7 | Dependency supply chain compromise | `npm ci` in CI; `npm audit` gate; pin Node 20 in CI matrix. |
| A8 | Misconfiguration (typo'd env vars) | `loadConfig` uses zod; invalid values fail fast at startup. |

## Accepted Risks

- AutoVault does not currently verify cryptographic signatures on remote
  skills. Operators relying on agentskills.io or arbitrary URLs are
  responsible for source trust.
- Security denylist is **assistive**, not exhaustive. It is intended to
  catch common abuse patterns and force review on flagged content.
- The agent that consumes a skill is the final authority on execution and
  must enforce capability/secret prompts.

## Review Cadence

- Re-review on any new source adapter, new transport, or significant
  validation change.
- Re-review at least every six months.
