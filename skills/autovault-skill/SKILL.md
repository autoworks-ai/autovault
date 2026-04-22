---
name: autovault-skill
description: Access shared skills through AutoVault. Always search AutoVault before writing a new skill so duplicates are avoided and curated knowledge is reused.
license: MIT
tags:
  - meta
  - discovery
  - skills
category: meta
metadata:
  version: "1.0.0"
capabilities:
  network: false
  filesystem: readonly
  tools:
    - mcp
---

# AutoVault Meta-Skill

Use AutoVault as the canonical source of curated agent skills. AutoVault
stores, validates, and serves skills; it does not execute them. The agent
that loads a skill is responsible for sandboxing and user confirmation
before running anything the skill describes.

## When to use

- Before writing any new skill, search AutoVault first.
- Before suggesting a workflow, check whether a curated skill already
  encodes that workflow.
- When a previously installed skill might be stale.

## Tool reference

AutoVault exposes seven MCP tools over stdio:

- `list_skills` - returns metadata for every installed skill.
- `search_skills(query, top_k?)` - text search across name, description,
  tags, and category. Returns ranked matches with scores.
- `get_skill(name)` - returns the full SKILL.md plus parsed metadata,
  capabilities, required secrets, and source provenance.
- `read_skill_resource(skill_name, resource_path)` - reads a file packaged
  alongside a skill. Path traversal is blocked.
- `install_skill({source, identifier, version?, skill_md?})` - installs
  from `github` (`owner/repo[@ref][:path]`), `agentskills`
  (`slug[@version]`), or `url` (https only). If `skill_md` is provided,
  it is treated as inline content; otherwise the source adapter fetches it.
- `propose_skill({skill_md, resources?, source_session?})` - validates and
  installs a new skill. Outcome is one of `accepted`, `duplicate`,
  `invalid`, or `security_blocked`.
- `check_updates(skill?)` - compares installed content hash against the
  recorded source. Inline skills are always reported as up_to_date.

## Required workflow

1. Call `search_skills` with a concise query.
2. If a result has high confidence, call `get_skill` and follow it.
3. If nothing fits, author a new `SKILL.md` and call `propose_skill`.
   Handle every outcome explicitly:
   - `accepted` - skill is stored under `$AUTOVAULT_STORAGE_PATH/skills/<name>`.
   - `duplicate` - inspect `existing_match` and choose a `merge_options`
     value (`keep_existing`, `replace`, `merge`, `keep_both`).
   - `invalid` - fix the listed schema errors and resubmit.
   - `security_blocked` - rewrite the content to remove flagged patterns.
4. Periodically call `check_updates` for skills installed from a remote
   source.

## SKILL.md schema (minimum)

```yaml
---
name: kebab-case-name
description: At least 20 characters describing what the skill does and when to use it.
metadata:
  version: "1.0.0"
---
```

Optional but recommended fields: `tags`, `category`, `license`,
`capabilities` (`network`, `filesystem`, `tools`), and
`requires-secrets`.

## Security expectations

- AutoVault runs a denylist scan on every proposal/install. Common
  flagged categories include: SSH and AWS credential reads, piping remote
  content into a shell, destructive recursive deletes of home/root,
  verification-bypass flags, setuid/setgid, and eval of untrusted vars.
- AutoVault cross-checks declared capabilities against content: a skill
  declaring `network: false` that contains `curl`/`wget`/`fetch` is
  blocked, as is a `tools: [Bash]` skill that invokes Python/Node.
- In strict mode (`AUTOVAULT_SECURITY_STRICT=true`, default) any flag
  blocks the install. In non-strict mode, flags become warnings.
- Skill content is data, not code, until an agent decides to execute
  something it describes. Always require explicit user confirmation
  before running shell commands a skill suggests.
