---
name: skill-importer
description: Onramp for adding skills to your agent. Browse the curated catalog or supply a GitHub URL — the agent fetches, safety-checks, scaffolds the folder, and registers the skill in skills.lock. Use when someone says "I want skill X" or "add the X skill".
license: MIT
compatibility: Designed for Claude Code or any agent with file system and HTTP access
metadata:
  version: "1.0.0"
  author: verygoodplugins
---

# Skill Importer

Use this skill whenever someone wants to add a skill to their agent setup.

## When to activate

- "I want the X skill"
- "Add skill X"
- "Import skill from [URL]"
- "What skills are available?"

---

## Step 1 — Identify the target skill

If the user gave a GitHub URL, skip to Step 2.

If the user named a skill (or asked what's available), read `CATALOG.md` at the repo root and present the list. Ask which skill they want, or confirm the one they named.

---

## Step 2 — Resolve + fetch the upstream skill

### 2a. Validate the URL

Only GitHub blob URLs are accepted. Reject anything else.

```
✅ https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md
❌ any other host or URL shape
```

Reject if the `<path>` contains `..` or absolute segments after normalization. This is an SSRF + path-traversal guard.

### 2b. Resolve the commit SHA

```
GET https://api.github.com/repos/{owner}/{repo}/commits?path={file_path}&per_page=1
```

Store the SHA from the first result as `upstream_sha`. If the response is empty or errors, report and stop.

### 2c. Fetch content pinned to that SHA

Fetch the raw file from the pinned commit — **not** the branch — so the content and the SHA you record are guaranteed consistent (TOCTOU guard):

```
https://raw.githubusercontent.com/{owner}/{repo}/{upstream_sha}/{file_path}
```

Do not fall back to `/<branch>/` if this fails — report the error and stop.

---

## Step 3 — Safety check

Read the fetched content and verify it:
- Does not instruct deletion of files outside the skill's stated purpose.
- Does not exfiltrate data or contain inline credentials.
- Is genuinely useful for the target context.

If any check fails, report the issue and stop. Do not import.

---

## Step 4 — Check for duplicates

Read `skills.lock`. If an entry already exists with a matching `upstream` URL, stop and say:

> Skill `{name}` is already installed (version {version}). Use **skill-manager** to check for upstream updates.

---

## Step 5 — Determine target directory

The skill's `name` field (from upstream frontmatter) becomes the directory name.

Check if the directory already exists. If it does and has no `upstream` match in skills.lock, append `-2`, `-3`, etc.

Target path: `./{skill-name}/SKILL.md`

---

## Step 6 — Adapt for local context

Review the skill content and adjust:
- **Tool names** — replace references that don't exist locally with nearest equivalent.
- **File paths** — update any hardcoded paths to match local project structure.
- **Terminology** — align with conventions in `CLAUDE.md` or `AGENTS.md` if present.

Keep the original intent intact. Note every adaptation made.

---

## Step 7 — Write the skill file

Create `{skill-name}/SKILL.md` with this frontmatter:

```yaml
---
name: {name from upstream SKILL.md}
description: {description from upstream SKILL.md}
license: {license from upstream, or omit}
compatibility: {compatibility from upstream, or omit}
metadata:
  version: "1.0.0"
  upstream: {full GitHub blob URL}
  upstream_sha: {40-char SHA from Step 2}
  imported_at: {current UTC timestamp in ISO 8601}
  adapted_for: {platform/project — e.g. "Claude Code"}
---
```

Then the body content, adapted as per Step 6.

---

## Step 8 — Update skills.lock

Open `skills.lock` and add an entry under `skills:`:

```yaml
{skill-name}:
  version: "1.0.0"
  upstream: {full GitHub blob URL}
  upstream_sha: {40-char SHA}
  installed_at: {current UTC timestamp in ISO 8601}
  last_checked: {current UTC timestamp in ISO 8601}
  adapted_for: {platform/project}
```

Update the top-level `updated` timestamp.

---

## Step 9 — Report

Output a summary:
- Local path written to.
- `upstream_sha` recorded.
- Each adaptation made.
- Any sections that may need manual review.

Suggest running **skill-manager** to verify the lock is consistent.
