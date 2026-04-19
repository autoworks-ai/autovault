# SKILLS.md — Skill File Specification

This document defines the standard frontmatter format for skill files in this repository.

## Overview

A **skill** is a prompt/instruction file that guides an LLM through a specific task. Skills can be authored locally or imported from upstream sources. Frontmatter tracks provenance so upstream drift can be detected and merged.

## Frontmatter Spec

Every skill file MUST begin with a YAML frontmatter block enclosed in `---` delimiters.

```yaml
---
title: Human-readable skill name
description: One sentence describing what this skill does
version: 1.0.0
upstream: https://github.com/org/repo/blob/main/skills/skill-name.md
upstream_sha: abc1234def5678901234567890abcdef12345678
imported_at: 2026-04-19T00:00:00Z
adapted_for: Claude Code
tags:
  - debugging
  - typescript
---
```

## Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Human-readable name for the skill |
| `description` | Yes | One-sentence summary of the skill's purpose |
| `version` | Yes | Semver. Increment on local edits. |
| `upstream` | No | Full GitHub URL to the source file (permalink to a blob, not a tree) |
| `upstream_sha` | No | The full 40-char commit SHA when this skill was imported or last synced |
| `imported_at` | No | ISO 8601 UTC timestamp of initial import |
| `adapted_for` | No | The platform or project this skill was adapted for (e.g. "Claude Code", "Cursor", "Autobrew") |
| `tags` | No | Array of lowercase topic tags for discovery |

## Rules

- `upstream` and `upstream_sha` must always appear together or not at all.
- `upstream` must be a blob URL (not a commit URL), so the `check-updates` script can resolve the current HEAD SHA for that path.
- When you edit a skill locally, increment `version` using semver minor (`1.0.0 → 1.1.0` for compatible changes, `2.0.0` for rewrites).
- `upstream_sha` must NOT be updated on local edits — only on explicit upstream syncs. This is what allows drift detection.

## Locally Authored Skills

Skills written from scratch (no upstream) omit `upstream`, `upstream_sha`, and `imported_at`:

```yaml
---
title: My Custom Skill
description: Does something specific to this project
version: 1.0.0
adapted_for: Claude Code
tags:
  - custom
---
```

## Naming Convention

Skill files use kebab-case and live in the `skills/` directory:

```
skills/
  import.md          # Import a skill from upstream
  update.md          # Update an existing skill from upstream
  your-skill.md      # Any custom skill
```
