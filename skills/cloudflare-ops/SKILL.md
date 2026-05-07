---
name: cloudflare-ops
description: Operate AutoHub-style Cloudflare deploy, D1, Worker, Pages, tunnel, and production preflight workflows from a standardized AutoVault skill.
license: MIT
tags: [cloudflare, d1, pages, workers, tunnel, autohub, deployment]
agents: [claude-code, codex, autojack]
category: deployment
metadata:
  version: "1.0.0"
capabilities:
  network: true
  filesystem: readwrite
  tools: [Bash, Node]
requires-secrets: []
resources:
  - path: bin/cloudflare-ops
    type: file
bin:
  setup:
    command: bin/cloudflare-ops
    args: [setup]
    description: Check Cloudflare/Wrangler prerequisites for an AutoHub-style repo.
    requires-tty: true
  doctor:
    command: bin/cloudflare-ops
    args: [doctor]
    description: Run non-mutating Cloudflare and D1 repo checks.
    requires-tty: true
  run:
    command: bin/cloudflare-ops
    args: [run]
    description: Dispatch a Cloudflare operator task with --task.
    requires-tty: true
  sync:
    command: bin/cloudflare-ops
    args: [sync]
    description: Run D1 sync helpers from the target repo.
    requires-tty: true
  migrate:
    command: bin/cloudflare-ops
    args: [migrate]
    description: Run D1 migration helpers from the target repo.
    requires-tty: true
  dry-run:
    command: bin/cloudflare-ops
    args: [dry-run]
    description: Print the Cloudflare command that would run.
    requires-tty: true
---

# Cloudflare Ops

## When To Use

Use this skill when the user asks to deploy an AutoHub-style project to
Cloudflare, run Pages or Worker preflights, operate D1 migrations/sync, manage
the local Cloudflare tunnel helper, or standardize repo-local Cloudflare hacks.

## Preconditions

- The target repo is passed with `--repo <path>`.
- Wrangler/cloudflared credentials stay outside chat and source control.
- Billable Cloudflare actions still require explicit user confirmation in the
  conversation before the agent runs them.

## Workflow

1. Run a preflight first:

```bash
autovault skill doctor cloudflare-ops --repo .
```

2. Use `dry-run` before any mutation:

```bash
autovault skill dry-run cloudflare-ops --repo . --task deploy-pages
```

3. Dispatch supported tasks through the signed wrapper:

```bash
autovault skill run cloudflare-ops --repo . --task deploy-pages -- --slug=my-site --dir=dist
autovault skill migrate cloudflare-ops --repo . --target local
autovault skill sync cloudflare-ops --repo . --mode sidecar
autovault skill run cloudflare-ops --repo . --task tunnel-start
```

## Supported Tasks

- `deploy-pages`
- `setup-d1`
- `tunnel-setup`
- `tunnel-start`
- D1 migration targets: `local`, `remote`
- D1 sync modes: `sidecar`, `daemon`, `backfill`, `parity`

## Output

Report the repo, task, exact helper invoked, and whether the run was a dry run.
Only report secret names or provider-side secret references, never raw values.

## Anti-Patterns

- Do not manually copy Cloudflare tokens into project files.
- Do not register domains or create billable resources without explicit user
  confirmation.
- Do not bypass the repo helper scripts when they already encode project
  conventions.
