# AutoVault — Project Plan (V2)

**For:** Steve (implementation), Jack Arturo (owner), Jason Coleman + Zack Katz + Daniel Iser (contributors)
**Status:** Ready to implement — supersedes `shared-skills-implementation-plan.md`
**Date:** April 19, 2026

---

## What This Document Replaces

The earlier `shared-skills-implementation-plan.md` scoped AutoVault as a Git-sync layer: one central repo, a bash script that rsync's skill directories into per-project agent folders. That was the wrong architecture. This document replaces it.

The correct architecture is an **MCP server** that mediates between agents and a curated skill library, with a validation gate on all inbound skills, progressive disclosure to keep agent contexts lean at scale, and universal compatibility via a meta-skill for agents that don't speak MCP natively. The Git-sync-to-project-directories pattern survives only as a fallback for headless agents like Codex Cloud — and even that's deferred to a later phase.

The V1 draft's naming decisions carry over: repo is **AutoVault** under the **AutoWorks** GitHub organization (domains `autovault.sh` and `autovault.dev` registered). Push access: Jack, Jason, Zack, Daniel. Private repo until the pattern is battle-tested.

---

## TL;DR

AutoVault is an MCP server that sits between AI agents and a curated library of skills. It does three things:

1. **Serves skills to agents** — via native MCP (stdio for local, HTTP+OAuth for remote) or via a meta-skill that teaches non-MCP agents how to use its HTTP API
2. **Validates skills at the gate** — YAML schema conformance, auto-repair of malformed frontmatter, security scanning against a denylist, capability-declaration verification, deduplication check
3. **Curates a library** — installed skills live in `~/.autovault/skills/` (local) or a mounted volume (remote), tracked in `skills.lock` with upstream SHAs for drift detection

AutoVault explicitly does **not** execute skills. It's content + metadata, not a runtime. Agents execute skills themselves using their existing tooling. This is the cleanest possible separation of concerns and eliminates an entire category of complexity (no daemon management, no per-skill sandboxing, no process supervision).

The wedge over Tessl, ClawHub, and every other skill registry: validation gate + `propose_skill` interception for agent-authored skills. Hermes's duplicate-skill-creation problem is solved by having agents call `propose_skill` instead of writing directly to disk — AutoVault dedup-checks against existing skills and either merges intelligently or creates new, based on evidence.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ AGENTS                                                         │
│   Claude Code, Cursor, Codex, OpenClaw, Hermes, AutoJack       │
│                                                                │
│   ┌──────────────────┐         ┌────────────────────────────┐ │
│   │ Native MCP       │   OR    │ autovault-skill (meta-skill)│ │
│   │ (stdio or HTTP)  │         │ teaches non-MCP agents      │ │
│   └────────┬─────────┘         └─────────────┬──────────────┘ │
│            │                                 │                 │
└────────────┼─────────────────────────────────┼─────────────────┘
             │                                 │
             ▼                                 ▼
┌────────────────────────────────────────────────────────────────┐
│ AUTOVAULT                                                      │
│                                                                │
│   MCP Server                                                   │
│   ├── stdio (local, zero-config for Claude Code/Cursor/Codex)  │
│   └── HTTP+SSE (remote, OAuth 2.1, Docker-deployed)            │
│                                                                │
│   Tools                                                        │
│   ├── list_skills           metadata only (progressive disc.)  │
│   ├── search_skills         text search V1, semantic V2        │
│   ├── get_skill             full SKILL.md + resource manifest  │
│   ├── read_skill_resource   fetch one bundled file             │
│   ├── install_skill         from URL/agentskills.io            │
│   ├── propose_skill         agent-authored, dedup-gated        │
│   └── check_updates         drift detection                    │
│                                                                │
│   Validation Gate (inbound)                                    │
│   ├── YAML parse + auto-repair                                 │
│   ├── Schema validation (agentskills.io spec)                  │
│   ├── Security scan (denylist patterns)                        │
│   ├── Capability-declaration vs actual behavior check          │
│   ├── Dedup check                                              │
│   └── Optional: description optimization (V2)                  │
│                                                                │
│   Storage                                                      │
│   ├── Local: ~/.autovault/skills/                              │
│   ├── Remote: mounted volume in Docker container               │
│   └── skills.lock (tracking manifest)                          │
└────────────────────────────────────────────────────────────────┘
```

**Critical design principle: AutoVault does not execute skills.** It serves content. Execution happens on whatever machine the agent is running on, using whatever tools the agent already has. This means:

- AutoVault never touches user secrets
- AutoVault can be deployed anywhere (local, Docker, Railway, anything)
- No daemon management, no process supervision, no sandboxing complexity
- The attack surface is purely content-serving

---

## MCP Server Design

### Protocol Support

**Local mode (default):** stdio-based MCP server. Zero-config for Claude Code, Cursor, Codex — they drop AutoVault into their `mcpServers` config and it works. This is the primary usage path for V1.

**Remote mode:** HTTP + SSE transport with OAuth 2.1 auth. Docker-deployed. Intended for users who want their skill library accessible across multiple machines (mobile + laptop, personal + work, etc.) or for eventual team-shared libraries.

Both modes expose the same tool surface. The only difference is transport and auth.

### Tools

Each tool's description targets MCP-compatible agents. All tools return JSON.

**`list_skills`** — List installed skills, metadata only (name, description, version, tags).

```
Input: { category?: string, tag?: string, limit?: number }
Output: { skills: [{ name, description, version, tags, category }] }
```

Critical: returns **only metadata**, never SKILL.md bodies. This is what keeps the agent's context lean at scale. A library of 500 skills returns ~500×60 words of metadata = manageable; returning 500 full SKILL.mds would nuke the context window.

**`search_skills`** — Find skills matching a query.

```
Input: { query: string, top_k?: number }
Output: { matches: [{ name, description, score, reason }] }
```

V1: text search (BM25 or equivalent) across name + description + SKILL.md body.
V2: semantic search via local embeddings model (`nomic-embed-text` via Ollama, not Qdrant — keeps the stack lean).

Matches include an installed skill indicator and, if no installed skill matches well, suggestions from configured marketplaces.

**`get_skill`** — Load a specific skill into agent context.

```
Input: { name: string }
Output: {
  name, description, version,
  skill_md: string,              // full SKILL.md body
  resources: [{ path, type }],   // manifest of bundled scripts/references/assets
  requires_secrets: [{ name, description, required }],
  capabilities: { network, filesystem, tools }
}
```

Returns SKILL.md content plus a manifest of bundled resources. Agent loads resources on-demand via `read_skill_resource`. This is the middle tier of progressive disclosure.

**`read_skill_resource`** — Fetch a specific bundled file from a skill.

```
Input: { skill_name: string, resource_path: string }
Output: { content: string, mime_type: string }
```

Enables progressive disclosure at the resource level. Agent only loads the script/reference/asset it actually needs.

**`install_skill`** — Install a skill from a configured source.

```
Input: { source: "github" | "agentskills" | "url", identifier: string, version?: string }
Output: { success: boolean, name: string, validation: {...}, warnings: [] }
```

Runs the validation gate. Reports any security flags, malformed frontmatter, or dedup matches. If dedup matches an existing skill, returns the existing skill's name + diff rather than installing a duplicate.

**`propose_skill`** — Agent-authored skill, for capture-from-session workflows.

```
Input: { skill_md: string, resources?: [{ path, content }], source_session?: string }
Output: { outcome: "accepted" | "duplicate" | "invalid" | "security_blocked",
          name?: string,
          existing_match?: { name, similarity, merge_options },
          errors?: [],
          security_flags?: [] }
```

This is the interception point for Hermes-style auto-authoring. The agent calls `propose_skill` instead of writing to `~/.hermes/skills/`. AutoVault runs the full validation pipeline, checks for duplicates, and returns either:

- `accepted`: new skill, stored, name returned
- `duplicate`: similar skill exists, here are merge options (keep old / replace with new / merge both / keep both separate)
- `invalid`: YAML or schema errors, here's what to fix
- `security_blocked`: denylist pattern matched, here's the specific flag

For cooperative agents (Claude Code, Cursor, Codex), you instruct them via system prompt / AGENTS.md to always call `propose_skill` for new skills. For Hermes, the path is harder — filesystem watcher + post-hoc consolidation is the pragmatic V2 solution.

**`check_updates`** — Drift detection against upstream.

```
Input: { skill?: string }  // omit to check all
Output: { drifted: [{ name, local_sha, upstream_sha, diff_url }],
          up_to_date: [...],
          errors: [...] }
```

Reuses AutoJack's existing `check-drift.js` logic. This is the one piece of the original prototype that carries over mostly unchanged.

---

## Validation Gate

This is the differentiator. Every skill that enters AutoVault — via `install_skill` or `propose_skill` — runs through the same pipeline:

### Step 1: YAML Parse + Auto-Repair

Parse the frontmatter. If parsing fails, attempt common repairs:

- Fix indentation (spaces vs tabs, inconsistent depth)
- Quote strings containing special characters (`:`, `#`, etc.)
- Wrap multi-line descriptions in folded-block-scalar style
- Trim trailing whitespace

If repair succeeds, log the changes and proceed. If repair fails, return `invalid` with specific errors.

### Step 2: Schema Validation

Validate against the agentskills.io spec:

- **Required:** `name`, `description`
- **Recommended:** `license`, `metadata.version`
- **Optional:** `compatibility`, `allowed-tools`, `requires-secrets`, `requires-tools`

Auto-repairs that are safe:

- Missing `name`: derive from directory name (warn, don't fail)
- Missing `metadata.version`: default to `1.0.0`
- `description` shorter than 20 characters: warn (description quality is the triggering mechanism — short descriptions hurt)

Auto-repairs that are NOT safe (return invalid instead):

- Missing `description`: hard fail, this is the triggering mechanism
- Malformed `requires-secrets` structure: hard fail, prevents secret confusion
- Duplicate `name` in frontmatter and directory name mismatch: hard fail

### Step 3: Security Scan

Ripgrep across all scripts and referenced files for known-bad patterns. Default posture: **denylist + capability-mismatch**.

Denylist patterns to flag (hard block on match):

- **Filesystem exfiltration:** `cat ~/.ssh/`, `cat ~/.aws/`, `cat ~/.config/*/credentials`, references to `/etc/shadow`, `.env` file reads outside skill's own directory
- **Network exfiltration:** `curl` commands with file uploads (`-F @`, `-d @`), POST/PUT requests to non-standard domains paired with sensitive paths
- **Shell injection:** `eval $VAR` where VAR is unsanitized user input, `$(eval ...)` patterns
- **Obfuscation:** base64-encoded shell execution (`echo X | base64 -d | sh`), hex-encoded strings that decode to shell commands, unusual character encodings
- **Bypass attempts:** `--no-verify` flags on git operations, SSL verification disables in HTTP calls, setuid/setgid patterns

Capability-declaration vs actual behavior:

- If frontmatter declares `allowed-tools: [Bash]`, scripts must only use Bash. Any Python/Node execution → hard block.
- If declares `network: false`, no HTTP calls. Any `curl`, `wget`, `fetch` → hard block.
- If declares `filesystem: readonly`, no writes outside the skill's own directory. Writes to `~/`, `/tmp/`, `/etc/` → hard block.

### Step 4: Dedup Check

Compare against existing skills in storage:

1. **Exact duplicate:** content hash match → return existing skill name
2. **Near-exact:** description cosine similarity > 0.9 AND script overlap > 80% → return merge options
3. **Functional match:** description cosine similarity > 0.75 → return as suggestion but allow install
4. **Novel:** accept

For V1, use simple text similarity (TF-IDF cosine). V2 upgrades to embedding similarity once semantic search ships.

When a dedup match is found via `propose_skill`, the agent gets merge options:

- **Keep existing** (reject new)
- **Replace** (new supersedes old)
- **Merge** (combine improvements — requires agent to specify what to take from each)
- **Keep both** (create with suffix `-v2` or similar)

### Step 5: Description Optimization (V2)

For installed skills, optionally run the description optimization loop from Anthropic's skill-creator skill. Uses Claude to iteratively improve the description against a test query set, measuring trigger rate. This improves semantic search quality over time.

V1: skip this. Accept descriptions as-is.
V2: run on install for skills above a quality threshold; queue non-trivial changes for user review.

### Step 6: Signing

Generate an Ed25519 signature over the skill's contents (SKILL.md + all resource files) and store in `skills.lock`. On subsequent reads, verify signature hasn't changed — detects tampering (including benign tampering like a user editing the installed copy directly, which should fail drift checks).

V1: implement signing + storage, don't enforce verification yet (log mismatches only).
V2: enforce verification on `get_skill` — block if signature fails.

---

## Storage Model

```
~/.autovault/                          # local mode
├── config.yaml                        # user config (source adapters, secrets policy, etc.)
├── skills.lock                        # manifest of all installed skills
├── skills/
│   ├── autofix/
│   │   ├── SKILL.md
│   │   ├── .signature                 # Ed25519 signature over contents
│   │   └── scripts/
│   ├── code-review/
│   │   ├── SKILL.md
│   │   └── .signature
│   └── ...
└── cache/
    └── embeddings/                    # V2: vector cache for semantic search
```

**Remote mode (Docker):** same structure, but `/data/autovault/` mounted as a volume.

**`skills.lock`** extends AutoJack's existing format with signature + security-scan metadata:

```yaml
version: "2"
updated: "2026-04-19T00:00:00Z"
skills:
  autofix:
    version: "1.2.0"
    source: "github:verygoodplugins/autohub/blob/main/.agents/skills/autofix/SKILL.md"
    upstream_sha: "abc1234..."
    signature: "ed25519:base64..."
    installed_at: "2026-04-19T00:00:00Z"
    last_checked: "2026-04-19T00:00:00Z"
    security_scan: { status: "clean", patterns_checked: 47, scanned_at: "..." }
    capabilities: { network: false, filesystem: "readonly", tools: ["Bash"] }
    requires_secrets: []
```

---

## Source Adapters

V1 ships with two source adapters:

**GitHub URL adapter:**

- Accepts `https://github.com/org/repo/blob/ref/path/SKILL.md`
- Converts to raw URL, fetches content
- Also fetches sibling `scripts/`, `references/`, `assets/` directories
- Resolves current HEAD SHA for drift tracking
- Supports `ref` (branch, tag, or commit SHA) for pinning

**agentskills.io adapter:**

- Queries the agentskills.io registry API for skill metadata
- Follows the registry's pointer to the canonical GitHub source
- Falls through to the GitHub URL adapter for actual fetch

V2 candidates (add based on demand):

- ClawHub
- LobeHub
- Tessl registry
- Cursor marketplace
- Local filesystem path (for private/unpublished skills)

---

## The Meta-Skill: `autovault-skill`

This is the clever bit. AutoVault ships a single SKILL.md that teaches any skill-compatible agent how to use AutoVault — even agents that don't support MCP natively (OpenClaw today, possibly others in the future).

```markdown
---
name: autovault-skill
description: Access shared skill library via AutoVault. Use this whenever you need to find, install, or propose new skills. AutoVault is the authoritative source for installed skills; always check here before writing a new skill from scratch to avoid creating duplicates.
license: MIT
metadata:
  version: "1.0.0"
---

# AutoVault Meta-Skill

This skill teaches you how to interact with AutoVault, a shared skill library.

## Discovery

Check for AutoVault in this order:

1. Environment variable `AUTOVAULT_URL` — if set, use this remote URL
2. Local MCP server via `autovault` command — if available, use stdio
3. Config file `~/.autovault/config.yaml` — parse for URL or local path

## Finding existing skills

Before writing a new skill from scratch, ALWAYS search AutoVault first:
```

# via MCP

search_skills(query="what you want to accomplish", top_k=5)

# via HTTP

GET {AUTOVAULT_URL}/skills/search?query=...&top_k=5

```

If a match is returned with score > 0.7, load it with `get_skill` and use it
rather than creating a duplicate.

## Proposing new skills

If no existing skill matches, propose a new one:

```

propose_skill(skill_md="...", resources=[...])

```

AutoVault will validate and either accept, flag duplicates, or block on security.
Handle each response appropriately — don't fall back to writing directly to disk.

## ... (full instructions continue)
```

**Why this matters:** any agent that supports the agentskills.io spec can install this one skill and become AutoVault-compatible. OpenClaw doesn't need MCP support. Hermes doesn't need AutoVault-specific integration. They install the meta-skill, follow its instructions, done.

For agents with native MCP support (Claude Code, Cursor, Codex, AutoJack), the native MCP connection is faster and cleaner. But the meta-skill is the universal fallback.

---

## Authentication (Remote Mode)

V1: **OAuth 2.1**, single-user.

The MCP spec is converging on OAuth as the standard auth mechanism. Implementing it from day one avoids a painful migration later.

**V1 scope:**

- Single-user OAuth flow
- Standard scopes: `autovault:read` (list/search/get), `autovault:write` (install/propose), `autovault:admin` (config changes)
- Supports common identity providers: GitHub OAuth, Google OAuth, generic OIDC

**Deferred to V3+:**

- Workspace/team accounts with member-level permissions
- Per-skill ACLs (this skill visible to these users only)
- Service accounts for CI/CD agents

For local stdio mode, no auth — the MCP server runs as the user's own process, inherits their permissions.

---

## Deployment (Docker)

V1 ships a Docker image:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "src/server.js"]
```

Environment variables:

- `AUTOVAULT_MODE` — `local` (stdio) or `remote` (HTTP+SSE)
- `AUTOVAULT_STORAGE_PATH` — defaults to `/data/autovault` in remote mode
- `AUTOVAULT_OAUTH_ISSUER` — OAuth provider URL
- `AUTOVAULT_OAUTH_CLIENT_ID` + `AUTOVAULT_OAUTH_CLIENT_SECRET`
- `AUTOVAULT_SECURITY_STRICT` — if `true`, hard-block on any security flag instead of warn
- `AUTOVAULT_SEARCH_MODE` — `text` (V1) or `semantic` (V2)

Users deploy however they want: Railway, Fly, Cloud Run, Docker Compose on their own VPS, Kubernetes, whatever. The Docker image is the portable unit.

A `docker-compose.yml` ships with the repo for self-hosters who want a one-command setup.

---

## Secret Management

**Deferred.** Jack explicitly flagged this as wanting further brainstorming. V1 does not include a secret resolver.

**What's known so far:**

- Skills declare `requires-secrets` in frontmatter (names only, never values)
- The MCP server does NOT handle secrets — execution is agent-side
- Secrets live on whatever machine executes the skill
- Jason's SecretRef pattern (declaration + user-configured resolution) is the strong starting point
- Resolver sources: env vars, `exec` commands (1Password/Vault/sops/etc.), macOS Keychain, files

**Phase 2 deliverable:** a brainstorm session between Jack, Jason, Steve to finalize the secret-resolver architecture. Likely outcome: a separate `autovault-resolver` project or CLI tool that runs on the executing machine, read by skill scripts via a standard helper function.

For V1: document that `requires-secrets` is reserved syntax, AutoVault validates the field structure, users roll their own resolution. Rough and ready, unblocks everything else.

---

## What's Deferred

Explicitly out of scope for V1. Listed here so they don't get lost:

**V2 (next 4–6 weeks after V1):**

- Semantic search via local embeddings
- Description optimization loop (from skill-creator)
- Signature verification enforcement on `get_skill`
- Hermes filesystem watcher + post-hoc consolidation
- Additional source adapters: ClawHub, LobeHub, Tessl
- Secret resolver (after brainstorm)

**V3+ (future):**

- Dream cycles (auto-update, consolidation)
- Workspace/team authentication with per-skill ACLs
- Project sync for headless agents (the original V1 draft's sync script — still useful for Codex Cloud)
- Signing verification against upstream-published signatures (agentskills.io signs skills, AutoVault verifies)
- Web UI dashboard
- Skill authoring helpers (test-case runner, eval viewer, benchmark tools — essentially porting skill-creator into AutoVault)

---

## Phases and Concrete Steve Tasks

### Phase 1: V1 MVP (target: 2–3 weeks)

**Goal:** local stdio MCP server with validation gate, GitHub + agentskills.io adapters, existing skills migrated.

1. **Create the `autoworks/autovault` repo** (private). Grant push access to Jack, Jason, Zack, Daniel. Steve works via PRs from a fork for week 1; push access granted after first merged PR.
2. **Set up Node.js project.** `@modelcontextprotocol/sdk` for MCP, `yaml` for parsing, `tweetnacl` or `@noble/ed25519` for signing, `ripgrep` shell-out for security scanning.
3. **Migrate AutoJack's prototype files:**
   - Keep `README.md`, `CATALOG.md`, `skills.lock`, `package.json`
   - Keep `skill-manager/scripts/check-drift.js` — this logic is reused inside `check_updates` tool
   - The `skill-importer` and `skill-manager` SKILL.md files become _skills_ in the library (they're still useful as agent-invocable procedures), not core infrastructure
4. **Implement MCP server skeleton** — stdio transport, tool registration for the 7 core tools, basic request routing.
5. **Implement storage layer** — `~/.autovault/` directory structure, `skills.lock` read/write, atomic writes (temp file + rename).
6. **Implement validation gate:**
   - YAML parser + auto-repair
   - Schema validator (agentskills.io spec)
   - Security scanner (denylist patterns, capability mismatch check)
   - Dedup checker (text similarity V1)
   - Signature generation (Ed25519)
7. **Implement source adapters:**
   - GitHub URL (fetch + upstream SHA resolution)
   - agentskills.io registry query
8. **Implement the 7 core MCP tools** — wire them to validation gate + storage.
9. **Implement the meta-skill** (`autovault-skill/SKILL.md`) — bundle with the repo so it's installable via `install_skill` from a self-reference.
10. **Migrate existing autohub skills:**
    - `autofix`, `code-review`, `nightly-review` from `verygoodplugins/autohub/.agents/skills/`
    - Install into AutoVault via the validation gate (they should all pass cleanly)
    - Verify AutoHub's Codex nightly automation still runs — Codex needs updated instructions to `get_skill("nightly-review")` via AutoVault MCP instead of reading from `.agents/skills/`
11. **Write tests.** MCP tool round-trips, validation gate positive + negative cases, storage atomicity, signature generation and verification.
12. **Write `INSTALL.md`** — how users (including Jason/Zack/Daniel) install AutoVault and point their agents at it.
13. **Update AutoHub's `AGENTS.md` and `CLAUDE.md`** — reference AutoVault MCP for skills instead of local `.agents/skills/`.

**Phase 1 acceptance criteria:**

- Claude Code configured with AutoVault MCP can `list_skills`, `search_skills("code review")`, `get_skill("code-review")`, and execute it end-to-end.
- A skill with malformed YAML passed to `install_skill` returns a repaired version or a clear error.
- A skill containing `curl -d @~/.ssh/id_rsa` passed to `install_skill` returns `security_blocked`.
- An agent calling `propose_skill` with a skill near-duplicating `code-review` receives merge options, not a blind install.
- AutoHub's Codex nightly automation runs successfully against AutoVault-served skills.
- Jason can clone, install, and point his own agents at AutoVault on his machine.

### Phase 2: V2 Enhancements (target: 4–6 weeks after V1 ships)

Only start after V1 is stable in real use for at least 2 weeks.

1. **Semantic search** — local embeddings via `nomic-embed-text` (Ollama), replace text search in `search_skills`. Index on install, cache embeddings in `~/.autovault/cache/embeddings/`.
2. **Description optimization** — port skill-creator's optimization loop. Run on install for skills whose descriptions are below quality threshold.
3. **Signature verification enforcement** — `get_skill` fails if signature mismatch detected.
4. **Hermes filesystem watcher** — watch `~/.hermes/skills/` for new skills, post-hoc consolidation via `propose_skill`.
5. **Remote HTTP+SSE mode** — OAuth 2.1, Docker image, `docker-compose.yml`.
6. **Secret resolver** — after brainstorm with Jack + Jason.
7. **Additional source adapters** — ClawHub, LobeHub, Tessl.

### Phase 3+ Future

Don't plan these yet. Revisit after V2 has been running for a month. The space is moving fast — whatever we plan now will be wrong by then.

---

## Migration from AutoJack's Prototype

The existing `verygoodplugins/skills` repo (if it still exists with that name) has 6 files AutoJack created. Of those:

- **Keep as starting scaffolding:** `README.md`, `CATALOG.md`, `skills.lock`, `package.json`
- **Keep, refactor into core logic:** `skill-manager/scripts/check-drift.js` → `src/sources/github.js` (upstream SHA resolution) and `src/tools/check_updates.js`
- **Keep, reclassify as skills:** `skill-importer/SKILL.md` and `skill-manager/SKILL.md` → moved into `skills/` directory as user-facing skills about managing AutoVault (they'll be installable from within AutoVault, dogfooding the meta-skill pattern)

Then rename the repo to `autoworks/autovault` and continue development.

If the org `autoworks` isn't created yet, Steve's first task is to wait for Jack to create it. Don't start under a temporary name — migration mid-build is painful.

---

## Collaboration Model

- **Owner:** Jack (push access, final authority on scope)
- **Core contributors:** Jason, Zack, Daniel (push access, PR review)
- **Implementation:** Steve (PRs until trust established, then push access)
- **Repo visibility:** private until V1 is stable + battle-tested for 2+ months
- **PR flow:** feature branches, PR → at least one approval from Jack/Jason/Zack/Daniel → merge
- **Skill submissions:** come via PRs to the `skills/` directory. Any of the four collaborators can approve skill additions. Security-sensitive skills require two approvals.
- **CODEOWNERS:** `src/`, `package.json`, and anything in `scripts/security/` require Jack's approval.
- **Signed commits on main:** all collaborators configure GPG or SSH signing.

---

## Security Considerations

1. **The validation gate is the product.** Every security decision routes through it. If the gate has a bug, attackers have a vector. Code review on `src/validation/*` is treated as trust-critical.
2. **Private repo for V1.** Public release only after security pattern library has had eyes on it from multiple trusted reviewers.
3. **No secrets in the repo.** Ever. `~/.skills/secrets.yaml` or equivalent lives outside the repo.
4. **No binaries in the repo.** Skills are markdown + shell/node/python scripts. Any PR adding compiled artifacts auto-rejects.
5. **Audit log.** Every merge to main triggers a GitHub Action posting to a dedicated Slack channel (`#autovault-audit`). If something gets modified by an unexpected author, the team sees it immediately.
6. **Supply chain defense.** Skills fetched from agentskills.io are pinned to specific SHAs at install time. Drift from that SHA is detected on `check_updates` and requires explicit user approval before applying.
7. **Denylist pattern library is versioned.** `scripts/security/patterns.json` is a first-class artifact. Contributions to it require Jack's approval. Patterns are reviewed quarterly.

---

## Open Questions

1. **Does the AutoWorks org exist yet?** Jack needs to confirm creation before Steve starts. Default: create under `autoworks` — Jack create the org this week.
2. **Steve's access model.** PRs from fork for week 1, push access after first merged PR. Sound good?
3. **Test framework.** Vitest or Jest? (Steve's call — both work, Vitest is faster.)
4. **Does AutoHub migrate all its existing skills to AutoVault or just the three generic ones?** Default: migrate `autofix`, `code-review`, `nightly-review`. Keep workflow-style automations in AutoHub's `workflows/` directory — those aren't skills, they're workflows.
5. **Name of the `#autovault-audit` Slack channel** — create now so the GitHub Action can post there from day one.

---

## Timeline (Optimistic)

- **Week 1:** Scaffolding + storage + stdio MCP skeleton + GitHub adapter. Jack can `list_skills` on an empty library.
- **Week 2:** Validation gate + tools (`install_skill`, `get_skill`, `propose_skill`) + migration of autohub skills. AutoHub Codex nightly automation works end-to-end against AutoVault.
- **Week 3:** agentskills.io adapter + meta-skill + tests + docs. V1 ready for Jason/Zack/Daniel to try.

Three weeks is optimistic but achievable for a focused implementer. If Steve hits unexpected complexity on validation or MCP protocol quirks, extend to four.

V2 starts when V1 has been stable under real use for 2+ weeks.

---

## Final Note on Scope

Every decision on this project should be tested against one question: **does this make AutoVault better as a content-serving, validation-gating, dedup-aware skill library, or is it creeping toward being an execution runtime?**

If the latter, stop. Execution is the agent's job. AutoVault stores, validates, serves. That's the whole product.
