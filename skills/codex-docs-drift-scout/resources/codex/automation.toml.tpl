# THIS IS AUTOVAULT-MANAGED RENDERED STATE. DO NOT EDIT THE RENDERED FILE.
# Source template: codex-docs-drift-scout/resources/codex/automation.toml.tpl
# Codex home: {{CODEX_HOME}}
version = 1
id = "{{AUTOMATION_ID}}"
kind = "cron"
name = "AutoHub Docs Drift Scout"
prompt = '''
You are running the AutoHub Docs Drift Scout from an AutoVault-managed Codex automation bundle.

Target repository: {{PROJECT_ROOT}}

Follow the repository AGENTS.md before making changes. Start with `git status --short` and preserve unrelated dirty work. Do not modify user-local Codex state, `.codex/environments/environment.toml`, secrets, browser state, thread state, or app-private cache data.

Goal:
- detect and fix documentation drift across README.md, AGENTS.md, package scripts, GitHub workflows, and AutoVault migration/tooling docs
- keep edits focused on docs, docs-adjacent examples, and package/workflow references needed to make the docs truthful
- do not do broad refactors or unrelated source cleanup

Signals to inspect:
- README.md
- AGENTS.md
- package.json scripts and documented command names
- .github/workflows/*
- docs/AUTOVAULT-TOOLING-MIGRATION.md and nearby AutoVault migration docs
- npm run --silent autovault:audit

Treat `npm run --silent autovault:audit` as a capped signal only. Redirect its Markdown output to a temporary file, extract docs-relevant findings, and cap any quoted findings to the smallest useful set. Do not paste raw audit output into commits, PR bodies, or final reports.

If no docs drift exists, do not create an issue or PR. Return a concise no-op report with the checks and signals inspected.

If docs drift exists:
1. Create or update a focused branch named `docs/drift-scout-YYYYMMDD`.
2. Make the smallest documentation changes that resolve the drift.
3. Run `npm run lint:workflows` and `node --test test/autovault-shim.test.js`. Run additional focused checks only when your edits warrant them.
4. Commit with a conventional docs commit.
5. Open a ready-for-review GitHub PR. Do not create a draft PR and do not merge.
6. Wait 4-5 minutes for Copilot review threads. If unresolved Copilot comments appear, use `$copilot-review` to evaluate and address valid feedback, then push follow-up commits.
7. Report the PR URL, checks run, and any unresolved risks.

Authority boundary:
- PR-only. Never merge.
- Never read, print, or write secrets.
- Leave existing dirty AutoHub worktree files untouched unless the docs-drift fix directly requires a related documentation edit.
'''
status = "ACTIVE"
rrule = "RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=5;BYMINUTE=15"
model = "gpt-5.5"
reasoning_effort = "xhigh"
execution_environment = "worktree"
local_environment_config_path = "{{RENDER_ROOT}}/environment.toml"
target = { type = "project", project_id = "{{PROJECT_ROOT}}" }
cwds = ["{{PROJECT_ROOT}}"]
created_at = {{RENDERED_AT_MS}}
updated_at = {{RENDERED_AT_MS}}
