# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

AutoVault is a **capability library with local stdio and remote Streamable HTTP MCP entry points** that stores, validates, and serves agent `SKILL.md` files. It is Node/TypeScript (ESM, `NodeNext` modules, strict TS). It does **not** execute skills — it validates them and serves them to MCP hosts.

The local entry point `dist/index.js` is designed to be spawned by an MCP host (Codex, Cursor, Codex) over stdio. The remote entry point `dist/remote.js` exposes Streamable HTTP MCP at `/mcp` with OAuth-backed bearer auth. The `autovault` CLI also exposes library workflows such as profile sync and skill setup.

## Common commands

```bash
npm ci                             # install deps
npm run build                      # tsc → dist/
npm run dev                        # tsx watch (rebuild on save)
npm run start:remote               # run dist/remote.js after build
npm test                           # vitest run (one-shot)
npm run test:watch                 # vitest in watch mode
npx vitest run tests/dedup.test.ts # run a single test file
npx vitest run -t "name substring" # run tests matching a name
node scripts/bootstrap-skills.mjs  # seed bundled skills into $AUTOVAULT_STORAGE_PATH
node scripts/smoke.mjs             # end-to-end smoke (spawns dist/index.js)
node scripts/remote-smoke.mjs      # remote HTTP/OAuth smoke (spawns dist/remote.js)
node scripts/probe.mjs             # negative-path probing
```

The `bootstrap`/`smoke`/`probe`/`remote-smoke` scripts require `npm run build` first because they spawn compiled files from `dist/`.

## Architecture

### Request flow

`src/index.ts` → `loadConfig()` → `ensureStorage()` → `createServer()` (`src/mcp/server.ts`) registers the MCP tools, each wrapping a handler in `src/tools/`. Tool handlers return plain objects; `runTool` in `server.ts` serializes them to the MCP `content[0].text` envelope. Remote mode calls the same `createServer()` with a policy layer that enforces scopes and skill visibility.

### Validation pipeline (shared by `install_skill` and `propose_skill`)

Both write paths funnel through `validateSkillInput()` in `src/validation/index.ts`, which runs in this order:

1. `attemptRepair` (`frontmatter.ts`) — normalizes frontmatter formatting.
2. `parseFrontmatter` — gray-matter parse.
3. `validateSchema` (`schema.ts`) — zod schema for name/description/capabilities/etc.
4. `runSecurityScan` (`security.ts`) — denylist regex match against `scripts/security/patterns.json` (loaded lazily, cached).
5. `checkCapabilityDeclaration` (`capability.ts`) — cross-check declared capabilities against content (e.g. `network: false` vs. a `curl` in the body).

When `AUTOVAULT_SECURITY_STRICT=true` (default), any security flag blocks the write; when false, flags become warnings.

`propose_skill` additionally runs three-tier dedup (`validation/dedup.ts`): exact content-hash match, near-exact (≥0.9 Jaccard on tokenized content), functional (≥0.75). Tiers `exact`/`near_exact` reject; `functional` is a warning.

### Storage layout

Everything lives under `AUTOVAULT_STORAGE_PATH` (default `~/.autovault`, `~` expanded in `config.ts`):

```
$AUTOVAULT_STORAGE_PATH/
  .signing-key.json          # Ed25519 keypair, mode 0600, auto-generated
  skills/<name>/
    SKILL.md
    .autovault-source.json   # { source, identifier, upstreamSha?, contentHash, fetchedAt }
    .autovault-signature     # detached Ed25519 signature of SKILL.md, mode 0600
    <resource files...>
```

`writeSkill` (`src/storage/index.ts`) signs every write; `readSkill` verifies and **logs a warning on mismatch but still returns the skill** (V1 is log-only enforcement). Keep this in mind when touching signing code — tightening to hard enforcement is a deliberate V2 decision.

### Source adapters

`src/sources/{github,agentskills,url}.ts` each export a `fetch…` function returning `FetchedSkill`. `install_skill` picks one based on `input.source`. Remote bytes are untrusted and always pass through the validation pipeline before `writeSkill`.

### Skill name / resource path safety

- `src/util/skill-name.ts` — enforces `^[a-zA-Z0-9][a-zA-Z0-9-_]*$`, rejects `/`, `\`, `..`.
- `src/storage/index.ts::validateResourcePath` — rejects absolute paths and `..` segments, resolves under the skill root, and re-checks prefix. Use this for any new code that touches user-supplied paths.

### Logging

`src/util/log.ts` writes JSON lines to **stderr only**. Stdout is reserved for stdio MCP framing — never `console.log` or write to stdout from server code; it will corrupt local MCP sessions. Log level comes from `AUTOVAULT_LOG_LEVEL` (`debug`/`info`/`warn`/`error`).

### Config

`loadConfig()` (`src/config.ts`) is zod-validated and cached in a module-level variable. The cache is the reason `tests/setup.ts` calls `resetConfigCache()` + `resetSigningCache()` in both `beforeEach` and `afterEach` — if you change env vars in a test, you must reset the caches or they won't take effect.

## Testing conventions

- `tests/setup.ts` runs before every test: creates a temp dir, points `AUTOVAULT_STORAGE_PATH` at it, sets strict mode, error-level logs, and resets caches. `currentStorageRoot()` exposes the temp dir to tests that need it.
- Tests import from `src/` via the `.js` extension (ESM `NodeNext` requirement — keep this convention in new tests).
- Coverage is v8-based; `include: ["src/**/*.ts"]`.

## Bundled skills

The repo ships source-of-truth skill bundles under `skills/`; installed state lives in `$AUTOVAULT_STORAGE_PATH`. `scripts/bootstrap-skills.mjs` spawns the built server, installs every `skills/*/SKILL.md` through the real `add_skill` local-bundle path, and syncs/discovers host profiles so new bundled skills appear in Codex/Claude/Cursor roots. If a bundled skill fails validation after you edit it, the bootstrap will reject it; fix the content, don't bypass.

## Docs worth knowing

- `docs/THREAT-MODEL.md` — trust boundaries and the A1–A8 abuse cases each validation step maps to. Consult before changing the denylist or adding a source adapter.
- `docs/adr/0001-transport.md` — local stdio and remote Streamable HTTP transport strategy.
- `docs/RELEASE.md` — release/rollback procedure.
- `INSTALL.md` — MCP host config snippets for Codex / Cursor / Codex.
