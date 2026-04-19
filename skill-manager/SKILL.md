---
name: skill-manager
description: Manages installed skills — tracks versions via skills.lock, detects upstream drift, surfaces update options, and handles merges. Use when checking if skills are outdated, applying upstream updates, or running the weekly maintenance job.
license: MIT
compatibility: Designed for Claude Code or any agent with file system and HTTP access
metadata:
  version: "1.0.0"
  author: verygoodplugins
---

# Skill Manager

Use this skill for all post-install skill lifecycle tasks: drift checking, updates, and maintenance.

## When to activate

- "Are my skills up to date?"
- "Check for skill updates"
- "Update the X skill"
- "Run the weekly skill check"
- Scheduled: weekly background job (see [Weekly Job](#weekly-job))

---

## Drift Check

### Step 1 — Read skills.lock

Open `skills.lock` at the repo root. Collect all entries under `skills:` that have an `upstream` and `upstream_sha`.

If the lock is missing or has no tracked skills, report:
> No upstream-tracked skills found in skills.lock. Nothing to check.

### Step 2 — Fetch current upstream SHAs

For each tracked skill, resolve the current HEAD SHA:
```
GET https://api.github.com/repos/{owner}/{repo}/commits?path={file_path}&per_page=1
```
Parse `owner`, `repo`, and `file_path` from the `upstream` blob URL. Run all requests in parallel.

### Step 3 — Compare and report

For each skill:
- **Up to date**: current SHA matches `upstream_sha` in skills.lock.
- **Drifted**: current SHA differs.

Print a report:
```
Checking {N} tracked skill(s)...

✅ Up to date:
   skill-name (v1.0.0)

⚠️  Drift detected:
   other-skill (v1.2.0)
     Local SHA:    abc1234...
     Upstream SHA: def5678...
     Diff:         https://github.com/org/repo/compare/abc1234...def5678
```

Update `last_checked` in skills.lock for each skill checked.

---

## Applying an Update

### Step 1 — Load the local skill

Read `{skill-name}/SKILL.md`. Extract from its frontmatter `metadata`:
- `upstream` — the GitHub blob URL
- `upstream_sha` — the SHA when last synced
- `version` — current local version

### Step 2 — Fetch upstream at both SHAs

Fetch two versions:
1. **Old upstream** — content at `upstream_sha`.
2. **New upstream** — content at current HEAD.

Use raw GitHub URLs:
```
https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}
```

### Step 3 — Generate the three-way diff

Produce:
- **Upstream diff** (`old → new`): what changed upstream.
- **Local diff** (`old → local`): what was adapted locally.
- **Conflict zones**: sections where both diffs touch the same lines.

### Step 4 — Classify the change

- **Trivial**: typo fixes, whitespace, minor wording, adding examples with no structural changes.
- **Non-trivial**: new steps, changed instructions, restructured sections, updated tool references.

### Step 5a — Trivial: auto-apply

If trivial and no conflict zones:
1. Apply upstream change directly, preserving all local adaptations.
2. Update `upstream_sha` in both the skill's frontmatter metadata and `skills.lock`.
3. Bump `version` (patch: `1.0.0 → 1.0.1`).
4. Commit: `Update {skill-name}: sync upstream trivial changes ({new_sha[:8]})`
5. Report what changed.

### Step 5b — Non-trivial: generate three options

**Option A — Upstream wins**
Accept all upstream changes. Rebase local adaptations on top.
Note what local changes would be lost.

**Option B — Local wins**
Keep current local version. Update `upstream_sha` to acknowledge the change without applying it.
Note what upstream improvements will be missed.

**Option C — Hybrid merge (recommended)**
Intelligently merge both. Preserve local adaptations while incorporating meaningful upstream changes.
Describe exactly what came from upstream vs what was kept locally.

Present all three options, ask which to apply, then write the file and commit.

---

## Adding a CHANGELOG

When a skill is updated (either trivially or via chosen option), append an entry to `{skill-name}/CHANGELOG.md`:

```markdown
## {new_version} — {date}

- Synced upstream changes from {upstream_sha[:8]}
- {brief description of what changed}
```

Create the file if it doesn't exist.

---

## Weekly Job

Run this job on a weekly schedule (or whenever you want a health report).

### Instructions

1. Run the [Drift Check](#drift-check) above across all tracked skills.
2. If any skills are drifted, create a summary:
   ```
   ## Weekly Skills Report — {date}
   
   {N} skill(s) need attention:
   - {skill-name}: {diff URL}
   ```
3. Notify the user (Slack, push notification, or chat message — use whatever platform is available).
4. Do NOT auto-apply non-trivial updates. Notify and wait for the user to invoke skill-manager explicitly for updates.

### Scheduling in AutoHub

To run weekly in AutoHub, add a workflow file at `workflows/weekly/skill-manager-check.md`:

```markdown
---
schedule: "0 9 * * 1"
mode: agent
---
Run the skill-manager skill to check for upstream drift across all installed skills.
If any skills are outdated, post a summary to Slack.
```

---

## scripts/check-drift.js

For environments where you want a programmatic drift check (CI, cron, CLI), use the bundled script:

```bash
node skill-manager/scripts/check-drift.js [--write-report] [--lock-path ./skills.lock]
```

Flags:
- `--write-report` — appends drift status to each skill's `CHANGELOG.md`
- `--lock-path` — override path to skills.lock (default: `./skills.lock`)

Exit codes: `0` = up to date, `1` = drift detected, `2` = fatal error.

Set `GITHUB_TOKEN` to avoid rate limits.
