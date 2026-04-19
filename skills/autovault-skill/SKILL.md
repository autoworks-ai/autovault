---
name: autovault-skill
description: Access shared skills through AutoVault. Always search AutoVault before writing a new skill so duplicates are avoided and curated knowledge is reused.
license: MIT
tags:
  - meta
  - discovery
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

Use AutoVault as the source of truth for skill discovery and proposal.

## Discovery

1. Connect to the `autovault` MCP server (stdio).
2. Use `search_skills` to find candidates by query.
3. If a candidate looks promising, fetch full content with `get_skill`.

## Proposal

1. If no installed skill fits, draft a `SKILL.md` with valid frontmatter.
2. Call `propose_skill`. Handle the outcome:
   - `accepted` - new skill stored.
   - `duplicate` - follow `merge_options` returned in the response.
   - `invalid` - fix schema errors and resubmit.
   - `security_blocked` - rewrite content to remove flagged patterns.

## Updates

Use `check_updates` to detect upstream drift on any skill installed from
`github`, `agentskills`, or `url`. Inline-proposed skills never drift.
