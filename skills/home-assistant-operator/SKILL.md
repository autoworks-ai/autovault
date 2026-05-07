---
name: home-assistant-operator
description: Bootstrap, inventory, verify, and maintain AutoHub Home Assistant MCP access as a reusable AutoVault skill.
license: MIT
tags: [home-assistant, mcp, smart-home, inventory, autohub]
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
  - path: bin/home-assistant-operator
    type: file
bin:
  setup:
    command: bin/home-assistant-operator
    args: [setup]
    description: Run Home Assistant MCP bootstrap from the target repo.
    requires-tty: true
  doctor:
    command: bin/home-assistant-operator
    args: [doctor]
    description: Verify Home Assistant MCP connectivity and safe sample calls.
    requires-tty: true
  audit:
    command: bin/home-assistant-operator
    args: [audit]
    description: Capture Home Assistant inventory from the target repo.
    requires-tty: true
  sync:
    command: bin/home-assistant-operator
    args: [sync]
    description: Sync Home Assistant MCP config into supported host config.
    requires-tty: true
---

# Home Assistant Operator

## When To Use

Use this skill when enabling, auditing, or verifying Home Assistant access from
AutoHub or another agent host.

## Workflow

```bash
autovault skill setup home-assistant-operator --repo .
autovault skill doctor home-assistant-operator --repo .
autovault skill audit home-assistant-operator --repo .
autovault skill sync home-assistant-operator --repo .
```

## Anti-Patterns

- Do not paste Home Assistant long-lived tokens into chat.
- Do not perform destructive service calls as a smoke test.
- Do not assume a missing entity is gone until the inventory script has run.
