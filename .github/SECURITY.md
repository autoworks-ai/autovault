# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AutoVault, please **do not** open a public issue.

Instead, report it privately via [GitHub Security Advisories](https://github.com/autoworks-ai/autovault/security/advisories/new). We aim to respond within 3 business days.

## Supported Versions

While AutoVault is in pre-1.0 development, only the latest minor release on the
default branch receives security updates. Older versions may be patched on a
case-by-case basis.

## Disclosure Policy

We follow coordinated disclosure: we'll work with you on a fix and credit you
in the release notes if you wish.

## Scope

AutoVault validates, signs, scopes, and serves `SKILL.md` files through both a
local stdio MCP server and a remote Streamable HTTP MCP service. Vulnerabilities
of particular interest:

- Bypass of the validation pipeline ([src/validation/](../src/validation/))
  — schema, security denylist, capability cross-check, or dedup tiers
- Path-traversal or signing-verification weaknesses in
  [src/storage/](../src/storage/)
- Prompt-injection or untrusted-content handling in source adapters
  ([src/sources/](../src/sources/))
- OAuth, PKCE, token rotation, role, or scope bypasses in the remote HTTP MCP
  surface ([src/remote/](../src/remote/))
- Admin bootstrap, SQLite persistence, or `AUTOVAULT_PUBLIC_URL` issuer
  validation weaknesses in remote deployments

See [docs/THREAT-MODEL.md](../docs/THREAT-MODEL.md) for the trust boundaries
and abuse-case mapping.
