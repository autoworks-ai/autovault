---
name: autovault-skill
description: Understand AutoVault-managed skills. AutoVault syncs skills into the agent's normal skill directory, so loaded skills can be used directly without an AutoVault MCP server.
license: MIT
tags:
  - meta
  - discovery
  - skills
agents:
  - claude-code
  - codex
  - autojack
category: meta
metadata:
  version: "1.0.0"
capabilities:
  network: false
  filesystem: readonly
  tools: []
---

# AutoVault Meta-Skill

AutoVault is the local capability and skill profile layer. It stores and
validates skills, then syncs them into the agent's normal skill directory as
filesystem symlinks. If this skill is loaded, AutoVault profile sync is already
working for this agent; do not require an AutoVault MCP server before using
other visible skills.

AutoVault does not execute skills. The agent that loads a skill is responsible
for sandboxing and user confirmation before running anything the skill
describes.

## When to use

- When the user asks why an AutoVault-managed skill is visible.
- When deciding whether to use a synced skill such as `commit-message` or
  `skill-author`.
- Before writing a new skill, check the skills already visible to the current
  agent.
- When debugging profile sync or stale skill links.

## Primary workflow: synced skills

AutoVault's primary interface is filesystem-native profile sync:

```text
$AUTOVAULT_STORAGE_PATH/
  skills/SKILL_NAME/SKILL.md
  profiles/AGENT/SKILL_NAME points to ../../skills/SKILL_NAME

~/.claude/skills/SKILL_NAME points to ~/.autovault/profiles/claude-code/SKILL_NAME
~/.codex/skills/SKILL_NAME points to ~/.autovault/profiles/codex/SKILL_NAME
```

Use synced skills directly through the host's normal skill mechanism. If a
skill is visible in the current agent session, it is already available; no
`mcp__autovault__*` tools are required.

For local troubleshooting, inspect the profile directory:

```bash
ls -l ~/.autovault/profiles/claude-code
ls -l ~/.claude/skills
ls -l ~/.codex/skills
```

## Optional compatibility: MCP tools

Some hosts may still connect the AutoVault MCP compatibility server. Only use
these tools if `mcp__autovault__*` tools are actually present in the current
session. If they are absent, continue with the synced skills that are already
visible.

The compatibility server exposes seven MCP tools:

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
  recorded source. Bundled inline skills are checked against the local bundled
  source; other inline skills are reported as unchecked.

## Optional MCP workflow

1. If `mcp__autovault__search_skills` is available, call `search_skills` with a
   concise query.
2. If a result has high confidence, call `get_skill` and follow it.
3. If nothing fits, author a new `SKILL.md` and call `propose_skill`.
   Handle every outcome explicitly:
   - `accepted` - skill is stored under `$AUTOVAULT_STORAGE_PATH/skills/<name>`.
   - `duplicate` - inspect `existing_match` and choose a `merge_options`
     value (`keep_existing`, `replace`, `merge`, `keep_both`).
   - `invalid` - fix the listed schema errors and resubmit.
   - `security_blocked` - rewrite the content to remove flagged patterns.
4. Periodically call `check_updates` for skills installed from a remote source.

Skip this workflow entirely when the MCP tools are not connected. Missing MCP
tools are not an error for filesystem-synced skills.

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
