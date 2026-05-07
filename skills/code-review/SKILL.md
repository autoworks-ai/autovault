---
name: code-review
description: Run AutoHub-style local Copilot review gates and review-fix orchestration before commits or pull requests.
license: MIT
tags: [github, copilot, review, ci, autohub]
agents: [claude-code, codex, autojack]
category: review
metadata:
  version: "1.0.0"
capabilities:
  network: true
  filesystem: readwrite
  tools: [Bash, Node]
requires-secrets: []
resources:
  - path: bin/code-review
    type: file
bin:
  run:
    command: bin/code-review
    args: [run]
    description: Run the repo's primary local review gate.
    requires-tty: true
  audit:
    command: bin/code-review
    args: [audit]
    description: Inspect review helper availability without changing files.
    requires-tty: true
  doctor:
    command: bin/code-review
    args: [doctor]
    description: Verify local review prerequisites.
    requires-tty: true
---

# Code Review

## When To Use

Use this skill before creating or updating a PR when the repo has AutoHub-style
Copilot review helpers, or when the user asks to run the local AI review gate.

## Workflow

```bash
autovault skill doctor code-review --repo .
autovault skill run code-review --repo .
```

The run path uses the repo's `scripts/copilot-review.js` helper. Pass `--ci`
when the repo's primary review gate should run in CI-compatible mode. If a P1
finding appears, fix it and run the gate once more.

## Anti-Patterns

- Do not skip local review because GitHub-side review is pending.
- Do not run review tools that mutate files unless the user asked for fixes.
- Do not include raw tokens from GitHub or review providers in output.
