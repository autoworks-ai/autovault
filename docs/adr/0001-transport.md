# ADR 0001: Transport Strategy

- Status: Accepted
- Date: 2026-04-19
- Owners: AutoVault maintainers

## Context

AutoVault exposes curated agent skills to MCP clients (Cursor, Claude Desktop,
custom agents). MCP supports several transports; the codebase historically
mixed stdio entry points with Docker/compose hints (`EXPOSE 3000`,
`restart: unless-stopped`) that suggested a long-running network service.
That inconsistency creates operator confusion and invites unnecessary surface
area (open ports, network auth, TLS, rate limiting).

## Decision

AutoVault is **stdio-first**. The official runtime contract is:

1. The server is a short-lived process spawned by an MCP host.
2. Communication is `StdioServerTransport` over stdin/stdout.
3. stdout is reserved exclusively for MCP framing. Diagnostics go to stderr.
4. No HTTP, SSE, or other network transport ships in v1.

Containers are treated as a build/distribution mechanism, not as a deployment
target for a detached daemon. Docker Compose is a developer convenience, not
a production deployment recipe.

## Fallback Trigger

A network transport will only be reconsidered if all of the following are true:

- A concrete operator requirement exists for multi-client/remote access.
- An auth, transport security, and rate-limiting design is approved.
- Threat model is updated to cover the network attack surface.

Until then, network transport work is out of scope.

## Consequences

- Dockerfile must not advertise an HTTP port.
- README and SKILL.md must describe stdio invocation, not detached daemons.
- Logging must use stderr only; any stdout write breaks MCP framing.
- CI does not need to perform smoke tests against an HTTP endpoint.
