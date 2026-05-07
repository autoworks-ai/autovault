---
name: raycast-autojack
description: Install, verify, and operate AutoJack Raycast scripts as a reusable AutoVault-managed desktop capability.
license: MIT
tags: [raycast, autojack, desktop, voice, install]
agents: [claude-code, codex, autojack]
category: desktop
metadata:
  version: "1.0.0"
capabilities:
  network: true
  filesystem: readwrite
  tools: [Bash, Node]
requires-secrets: []
resources:
  - path: bin/raycast-autojack
    type: file
bin:
  setup:
    command: bin/raycast-autojack
    args: [setup]
    description: Install AutoJack Raycast scripts from the target repo.
    requires-tty: true
  doctor:
    command: bin/raycast-autojack
    args: [doctor]
    description: Verify Raycast scripts and local desktop prerequisites.
    requires-tty: true
  sync:
    command: bin/raycast-autojack
    args: [sync]
    description: Refresh Raycast symlinks from the target repo.
    requires-tty: true
  smoke:
    command: bin/raycast-autojack
    args: [smoke]
    description: Run safe Raycast helper smoke checks.
    requires-tty: true
---

# Raycast AutoJack

## When To Use

Use this skill when installing or checking AutoJack Raycast commands such as
voice note capture, quick reply, context reply, and summon AutoJack.

## Workflow

```bash
autovault skill doctor raycast-autojack --repo .
autovault skill setup raycast-autojack --repo .
autovault skill sync raycast-autojack --repo .
autovault skill smoke raycast-autojack --repo .
```

The setup and sync paths use the repo's Raycast installers so local host
permissions, symlink conventions, and script metadata stay consistent.

## Anti-Patterns

- Do not ask the user to paste API keys into chat.
- Do not rewrite Raycast scripts during setup; this skill packages operation,
  not product implementation.
- Do not assume Accessibility permission is granted; report it as a host setup
  item when auto-paste fails.
