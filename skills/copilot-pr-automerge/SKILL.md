---
name: copilot-pr-automerge
description: Move current related work into a fresh git worktree branch, open a GitHub PR, request and iterate on Copilot reviews, wait for CI, and merge when explicitly authorized.
license: MIT
tags: [git, github, pull-request, copilot, ci, worktree, automation]
agents: [claude-code, codex, autojack]
category: git
metadata:
  version: "1.0.0"
capabilities:
  network: true
  filesystem: readwrite
  tools: [Bash, Read, Edit, GitHub]
requires-secrets: []
---

# Copilot PR Automerge

## When To Use

Use this skill when the user wants an agent to take current local work through a
GitHub PR loop: isolate the related changes into a new branch in a sibling
worktree, push, create a PR, request GitHub Copilot review, resolve Copilot
comments, repeat after re-review, wait for CI, and merge after the PR is green.

## Preconditions

1. The current directory is inside a git repository with a GitHub remote.
2. `gh auth status` succeeds for the target GitHub host.
3. The user has authorized merge in the current request or a project rule. If
   merge was not explicitly authorized, run the loop through a green PR and stop.
4. Copilot review may be unavailable because of repo policy, plan, quota, or
   GitHub Enterprise Server support. If `gh pr edit --add-reviewer "@copilot"`
   fails, report the failure and continue only if the user wants a non-Copilot
   PR path.

## Guardrails

- Keep the original checkout intact. Do not stash, reset, discard, or clean it
  while moving work into the new worktree.
- Move only paths related to the user's task. Leave unrelated dirty files in the
  original checkout.
- Do not merge with unresolved Copilot review threads, failing or pending CI,
  merge conflicts, a draft PR, or branch-protection blocks.
- Do not use admin merge, verification bypasses, or branch-protection bypasses.
- Stop for human input when a Copilot comment is subjective, security-sensitive,
  or would require a broad refactor beyond the PR's scope.

## Workflow

### 1. Inspect the current repository

Run:

```bash
git status --short --branch
git remote -v
git branch --show-current
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef --jq '.'
```

Read the diff before deciding what belongs in the PR:

```bash
git diff --stat
git diff --cached --stat
git diff
git diff --cached
git ls-files --others --exclude-standard
```

Build an explicit list of related paths. If unrelated files are dirty, state
that they are being left behind.

### 2. Create a fresh branch in a sibling worktree

Choose a short conventional branch name, for example
`agent/copilot-pr-loop`. Use the repository default branch as the base unless
the user named another base.

```bash
BASE_REF="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')"
REPO_NAME="$(basename "$(git rev-parse --show-toplevel)")"
BRANCH="agent/<task-slug>"
WORKTREE="../${REPO_NAME}-worktrees/${BRANCH//\//-}"

git fetch origin "$BASE_REF"
git worktree add -b "$BRANCH" "$WORKTREE" "origin/$BASE_REF"
```

If the current branch has committed work that belongs in the PR, cherry-pick
those commits into the new worktree in chronological order:

```bash
git log --reverse --format=%H "origin/$BASE_REF"..HEAD
git -C "$WORKTREE" cherry-pick <sha>
```

For uncommitted tracked changes, make a binary patch from only the selected
paths and apply it inside the worktree:

```bash
PATCH_FILE="$(mktemp)"
git diff --binary HEAD -- <selected-paths> > "$PATCH_FILE"
git -C "$WORKTREE" apply "$PATCH_FILE"
```

For selected untracked files, copy them into the matching paths under the
worktree after creating parent directories. Then verify the isolated diff:

```bash
git -C "$WORKTREE" status --short --branch
git -C "$WORKTREE" diff --stat
git -C "$WORKTREE" diff
```

### 3. Verify locally and commit

Run the project's focused checks first, then the broader checks needed for PR
confidence. Prefer existing package scripts, Make targets, or documented test
commands.

Commit only from the worktree. Use the repository's conventional-commit style
and no generic agent prefix:

```bash
git -C "$WORKTREE" add <selected-paths>
git -C "$WORKTREE" commit -m "<type>(<scope>): <imperative summary>"
```

### 4. Push and open the PR

```bash
git -C "$WORKTREE" push -u origin "$BRANCH"
gh -R "$(gh repo view --json nameWithOwner --jq '.nameWithOwner')" pr create \
  --base "$BASE_REF" \
  --head "$BRANCH" \
  --title "<type>(<scope>): <imperative summary>" \
  --body "<summary, tests, and risk notes>"
```

Resolve the PR number and request Copilot review:

```bash
PR="$(git -C "$WORKTREE" branch --show-current)"
PR_NUMBER="$(gh pr view "$PR" --json number --jq '.number')"
gh pr edit "$PR_NUMBER" --add-reviewer "@copilot"
```

If the repository automatically requests Copilot reviews, still record that in
the summary. If a manual re-request is needed after later pushes, use the same
`gh pr edit ... --add-reviewer "@copilot"` command.

### 5. Wait four minutes, then inspect Copilot comments

After every Copilot review request or re-request, wait at least four minutes:

```bash
sleep 240
```

Then inspect unresolved, non-outdated line-review threads authored by Copilot.
If the `copilot-review` skill is available, use it to resolve the PR comments;
it already knows how to reply, resolve, commit, and push. Otherwise use this
GraphQL query as the source of truth:

```bash
OWNER="$(gh repo view --json owner --jq '.owner.login')"
REPO="$(gh repo view --json name --jq '.name')"
gh api graphql -F owner="$OWNER" -F repo="$REPO" -F pr="$PR_NUMBER" -f query='
query($owner:String!, $repo:String!, $pr:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first:1) {
            nodes {
              databaseId
              author { login }
              body
              diffHunk
            }
          }
        }
      }
    }
  }
}'
```

Filter to:

- `isResolved == false`
- `isOutdated == false`
- `comments.nodes[0].author.login == "copilot-pull-request-reviewer"`

If there are no filtered threads, the Copilot phase is green.

### 6. Resolve Copilot comments and repeat

For each Copilot thread:

1. Read the cited file around the line and the `diffHunk`.
2. Classify the comment as correct, partially correct, or not applicable.
3. Apply the smallest correct fix when the comment is valid.
4. Reply to the thread with the specific change or the concrete reason it does
   not apply.
5. Resolve only after replying and only when the fix landed or the concern is
   demonstrably moot.

Commit and push any fixes from the worktree:

```bash
git -C "$WORKTREE" status --short --branch
git -C "$WORKTREE" add <changed-paths>
git -C "$WORKTREE" commit -m "fix(<scope>): address copilot review"
git -C "$WORKTREE" push
```

Request a re-review, wait four minutes, and inspect again:

```bash
gh pr edit "$PR_NUMBER" --add-reviewer "@copilot"
sleep 240
```

Repeat until the filtered Copilot thread list is empty. Default to a maximum of
five Copilot cycles in one run unless the user explicitly asks to keep going.

### 7. Wait for CI and check merge readiness

Wait for checks:

```bash
gh pr checks "$PR_NUMBER" --watch --fail-fast
gh pr checks "$PR_NUMBER" --json name,bucket,state,link --jq '.'
```

Then inspect merge state:

```bash
gh pr view "$PR_NUMBER" \
  --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,url \
  --jq '.'
```

Proceed only when:

- The PR is open and not draft.
- Required checks have passed.
- `mergeable` is not `CONFLICTING`.
- `mergeStateStatus` is not blocked by conflicts, pending checks, or required
  human review.
- The head SHA has not changed since the final verification.

If `mergeable` is `UNKNOWN`, wait briefly and re-check before deciding.

### 8. Merge when authorized

Only merge if the invoking request authorized merge after green. Use the repo's
documented merge strategy when obvious; otherwise default to squash for a
single-agent PR. Protect against races with the final head SHA:

```bash
HEAD_SHA="$(gh pr view "$PR_NUMBER" --json headRefOid --jq '.headRefOid')"
gh pr merge "$PR_NUMBER" --squash --delete-branch --match-head-commit "$HEAD_SHA"
```

Do not use `--admin`. If the merge command reports branch protection, required
review, merge queue, or permissions issues, stop and report the exact blocker.

## Output

At the end, report:

- Worktree path and branch.
- PR URL and title.
- Local checks run.
- Copilot cycles completed and comment counts fixed, rejected, skipped, or left
  for the user.
- CI status.
- Merge result, or the exact blocker that prevented merge.

## Anti-Patterns

- Moving every dirty file into the PR without checking task relevance.
- Mutating the user's original checkout while trying to isolate work.
- Treating Copilot's review summary as a merge gate when there are no actionable
  unresolved line threads.
- Re-requesting Copilot indefinitely when the same subjective comment repeats.
- Merging because CI is green while Copilot threads or merge conflicts remain.
