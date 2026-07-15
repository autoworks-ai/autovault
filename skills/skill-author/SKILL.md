---
name: skill-author
description: Package and validate an existing skill draft for AutoVault when its frontmatter, resources, capabilities, or admission result need review.
license: MIT
tags: [packaging, validation, skills, autovault, meta]
agents: [claude-code, codex, autojack]
category: meta
metadata:
  version: "2.0.0"
capabilities:
  network: false
  filesystem: readwrite
  tools: [Read, Edit, Write]
---

# AutoVault Skill Packager

Prepare an existing `SKILL.md` or skill directory for AutoVault admission. This
skill is about AutoVault packaging: schema correctness, bundle membership,
capability declarations, validation, deduplication, and signed installation.

## Scope

Use this skill when:

- a workflow or draft already exists and needs valid AutoVault frontmatter;
- a bundle has support files that must be inventoried and declared;
- an AutoVault validation, security, or dedup result needs remediation; or
- a reviewed bundle is ready for `propose_skill` or `add_skill`.

Do not use it for open-ended workflow invention, trigger design, or general
skill-writing pedagogy. Use the host-native `skill-creator` or equivalent design
tool first, then return here once there is a concrete draft to package.

## 1. Check for an existing capability

If the AutoVault compatibility tools are connected, search with
`get_skill({query: "specific workflow nouns"})`. Prefer extending or reusing a
good match over adding another near-duplicate.

When the MCP tools are absent, inspect the host's normal visible skill
directory instead. AutoVault-managed skills are synced into those native
directories, so filesystem discovery is sufficient and the missing MCP server
is not an error.

## 2. Inventory the complete bundle

Treat the skill directory as one unit:

- `SKILL.md` is the entry point.
- Every regular sibling file under the directory is a resource.
- Exclude OS/editor metadata and generated caches.
- Reject symlinks, path traversal, device files, and other non-regular entries.
- Review executable resources as carefully as the skill body.

For a GitHub source, AutoVault fetches all regular sibling files beneath the
selected skill directory at one immutable commit. It does not rely on the
upstream author having declared every file. Missing `resources` declarations
are synthesized during normalization, and the install response reports
`inferred_resources` for review.

## 3. Normalize frontmatter

The minimum admitted shape is:

```yaml
---
name: kebab-case-name
description: Explain what the skill does and when it should trigger.
agents: [claude-code, codex]
metadata:
  version: "1.0.0"
---
```

- `name` must match the bundle directory and storage name.
- `description` must be at least 20 characters and cover both what and when.
- `agents` must contain at least one valid target profile.
- `metadata.version` should describe the packaged revision.

Useful optional fields include `license`, `tags`, `category`, `capabilities`,
`requires-secrets`, `resources`, and `bin`.

## 4. Declare resources and actions

For ordinary support files, declare their canonical relative paths:

```yaml
resources:
  - path: references/prompt-template.md
    type: file
  - path: scripts/helper.js
    type: file
```

An executable action uses a `bin` entry whose command also resolves inside the
bundle:

```yaml
bin:
  setup:
    command: bin/setup
    description: Configure the provider integration.
    requires-tty: true
```

`propose_skill`, `bulk_import`, and normalized remote installs can synthesize
missing resource entries from supplied bundle files. Always review the returned
`inferred_resources`; inference records bundle membership but does not replace a
human content review.

## 5. Declare the real capability surface

Capabilities describe the whole bundle, including resource files and executable
actions:

```yaml
capabilities:
  network: false
  filesystem: readonly
  tools: [Read]
```

- Set `network` to true when any workflow or bundled action contacts a remote
  service.
- Use `filesystem: readwrite` when any step creates, edits, or deletes files.
- List the actual host tools and runtimes used by the body and resources.
- Declare secrets only by environment-variable name and purpose; never include
  secret values in a bundle.

Under-declaration is rejected by the capability cross-check. Over-declaration
unnecessarily expands the skill's claimed authority.

## 6. Validate before writing

With MCP compatibility tools available, dry-run the exact bytes:

```text
propose_skill({skill_md: "<full SKILL.md>", resources: [], check: true})
```

Handle the result explicitly:

- `would_accept`: schema, security, capability, and dedup checks passed.
- `duplicate`: inspect `existing_match` and choose whether to reuse, replace,
  merge, or keep both.
- `invalid`: repair the listed schema or bundle errors.
- `security_blocked`: remove unsafe behavior or correct an inaccurate
  capability declaration; do not bypass strict validation.

For an existing reviewed directory, the local CLI path is
`autovault add <path> --dry-run`. A successful dry run does not write or sync
profiles.

## 7. Admit the reviewed bundle

- Use `propose_skill({skill_md: "<full SKILL.md>", resources: [...]})` for
  caller-held draft bytes.
- Use `add_skill({source: "local", skill_dir: "<directory>"})` for a reviewed
  local directory.
- Use `add_skill({source: "github", identifier: "owner/repo:path/SKILL.md"})`
  for a source-backed GitHub bundle.

Confirm the accepted name, inferred resources, target agents, and profile-sync
warnings. AutoVault signs `SKILL.md`, resources, and source metadata as one
installed bundle.

## Packaging checklist

- [ ] A concrete draft exists; general design work is already complete.
- [ ] The name is safe, unique, and matches the directory.
- [ ] The description states what and when.
- [ ] Target agents are explicit.
- [ ] Every regular bundle file was reviewed.
- [ ] Resource and `bin` paths are relative and remain inside the bundle.
- [ ] Capabilities describe the body and every resource honestly.
- [ ] No credentials, personal data, caches, or OS metadata are included.
- [ ] The exact candidate passed a dry-run validation.
- [ ] Any inferred resources and functional-duplicate warning were reviewed.

## Anti-patterns

- Designing a new workflow here instead of using the host's design skill.
- Writing directly into the managed vault and bypassing validation/signing.
- Declaring only files mentioned by upstream while ignoring sibling files.
- Treating a dedup warning as proof that two workflows are interchangeable.
- Weakening strict security to admit a blocked bundle.
