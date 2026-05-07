---
name: autojack-blog-publisher
description: Prepare, trigger, and audit subject-focused AutoJack blog runs with citations, charts, WordPress media uploads, and direct SVG embeds.
license: MIT
tags: [autojack, blog, wordpress, workflow, publishing, autohub]
agents: [claude-code, codex, autojack]
category: publishing
metadata:
  version: "1.0.0"
capabilities:
  network: true
  filesystem: readwrite
  tools: [Bash, Node]
requires-secrets: []
resources:
  - path: bin/autojack-blog
    type: file
bin:
  run:
    command: bin/autojack-blog
    args: [run]
    description: Trigger the AutoJack blog workflow from a target AutoHub repo.
    requires-tty: true
  audit:
    command: bin/autojack-blog
    args: [audit]
    description: Validate blog workflow and publishing prerequisites.
    requires-tty: true
  dry-run:
    command: bin/autojack-blog
    args: [dry-run]
    description: Emit the AutoJack blog prompt without publishing.
    requires-tty: true
---

# AutoJack Blog Publisher

## When To Use

Use this skill when the user asks to run, test, package, or review the AutoJack
daily blog workflow, especially when a concrete `blog_subject` should be passed
into the workflow.

## Workflow

```bash
autovault skill audit autojack-blog-publisher --repo .
autovault skill dry-run autojack-blog-publisher --repo . --subject "AutoVault skills"
autovault skill run autojack-blog-publisher --repo . --subject "AutoVault skills"
```

## Output

Report the workflow mode, subject, repo path, and whether the run published or
only emitted a prompt. Cite workflow validation failures precisely.

## Anti-Patterns

- Do not invent registry entries that the workflow or memory did not provide.
- Do not paste WordPress credentials or webhook secrets into chat.
- Do not publish when the user asked only for prompt/audit mode.
