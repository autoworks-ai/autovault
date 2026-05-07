# ADR 0001: Transport Strategy

- Status: Accepted, amended for remote service mode
- Date: 2026-04-19
- Owners: AutoVault maintainers

## Context

AutoVault exposes curated agent skills to MCP clients (Cursor, Claude Desktop,
custom agents). MCP supports stdio for local hosts and Streamable HTTP for
remote clients. The original decision made AutoVault stdio-only to avoid a
network surface before there was an auth and deployment design.

There is now a concrete operator requirement for a managed/shared vault:
professional organizations want one deployed vault, persistent storage, and
role-aware access to a curated skill set. Remote MCP also unlocks clients that
cannot spawn a local process.

## Decision

AutoVault is **stdio-first locally** and **Streamable HTTP for remote service
deployments**.

The local runtime contract remains:

1. The server is a short-lived process spawned by an MCP host.
2. Communication is `StdioServerTransport` over stdin/stdout.
3. stdout is reserved exclusively for MCP framing. Diagnostics go to stderr.
4. No auth is required because the spawning user/host is the trust boundary.

The remote runtime contract is:

1. `dist/remote.js` serves MCP at `/mcp` using Streamable HTTP.
2. OAuth metadata, dynamic client registration, auth-code + PKCE, refresh
   tokens, and revocation are served by AutoVault itself.
3. Remote storage lives under a persistent volume such as `/data/autovault`.
4. Remote tool calls are authorized by role and scopes. Owners can read/write;
   non-owners are filtered through capability groups and declared skill tool
   requirements.
5. Remote profile sync is not supported. A remote server cannot create symlinks
   on client machines.

Docker and Railway deployments use the remote entry point by default. Local
stdio remains `dist/index.js` and is not routed through HTTP.

## Consequences

- Dockerfile advertises the remote service port and defaults to
  `node dist/remote.js`.
- README and INSTALL must describe both local stdio invocation and remote
  Docker/Railway deployment.
- Logging must use stderr only; any stdout write breaks MCP framing.
- HTTP routes need auth, origin validation, and tests.
- Remote clients use MCP discovery/read tools directly; `sync-profiles` remains
  local-only.
