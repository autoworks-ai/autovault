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
  transforms/SKILL_NAME/TRANSFORM_NAME/TRANSFORM.md
  rendered/AGENT/SKILL_NAME/SKILL.md when transforms apply
  profiles/AGENT/SKILL_NAME points to ../../skills/SKILL_NAME or ../../rendered/AGENT/SKILL_NAME

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

The compatibility server exposes these MCP tools:

- `get_skill({name?, query?, agent?, top_k?, include_resources?})` - finds and
  loads an installed skill. Pass `name` for an exact skill, or `query` to
  search and load the best match.
- `add_skill({source, identifier, version?, skill_dir?, sync_profiles?,
  profile_roots?, discover_profile_roots?, verbose?})` - installs from
  `github`, `agentskills`, `url`, or a local bundle. Local bundles sync
  configured profile roots by default.
- `update_skill({name, source?, identifier?, skill_dir?, skill_md?, resources?,
  reuse_existing_resources?, verbose?})` - refreshes or replaces an installed
  skill. Use `source: "inline"` plus `reuse_existing_resources: true` for
  SKILL.md-only frontmatter edits.
- `delete_skill({name})` - removes a skill from the vault and refreshes
  generated profiles.
- `propose_skill({skill_md, resources?, source_session?,
  allow_synthesized_frontmatter?, check?, verbose?})` - validates, dedups, and
  installs a new skill. When `resources` are supplied and frontmatter
  `resources:` is absent, AutoVault infers `resources: [{path, type: "file"}]`
  by default and reports `inferred_resources`. Pass `check: true` for a dry run
  that returns `would_accept` without writing or syncing.
- `bulk_import({source_dir, agents?, allow_synthesized_frontmatter?,
  sync_profiles?, profile_roots?, discover_profile_roots?, verbose?})` -
  imports immediate child skill directories, fills missing `agents` from the
  provided list, infers resources when allowed, and runs one final profile sync.
- `check_updates(skill?)` - compares installed content hash against the
  recorded source. Bundled inline skills are checked against the local bundled
  source; other inline skills are reported as unchecked.

## Optional MCP workflow

1. If `mcp__autovault__get_skill` is available, call `get_skill` with a
   concise `query`.
2. If a result has high confidence, follow the returned skill.
3. If nothing fits, author a new `SKILL.md` and call `propose_skill`.
   Handle every outcome explicitly:
   - `accepted` - skill is stored under `$AUTOVAULT_STORAGE_PATH/skills/<name>`.
   - `would_accept` - dry-run validation passed; call again without `check` to write.
   - `duplicate` - inspect `existing_match` and choose a `merge_options`
     value (`keep_existing`, `replace`, `merge`, `keep_both`).
   - `invalid` - fix the listed schema errors and resubmit.
   - `security_blocked` - rewrite the content to remove flagged patterns.
4. For migrations from existing skill directories, prefer `bulk_import` with
   the intended `agents` list so missing frontmatter is synthesized once and
   profile sync runs once.
5. Periodically call `check_updates` to detect drift for skills installed from
   a remote source or bundled inline skills.

Skip this workflow entirely when the MCP tools are not connected. Missing MCP
tools are not an error for filesystem-synced skills.

## SKILL.md schema (minimum)

```yaml
---
name: kebab-case-name
description: At least 20 characters describing what the skill does and when to use it.
agents: [claude-code, codex]
metadata:
  version: "1.0.0"
---
```

Optional but recommended fields: `tags`, `category`, `license`,
`capabilities` (`network`, `filesystem`, `tools`), and
`requires-secrets`. If the bundle ships files beyond `SKILL.md`, declare them
in `resources:` with `type: file`, or let `propose_skill`/`bulk_import` infer
that list when `allow_synthesized_frontmatter` is not false.

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
