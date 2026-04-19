# skills

A self-bootstrapping skill pack. Two built-in skills manage themselves and the rest of the repo — clone it, add them to your agent, and your agent handles the rest.

## The pitch

```
Clone the repo.
Add skill-importer and skill-manager to your agent.
Browse the catalog. Grab what you want.
Your agent manages its own skills from there.
```

---

## Quick Start

**1. Clone the repo**

```bash
git clone https://github.com/verygoodplugins/skills.git
```

**2. Point your agent at the skills folder**

In Claude Code, Cursor, or any agent that supports skills — add `skill-importer` and `skill-manager` from this repo.

**3. Ask your agent to browse the catalog**

```
"What skills are available in the catalog?"
```

The agent reads `CATALOG.md`, shows you the list, and guides you through installation.

**4. Install a skill**

```
"Install the X skill"
```

The agent fetches it, safety-checks it, scaffolds the folder, and registers it in `skills.lock`.

**5. Stay current**

```
"Are my skills up to date?"
```

The agent reads `skills.lock`, checks each upstream SHA against GitHub, and surfaces anything that's drifted.

---

## Architecture

### skill-importer

The onramp. When someone says "I want skill X", it:
1. Shows the curated catalog (`CATALOG.md`)
2. Fetches the skill from GitHub
3. Safety-checks it
4. Scaffolds `skill-name/SKILL.md`
5. Populates upstream tracking metadata
6. Updates `skills.lock`

### skill-manager

The lifecycle manager. It:
- Reads `skills.lock` to see what's installed
- Fetches current upstream SHAs in parallel
- Reports drift (local SHA vs upstream HEAD)
- Offers three merge options for non-trivial updates
- Auto-applies trivial changes (typos, wording)
- Maintains per-skill `CHANGELOG.md` entries
- Runs a weekly drift check (built-in job instructions)

---

## Directory Structure

```
skills/
├── README.md                         # This file
├── CATALOG.md                        # Curated skill list
├── skills.lock                       # Installed skills manifest
├── skill-importer/
│   └── SKILL.md                      # Onramp skill
├── skill-manager/
│   ├── SKILL.md                      # Lifecycle manager skill
│   └── scripts/
│       └── check-drift.js            # CLI drift checker
└── {your-skill}/
    ├── SKILL.md                      # The skill itself
    └── CHANGELOG.md                  # Per-skill update history
```

---

## Skill Format

All skills follow the [agentskills.io specification](https://agentskills.io/specification): a folder with `SKILL.md` as the entry point.

```
skill-name/
├── SKILL.md          # Required: frontmatter + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: reference docs
└── assets/           # Optional: templates, data
```

### SKILL.md frontmatter

Standard fields from the agentskills.io spec:

```yaml
---
name: skill-name
description: What this skill does and when to use it.
license: MIT
compatibility: Designed for Claude Code
metadata:
  version: "1.0.0"
  author: verygoodplugins
---
```

### Upstream tracking fields

For imported skills, add provenance tracking inside `metadata`:

```yaml
metadata:
  version: "1.0.0"
  upstream: "https://github.com/org/repo/blob/main/skill-name/SKILL.md"
  upstream_sha: "abc1234def5678901234567890abcdef12345678"
  imported_at: "2026-04-19T00:00:00Z"
  adapted_for: "Claude Code"
```

| Field | Description |
|-------|-------------|
| `upstream` | GitHub blob URL of the source file |
| `upstream_sha` | Commit SHA at time of import or last sync |
| `imported_at` | ISO 8601 UTC timestamp of initial import |
| `adapted_for` | Platform/project this was adapted for |

Rules:
- `upstream` and `upstream_sha` must appear together or not at all.
- `upstream_sha` does **not** update on local edits — only on explicit syncs. This is what enables drift detection.
- Bump `version` on local edits (semver minor for compatible, major for rewrites).

---

## skills.lock

`skills.lock` is the single source of truth for what's installed. Updated automatically by `skill-importer` on install and by `skill-manager` when checking drift.

```yaml
version: "1"
updated: "2026-04-19T00:00:00Z"
skills:
  skill-name:
    version: "1.0.0"
    upstream: "https://github.com/org/repo/blob/main/skill-name/SKILL.md"
    upstream_sha: "abc1234def5678901234567890abcdef12345678"
    installed_at: "2026-04-19T00:00:00Z"
    last_checked: "2026-04-19T00:00:00Z"
    adapted_for: "Claude Code"
```

---

## CLI Drift Check

For CI or cron jobs, use the bundled script:

```bash
node skill-manager/scripts/check-drift.js
```

```
Checking 3 tracked skill(s)...

✅ Up to date:
   skill-name (v1.0.0)

⚠️  Drift detected:
   other-skill (v1.2.0)
     Local SHA:    abc1234...
     Upstream SHA: def5678...
     Diff:         https://github.com/org/repo/compare/abc1234...def5678
```

Flags:
- `--write-report` — append drift notes to each skill's `CHANGELOG.md`
- `--lock-path <path>` — override `skills.lock` location

Exit codes: `0` = up to date, `1` = drift detected, `2` = fatal error.

Set `GITHUB_TOKEN` to avoid rate limits.

```bash
npm run check-drift
npm run check-drift:report
```

---

## Contributing

Skills are Markdown folders. To contribute:

1. Create `your-skill/SKILL.md` following the [agentskills.io spec](https://agentskills.io/specification).
2. If importing from elsewhere, use `skill-importer` to populate upstream tracking.
3. Add your skill to `CATALOG.md`.
4. Open a PR.

---

## Forks and Personal Packs

Fork this repo to build your own skill pack. Your fork is your personal collection — customized, curated, yours. The upstream (`verygoodplugins/skills`) is the canonical public catalog.

`skill-manager` will track drift against whatever `upstream` URLs your skills declare, whether those point here or anywhere else on GitHub.
