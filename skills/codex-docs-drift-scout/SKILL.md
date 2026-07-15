---
name: codex-docs-drift-scout
description: Install the AutoHub docs-drift Codex automation from signed AutoVault skill resources and audit its render fidelity with autovault doctor.
license: MIT
tags: [codex, automation, docs, autohub, drift]
agents: [codex, autojack]
category: automation
metadata:
  author: AutoVault
  version: "0.1.0"
  source: https://github.com/autoworks-ai/autovault
risk_level: elevated
capabilities:
  network: true
  filesystem: readwrite
  tools: [Bash, Git, GitHub, Node, npm, Python]
requires-secrets: []
resources:
  - path: bin/codex-bundle
    type: file
  - path: resources/codex/automation.toml.tpl
    type: file
  - path: resources/codex/environment.toml.tpl
    type: file
bin:
  install-codex:
    command: bin/codex-bundle
    args: [install]
    description: Render docs-drift Codex automation files under AutoVault, symlink them into Codex, and record the render index for auditing.
    requires-tty: true
---

# Codex Docs Drift Scout

## When To Use

Use this skill to install the AutoHub docs-drift Codex automation. The automation
lives as signed AutoVault skill resources (`.tpl` templates), but Codex reads
machine-local **rendered** files through a symlink.

Install is a deliberate, human-initiated mutation (it renders machine-specific
files and plants a symlink under `~/.codex`), so it sits behind the
`requires-tty` anti-automation wall. Auditing is read-only and runs
non-interactively through `autovault doctor` — see [Audit](#audit).

## Install

`--project-root` is required and has no shipped default. Pass the absolute path
to the target repository:

```bash
autovault skill install-codex codex-docs-drift-scout --project-root /ABSOLUTE/PATH/TO/autohub
```

The complete install surface is:

```text
autovault skill install-codex codex-docs-drift-scout --project-root PATH [--automation-id ID] [--replace-existing]
```

By default, the helper renders beneath `${AUTOVAULT_STORAGE_PATH:-~/.autovault}`:

```text
~/.autovault/rendered/codex-automations/docs-drift-scout/automation.toml
~/.autovault/rendered/codex-automations/docs-drift-scout/environment.toml
```

and exposes the rendered directory beneath `${CODEX_HOME:-~/.codex}` as:

```text
~/.codex/automations/docs-drift-scout
```

The helper refuses to replace an existing non-symlink Codex automation path
unless `--replace-existing` is passed. Replacement moves the existing path aside
with a timestamped `.backup.<timestamp>` suffix.

Before writing, the helper refuses a corrupt or unsupported existing render
index. It renders to temporary files, parses the TOML with `python3` +
`tomllib`, then atomically publishes the index and Codex symlink. The
machine-local index is `${AUTOVAULT_STORAGE_PATH:-~/.autovault}/render-index.json`
— the per-bundle record `autovault doctor` hash-compares against. `python3` is
required.

### Substitution variables

The signed templates carry no machine-specific paths. The helper substitutes
these placeholders at render time, so no personal absolute path is ever baked
into the signed bytes:

- `{{PROJECT_ROOT_TOML}}` — the TOML-escaped `--project-root` you pass.
- `{{ENVIRONMENT_PATH_TOML}}` — the TOML-escaped rendered environment path.
- `{{AUTOMATION_ID}}` — the Codex automation id (default `docs-drift-scout`).
- `{{RENDERED_AT_MS}}` — the current install time in Unix milliseconds.

## Audit

Render fidelity is a first-class, non-interactive `autovault doctor` check — not
a separate bin action. It re-verifies the signed templates and hash-compares the
rendered files and `~/.codex` symlink against the render index. It never
re-renders.

```bash
autovault doctor codex-docs-drift-scout --json
```

`doctor` reports each skill's render fidelity as a first-class field. For this
bundle, assert:

```text
.skills[] | select(.name == "codex-docs-drift-scout") | .render.kind == "ok"
```

`doctor` exits non-zero when any error is present, but a cron/Codex preflight
that wants "my automation is actually installed AND verified" **must positively
assert `render.kind == "ok"`** — not exit code and not the skill's overall
`status`. A never-rendered install reports `render.kind == "skipped"`, which
leaves both `status` and the exit code clean.

The check verifies, per recorded bundle:

- the signed templates are authentic and unchanged since render (catches a
  template edited without reinstalling);
- the rendered `automation.toml` / `environment.toml` exist and match the
  recorded hashes (catches hand-edits and deletions);
- the `~/.codex` automation path is a symlink pointing at the render root
  (catches a missing, replaced, or repointed symlink).

A full `autovault doctor` run additionally sweeps the active
`${CODEX_HOME:-~/.codex}/automations` root for **orphan** symlinks that point
into the AutoVault render tree but have no backing index entry — including when
the index itself was deleted.

## Boundary

Do not edit the rendered TOML by hand. Make template changes inside this signed
skill package, reinstall the skill, then run `install-codex` again.

Do not copy these rendered files into `~/.codex`. Codex should only see the
symlinked rendered directory so machine-specific substitutions stay outside the
signed package bytes.

The automation has PR-only authority: it may create and update documentation
branches and PRs for AutoHub, run checks, and address review comments. It must
not merge PRs, and must never read, print, or write secrets.
