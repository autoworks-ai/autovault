---
title: Update Skill
description: Updates an existing locally-adapted skill by diffing upstream changes and either auto-applying trivial fixes or generating a structured PR with multiple merge options.
version: 1.0.0
adapted_for: Claude Code
tags:
  - skills-management
  - update
---

# Update Skill

Use this skill when upstream has changed and you need to merge those changes into a locally-adapted skill.

Typical trigger: the `check-updates` script reports that a skill's `upstream_sha` is behind the current upstream HEAD.

## Instructions

### Step 1 — Load the local skill

Read the target skill file. Extract from its frontmatter:
- `upstream` — the GitHub blob URL
- `upstream_sha` — the SHA when it was last synced
- `version` — current local version

If either `upstream` or `upstream_sha` is missing, stop and report:
> This skill has no upstream tracking information. It cannot be updated automatically.

### Step 2 — Fetch upstream content at both SHAs

Fetch two versions of the upstream file using the raw GitHub URLs:
1. **Old upstream** — the content at `upstream_sha` (the version originally imported).
2. **New upstream** — the content at current HEAD for that path.

Resolve current HEAD SHA using:
```
GET https://api.github.com/repos/{owner}/{repo}/commits?path={file_path}&per_page=1
```

Store the new SHA as `new_sha`.

### Step 3 — Generate the three-way diff

Produce a diff in this form:
- **Upstream diff** (`old_upstream → new_upstream`): what changed upstream.
- **Local diff** (`old_upstream → local`): what you adapted locally.
- **Conflict zones**: sections where both diffs touch the same lines.

### Step 4 — Classify the change

Classify the upstream diff as one of:
- **Trivial**: typo fixes, whitespace, minor wording tweaks, adding examples with no structural changes.
- **Non-trivial**: new steps, changed instructions, restructured sections, updated tool references, added/removed frontmatter fields.

### Step 5a — Trivial changes (auto-apply)

If the change is trivial and there are no conflict zones:
1. Apply the upstream change directly to the local skill, preserving all local adaptations.
2. Update `upstream_sha` in frontmatter to `new_sha`.
3. Increment `version` (patch: `1.0.0 → 1.0.1`).
4. Commit with the message:
   ```
   Update {skill title}: sync upstream trivial changes ({new_sha[:8]})
   ```
5. Report what was changed.

### Step 5b — Non-trivial changes (generate three options)

If the change is non-trivial or there are conflict zones, generate **three merge options**:

**Option A — Upstream wins**
Accept all upstream changes. Discard or rebase local adaptations on top.
Describe: what local adaptations would be lost or must be re-applied manually.

**Option B — Local wins**
Keep the current local version as-is. Update `upstream_sha` to acknowledge the upstream change without applying it.
Describe: what upstream improvements will be missed.

**Option C — Hybrid merge**
Intelligently merge both. Preserve local adaptations while incorporating the meaningful upstream changes.
Describe exactly what was taken from upstream and what was kept locally, line by line.

### Step 6b — Present the options

Output the three options in a structured format:

```
## Upstream Change Summary
{1-3 sentence description of what changed upstream}

## Conflict Zones
{list of sections where local and upstream both changed, or "None"}

## Option A — Upstream Wins
{description of what changes and what is lost}

## Option B — Local Wins
{description of what is preserved and what is skipped}

## Option C — Hybrid Merge (Recommended)
{description of the merge strategy and outcome}

## Recommendation
{which option you recommend and why}
```

Ask the user which option to apply before writing any files.

### Step 7 — Apply chosen option and open PR

After the user picks an option:
1. Write the merged skill file with updated `upstream_sha: {new_sha}` and incremented `version`.
2. Commit with message:
   ```
   Update {skill title}: merge upstream {new_sha[:8]} (Option {A/B/C})
   ```
3. Create a PR. The PR body must include:
   - Link to the upstream diff (GitHub compare URL between old and new SHA).
   - All three options (as generated in Step 6b), with the chosen option highlighted.
   - Any sections needing manual review.

This gives reviewers full context on why Option X was chosen and what was considered.
