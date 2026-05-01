---
name: commit-message
description: Draft a conventional-commit-style message from the repository's staged changes. Uses git only; no external services or API keys required.
license: MIT
tags: [git, commit, conventional-commits, demo]
agents: [claude-code, codex, autojack]
category: git
metadata:
  version: "1.0.0"
capabilities:
  network: false
  filesystem: readonly
  tools: [Bash]
---

# Commit Message Drafter

Turn the current staged diff into a well-formed conventional-commit message
and present it to the user for approval before any commit is made.

## When to use

- The user asks you to "commit this", "write a commit message", "stage and
  commit", or similar.
- The user has finished a change and is about to run `git commit`.
- Staged changes exist but no message has been drafted yet.

Do not use this skill to commit on the user's behalf without approval. The
output of this skill is a *draft message*, not a commit action.

## Prerequisites

- A git repository in the current working directory.
- At least one staged change (`git diff --staged` returns non-empty output).

If nothing is staged, stop and ask the user what they want staged.

## Workflow

### 1. Inspect the staged change

```bash
git status --short
git diff --staged --stat
git diff --staged
```

Read all three outputs before drafting anything. The stat view shows which
files changed; the full diff shows how. Ignore generated files, lockfiles,
and anything that looks mechanical (whitespace-only, import reordering).

### 2. Classify the change

Pick one `type` from the conventional-commits vocabulary:

- `feat` — new user-visible capability
- `fix` — bug fix
- `refactor` — code change that neither adds a feature nor fixes a bug
- `docs` — documentation only
- `test` — test-only
- `chore` — tooling, deps, CI, build scripts
- `perf` — performance improvement
- `style` — formatting only (rare; prefer `chore` unless explicitly stylistic)

When in doubt between `feat` and `refactor`: if a user would notice, it's
`feat`. If only developers would notice, it's `refactor`.

### 3. Pick a scope (optional)

If the change is isolated to one subsystem, add a scope in parentheses.
Keep it short and lowercase (`auth`, `parser`, `cli`, `storage`).

### 4. Write the subject line

Format: `<type>(<scope>): <imperative summary>`

- Imperative mood ("add X", not "added X" or "adds X")
- No trailing period
- Target ≤ 72 characters
- Describe the *intent*, not the mechanics ("fix login redirect loop", not
  "change if-statement in login.ts")

### 5. Write the body (if the change warrants one)

Skip the body for trivial changes. Include a body when:

- The *why* isn't obvious from the subject.
- There are trade-offs or non-obvious consequences.
- The change fixes an issue or implements an RFC — reference it.

Format: one blank line after the subject, then wrapped paragraphs at ≤ 72
columns. Use bullet points for multi-part rationale.

### 6. Present for approval

Show the user the full drafted message and ask whether to commit as-is,
edit, or abandon. Never run `git commit` without explicit approval.

## Example output

```
feat(auth): add session renewal on MFA upgrade

When a user upgrades their MFA factor from SMS to TOTP, the session token
previously remained bound to the old factor claim until sign-out. Renew
the session in-place so downstream services see the new factor immediately.

- triggers on successful TOTP enrollment
- preserves original issued_at for audit
- no-op for sessions issued under the new factor
```

## Anti-patterns to avoid

- Vague subjects like "update code", "small fixes", "misc".
- Subjects that narrate the mechanical edit ("move function", "rename
  variable") rather than the intent.
- Bodies that restate the diff. If a reader can learn the same thing from
  `git show`, the body is noise.
- Committing without showing the user the draft first.
