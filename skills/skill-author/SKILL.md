---
name: skill-author
description: Author a well-formed SKILL.md with valid AutoVault frontmatter, a helpful description, and correct capability declarations. Walks the schema section by section with a template and checklist.
license: MIT
tags: [authoring, skills, autovault, meta, demo]
agents: [claude-code, codex, autojack]
category: meta
metadata:
  version: "1.0.0"
capabilities:
  network: false
  filesystem: readwrite
  tools: [Read, Edit, Write]
---

# Skill Author

Guide an author through producing a `SKILL.md` that will pass AutoVault's
validation gate on the first submission.

## When to use

- The user wants to create a new skill from scratch.
- The user has a workflow they want to package as a curated skill.
- An agent is about to call `propose_skill` and needs to compose valid
  frontmatter.

Before starting, call `search_skills` through AutoVault. If a similar
skill already exists, reuse or extend it instead of creating a duplicate.

## Required frontmatter

```yaml
---
name: kebab-case-name           # letters, digits, hyphens, underscores
description: At least 20 characters explaining WHAT the skill does and WHEN to use it.
---
```

- `name` must match the storage directory name and be unique in the
  library.
- `description` is what `search_skills` ranks on and what agents read to
  decide whether the skill applies. Describe **both** what and when.

## Recommended frontmatter

```yaml
license: MIT
tags: [topic, tool, domain]
category: <one-word-bucket>
metadata:
  version: "1.0.0"
capabilities:
  network: false | true
  filesystem: readonly | readwrite
  tools: [Bash, Read, Edit, ...]
requires-secrets:
  - name: GITHUB_TOKEN
    description: Required for gh CLI calls.
    required: true
```

### How to think about `capabilities`

AutoVault cross-checks the `capabilities` block against the skill body.
Declare the minimum your skill actually needs — overstating is wasted
surface area, understating will get the skill blocked at install time.

| Field | Set this when |
|---|---|
| `network: true` | The skill makes HTTP calls (`curl`, `wget`, `fetch`, SDK clients). |
| `filesystem: readwrite` | The skill writes files anywhere on disk. |
| `tools: [Bash]` | Shell commands are the only execution path. |
| `tools: [Bash, Read, Edit]` | Shell + the agent's own file editors are used. |

If your skill contains `curl` but you declare `network: false`, AutoVault
will reject the install. Same for `python` commands under a `tools: [Bash]`
declaration, or `echo foo > ~/.bashrc` under `filesystem: readonly`.

## Full template

```yaml
---
name: my-new-skill
description: One or two sentences that describe what the skill does and when an agent should trigger it.
license: MIT
tags: [domain, tool]
category: general
metadata:
  version: "1.0.0"
capabilities:
  network: false
  filesystem: readonly
  tools: [Bash]
---

# My New Skill

## When to use

- List the concrete triggers: user phrases, context shapes, preconditions.

## Prerequisites

- Tools the environment must have (git, gh, node, specific binaries).
- State the skill assumes (a repo, staged changes, an open PR, etc.).

## Workflow

Number the steps. Each step should be something a reader can execute
without referring back to this document.

### 1. First step

### 2. Second step

## Output

What the agent should produce (a draft message, a report, a fix, etc.).

## Anti-patterns

Things the skill should NOT do, so readers don't over-apply it.
```

## Pre-submission checklist

- [ ] `name` is unique, kebab-case, matches the directory name.
- [ ] `description` is ≥ 20 characters and covers both **what** and **when**.
- [ ] `capabilities` honestly reflects the skill body (no mismatches).
- [ ] The workflow section is step-numbered and self-contained.
- [ ] No secrets, tokens, or credentials in the body.
- [ ] No denylisted pattern categories in executable examples: reads of
      SSH or AWS credentials, piping remote content into a shell,
      destructive recursive deletes of `$HOME` or root, unsanitized
      evaluation of shell variables, verification-bypass flags on git or
      TLS, setuid/setgid chmod, or obfuscated (base64/hex) shell
      execution. See `scripts/security/patterns.json` for the full list.
- [ ] A "when to use" section explains triggers.
- [ ] An "anti-patterns" or "when NOT to use" section prevents misapplication.

## Submitting

From an MCP-connected agent:

```
propose_skill({ skill_md: "<the full SKILL.md content>" })
```

Handle the outcome:

- `accepted` — stored. Note the `dedup.tier` in the response; if it's
  `functional`, the response tells you which existing skill is similar.
- `duplicate` — inspect `existing_match`. Pick a `merge_options` value
  (`keep_existing`, `replace`, `merge`, `keep_both`) and resubmit or
  abandon.
- `invalid` — the `errors[]` array lists the schema violations. Fix them
  and resubmit.
- `security_blocked` — `security_flags[]` explains which patterns or
  capability mismatches fired. Rewrite the body or correct the
  capabilities block, then resubmit.

## Anti-patterns to avoid

- Descriptions that only say what, not when (`"Audit code"` vs. `"Audit
  code for common security issues when the user asks for a pre-PR
  review"`).
- Over-broad `capabilities` just in case — this weakens the cross-check's
  value and blocks your skill from being trusted in restricted contexts.
- Burying the workflow in prose. Steps should be numbered and scannable.
- Copy-pasting another skill without adapting the `name` and `description`
  — dedup will catch it as `exact` or `near_exact` and reject the submit.
