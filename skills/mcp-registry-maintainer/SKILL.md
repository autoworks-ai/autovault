---
name: mcp-registry-maintainer
description: Maintain AutoHub MCP server configuration, tool registry scans, health checks, and host config repair through a standardized AutoVault skill.
license: MIT
tags: [mcp, registry, tools, autohub, diagnostics]
agents: [claude-code, codex, autojack]
category: operations
metadata:
  version: "1.0.0"
capabilities:
  network: true
  filesystem: readwrite
  tools: [Bash, Node]
requires-secrets: []
resources:
  - path: bin/mcp-registry-maintainer
    type: file
bin:
  doctor:
    command: bin/mcp-registry-maintainer
    args: [doctor]
    description: Run MCP health diagnostics from the target repo.
    requires-tty: true
  sync:
    command: bin/mcp-registry-maintainer
    args: [sync]
    description: Refresh the MCP tool registry from configured servers.
    requires-tty: true
  setup:
    command: bin/mcp-registry-maintainer
    args: [setup]
    description: Run MCP config setup or repair helpers.
    requires-tty: true
  audit:
    command: bin/mcp-registry-maintainer
    args: [audit]
    description: Validate workflow references against the MCP registry.
    requires-tty: true
---

# MCP Registry Maintainer

## When To Use

Use this skill when the user wants to refresh AutoHub's MCP tool registry,
check server health, repair host MCP configuration, or diagnose workflow/tool
drift.

## Workflow

```bash
autovault skill doctor mcp-registry-maintainer --repo .
autovault skill sync mcp-registry-maintainer --repo .
autovault skill setup mcp-registry-maintainer --repo . --task cursor
autovault skill audit mcp-registry-maintainer --repo .
```

## Output

Report which registry/config helper ran, which repo was targeted, and any
server names that need manual attention. Do not print resolved secret values.

## Anti-Patterns

- Do not edit host MCP config by hand when a repo helper exists.
- Do not treat a stale registry as proof that a server lacks a tool; rescan
  first.
