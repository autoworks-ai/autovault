# skills

A shared repository for LLM skill files with upstream tracking, import/update tooling, and automated drift detection.

## The Problem

Teams copy skill files from various sources — open-source repos, other projects, shared libraries — then adapt them locally. Without tracking where a skill came from, there's no way to know when the upstream has been improved, or to merge those improvements without manually hunting down the original.

This repo solves that with:
1. A standard frontmatter spec to track skill provenance.
2. An import skill that fetches, adapts, and records upstream info.
3. An update skill that diffs upstream changes and generates merge options.
4. A cron-ready script that scans all skills and reports upstream drift.

---

## SKILLS.md Frontmatter Spec

Every skill file uses YAML frontmatter to track its origin:

```yaml
---
title: My Skill
description: What this skill does
version: 1.0.0
upstream: https://github.com/org/repo/blob/main/skills/my-skill.md
upstream_sha: abc1234def5678901234567890abcdef12345678
imported_at: 2026-04-19T00:00:00Z
adapted_for: Claude Code
tags:
  - debugging
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Human-readable name |
| `description` | Yes | One-sentence summary |
| `version` | Yes | Semver — increment on local edits |
| `upstream` | No | GitHub blob URL of the source |
| `upstream_sha` | No | Commit SHA at time of import/last sync |
| `imported_at` | No | ISO 8601 UTC import timestamp |
| `adapted_for` | No | Platform/project context (e.g. "Claude Code") |
| `tags` | No | Topic tags for discovery |

Full spec: see [SKILLS.md](./SKILLS.md).

---

## Importing a Skill

Use the `skills/import.md` skill to guide an LLM agent through the import process:

1. Open `skills/import.md` in your agent (Claude Code, Cursor, etc.).
2. Provide the GitHub URL of the skill you want to import.
3. The agent will:
   - Fetch the skill and do a safety check.
   - Check if it's already imported (deduplication).
   - Adapt it for your local context.
   - Write it to `skills/` with full frontmatter populated.

---

## Checking for Updates

### One-off check

```bash
node scripts/check-updates.js
```

Reports which skills have upstream changes:

```
Checking 3 tracked skill(s)...

✅ Up to date:
   import.md (v1.0.0)

⚠️  Updates available:
   some-skill.md (v1.2.0)
     Local SHA:    abc1234...
     Current SHA:  def5678...
     Diff:         https://github.com/org/repo/compare/abc1234...def5678
```

### With written report

```bash
node scripts/check-updates.js --write-report
```

Writes an `UPDATES.md` file to the repo root with links to diffs.

### Cron setup

Add to your crontab to check daily at 9am:

```cron
0 9 * * * cd /path/to/skills && node scripts/check-updates.js --write-report >> /var/log/skills-check.log 2>&1
```

Or with a GitHub token to avoid rate limits:

```cron
0 9 * * * cd /path/to/skills && GITHUB_TOKEN=ghp_xxx node scripts/check-updates.js --write-report
```

Exit codes:
- `0` — all skills up to date
- `1` — updates available (use this to trigger alerts)
- `2` — fatal error

---

## Applying Updates

Use the `skills/update.md` skill when the check script reports a skill is outdated:

1. Open `skills/update.md` in your agent.
2. Tell it which skill file needs updating.
3. The agent will:
   - Fetch old and new upstream content.
   - Diff against your local version.
   - **For trivial changes** (typos, minor wording): apply automatically and commit.
   - **For non-trivial changes**: generate three merge options (upstream wins / local wins / hybrid), then open a PR with all three options described in the body — Dependabot style.

---

## Directory Structure

```
skills/
├── SKILLS.md              # Frontmatter spec (this document's companion)
├── README.md              # This file
├── scripts/
│   └── check-updates.js   # Upstream drift checker
└── skills/
    ├── import.md          # Import skill
    ├── update.md          # Update skill
    └── ...                # Your skills live here
```

---

## Contributing

Skill files are just Markdown. To add one:
1. Create `skills/your-skill.md` with proper frontmatter.
2. If copied from elsewhere, use `skills/import.md` to populate `upstream` tracking.
3. Run `node scripts/check-updates.js` before committing to verify all upstream refs resolve.
