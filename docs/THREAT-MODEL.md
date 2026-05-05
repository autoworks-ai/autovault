# AutoVault Threat Model

- Status: v1 (review by 2026-07-01)
- Owner: AutoVault maintainers
- Scope: AutoVault MCP server (stdio transport), local storage, and the
  remote source adapters (`github`, `agentskills`, `url`).

AutoVault stores and serves skill content. It does **not** execute skills.
The agent that consumes a skill is responsible for sandboxing, capability
checks, and user confirmation for any actions described in the skill.

## Trust Boundaries

1. **Host process boundary** - The MCP host (e.g. Cursor) is fully trusted
   to spawn the AutoVault process. Anyone who can launch the binary can
   invoke any tool. There is no in-process auth.
2. **Local storage boundary** - `AUTOVAULT_STORAGE_PATH` is treated as a
   trusted directory owned by the running user. AutoVault writes only under
   this path.
3. **Remote source boundary** - GitHub, agentskills.io, and arbitrary
   `https` URLs are **untrusted** content sources. Their bytes are subject
   to validation before persistence.

## Assets

- Skill content (`SKILL.md`, resources) - integrity matters; tampering can
  mislead downstream agents.
- Source provenance (`.autovault-source.json`) - integrity matters; used
  for drift checks.
- Operator credentials (e.g. `GITHUB_TOKEN`) - confidentiality matters.

## Abuse Cases and Mitigations

| ID | Abuse Case | Mitigation |
|----|------------|------------|
| A1 | Malicious skill includes shell commands intended to exfiltrate or destroy | Security denylist (`scripts/security/patterns.json`); strict mode blocks installs; agent is still responsible for execution decisions. |
| A2 | Path traversal via `read_skill_resource` or proposed resource paths | Reject absolute paths and `..`; resolve under skill root and re-check prefix. |
| A3 | Path traversal via skill name (e.g. `../etc`) | Reject names containing `/` or `..` at the tool boundary. |
| A4 | Source spoofing (a URL or repo serving different bytes on each fetch) | Persist content hash + upstream sha; `check_updates` reports drift. |
| A5 | Resource exhaustion via huge payloads (any source) | Bundle limits live in `src/util/limits.ts` and are enforced uniformly: declared resource count (50), per-resource bytes (1 MiB), total bundle bytes (5 MiB), SKILL.md size (256 KiB). `validateSkillInput` applies them to inline/propose/url; the GitHub adapter additionally checks `Content-Length` before reading remote bodies. |
| A6 | Credential leakage via logs | Logs are structured stderr only; tokens are never logged; values such as identifiers are logged but never auth headers. |
| A7 | Dependency supply chain compromise | `npm ci` in CI; `npm audit` gate; pin Node 20 in CI matrix. |
| A8 | Misconfiguration (typo'd env vars) | `loadConfig` uses zod; invalid values fail fast at startup. |
| A9 | Tampered bin script run via `autovault skill <action>` | Every declared bin file is covered by `.autovault-manifest` (Ed25519). The CLI verifies the signature **before** `execve` and refuses on mismatch. Hard enforcement, not log-only — exec is irreversible. |
| A10 | Secret leakage through agent tool-call logs during skill setup | Setup that handles secrets ships as a `bin` action. The agent's instruction is uniform (`autovault skill setup <name>`); the user runs the script in their own terminal. The secret never enters the agent transcript or MCP tool-call args. |
| A11 | Stale bin/resource lingering after a skill update drops it | `writeSkill` prunes any non-metadata file under the skill dir that isn't in the new bundle's resource set. Manifest signing/write failures throw rather than swallow, so the caller sees the failure and can retry/rollback. |
| A12 | Resource path escapes via a pre-existing parent symlink | `validateResourcePath` walks parent directories to the closest existing ancestor and rejects when its realpath leaves the skill root, so a leaf that doesn't yet exist still cannot ride a symlinked parent into the host filesystem. |
| A13 | Cross-skill or per-file signature lift via storage-root write access | Manifest signatures are domain-separated: every entry signs `"autovault-manifest-v2\0" + LP(skillName) + LP(filePath) + LP(content)`. Lifting a signature from skill A's `bin/setup` into skill B's manifest fails verification because the signed message embedded the original `(skillName, filePath)`. The manifest itself records the bound `skill`, so swapping a whole `.autovault-manifest` between directories also fails. Pre-fix v1 manifests are rejected by `parseManifest`; reinstall is the supported migration. |
| A14 | Source-metadata drift after a partial install | `.autovault-source.json` is written into the staged tmp directory before the rename, so the atomic swap delivers SKILL.md, resources, manifest, and source provenance together. A crash between the swap and a post-swap source write — the pre-fix window — would have left live bytes paired with stale provenance, defeating `check_updates`' content-hash drift signal. |

## Bin scripts: threat model deltas

Skills can declare a `bin` block (`bin.<action>.command` + `args[]`). The
agent never executes these — the user invokes them via
`autovault skill <action> <name>` from their own shell. This shifts the
trust model:

| Concern | Before bin support | With bin support |
|---|---|---|
| Secret in chat transcript | Yes if agent runs install/setup commands | No — user types in own terminal |
| Secret in agent tool-call logs | Yes | No |
| Secret on disk in plaintext (host config) | Yes (e.g. `~/.cursor/mcp.json`) | Yes (unchanged — that is how remote MCP works) |
| Tampered bin script post-install (static) | N/A (no exec path) | Caught — manifest signature verified before exec (hard refuse against pre-run tampering; see "Residual TOCTOU" below for the concurrent-race caveat) |
| Bin script ships malicious code | Caught at install (security denylist) | Caught at install (denylist applies to every resource, not just SKILL.md) |
| User runs setup before reviewing script | Possible | Possible — `autovault skill which <name> <action>` prints the resolved path so the user can read it first |
| Skill bypasses TTY guard via `requires-tty: false` | N/A | Hard-blocked — the CLI always requires a TTY regardless of skill metadata, and there is no env-var or config bypass (a per-process flag is settable by whoever spawns the CLI, so it cannot be a real wall). Users who need scripted automation invoke the script directly at its on-disk path (`$AUTOVAULT_STORAGE_PATH/skills/<name>/<bin.command>`), intentionally stepping outside the signed-exec path. The `skill which` output is a *human review* line — it shell-quotes args and appends a `# cwd:` annotation, neither of which round-trips through `bash $(autovault skill which …)`, so do not pipe `which` output into command substitution. |

**TTY check + `skill which` are advisory, not unbypassable.** An agent with the ability to allocate a pseudo-TTY (Node `pty`, Python `pexpect`) can pretend stdin is a terminal; an agent with shell access can compute the script path without `skill which` (the storage layout is `$AUTOVAULT_STORAGE_PATH/skills/<name>/<command>`). The hard boundary is **not** "the agent can't run the script." The hard boundaries are:
1. **Signature verification before exec** — the file the script runs is the bytes the author signed. A *static* attacker who tampers with the file post-install but before the user runs setup gets a hard refuse. (Hard-enforced for pre-run tampering. See "Residual TOCTOU" below for the limit.)
2. **The user types the secret at runtime** — the agent never holds the secret to pipe in. If the agent already has the secret, the secret is already in the transcript and the boundary was lost upstream.
The TTY check raises the bar against the simplest exfiltration path (e.g. `echo $SECRET | autovault skill setup foo`), but it does not, on its own, prove the script is being run by the human. Treat it as defense-in-depth, not an authorization gate.

**Residual TOCTOU between verify and exec.** Node has no `fexecve(2)`, so `spawn(target)` performs a fresh path lookup that the kernel re-reads regardless of the bytes we just verified. A *concurrent* same-UID attacker who can write the skill directory could swap the bin file between our verify call and the kernel's open-for-exec. We narrow the window by reading + verifying the bytes immediately before `spawn`, but we do not close it. This is acceptable because a same-UID concurrent attacker is already inside every other boundary on this host — they can read `~/.cursor/mcp.json`, edit the user's shell rc, etc. — so signed exec was never the right wall against them. The signed-exec boundary is meaningful against a *static* attacker (file tampered post-install before the user runs setup), and it is the integrity check that catches bit-rot or accidental local edits. Treat it as such; do not claim it stops a process racing the CLI in real time.
| Mid-fetch ref move (named ref → different commits per file) | N/A | Hard-blocked — the GitHub adapter resolves every install to a 40-char commit SHA before any fetch. Resolution failure aborts the install (no fallback to mutable refs). |

Capabilities apply to the **whole bundle**, not just SKILL.md. Once a skill
can ship bin scripts that the user is instructed to run, the capability
declaration must honestly summarize the whole skill's behavior — otherwise
the metadata is a UX trap (`network: false` while `bin/setup` calls `curl`
is exactly the case this would have hidden). The cross-check
(`src/validation/capability.ts`) runs the network/filesystem/tools patterns
against SKILL.md AND every resource. A flag is per-source so authors see
which file violates the declaration.

## Accepted Risks

- **The signing keypair lives inside the protected storage tree.** AutoVault
  generates an Ed25519 keypair at `$AUTOVAULT_STORAGE_PATH/.signing-key.json`
  and uses it to sign `SKILL.md`, declared bin scripts, and the manifest.
  Anyone with write access to the storage root can also overwrite the
  keypair and re-sign tampered bytes — the verifier loads its trust root
  from the same directory it is protecting, so manifest verification is
  not a defense against an attacker who already holds storage-root writes.
  This is a deliberate v1 trade: the storage root is owned by the same
  user who runs `autovault skill <action>`, so the trust domain ends at
  the user account and a co-equal writer is in-domain by definition.
  What the manifest **does** defend against:
  (a) drift introduced via the MCP API, which exposes no key-write tool;
  (b) accidental corruption (partial writes, copy-restore mistakes);
  (c) tampering by a process running with weaker filesystem privilege
      (e.g. a sandboxed agent that can read `~/.autovault/` but not write).
  The CLI's "hard-fail on signature mismatch" behavior is a tamper-detection
  signal, not a tamper-prevention guarantee against a same-uid attacker.
  Moving the keypair to an OS keychain or a separate trust root is a v2
  lift. Until then, treat storage-root write access as full vault compromise.
- AutoVault does not currently verify cryptographic signatures on remote
  skills. Operators relying on agentskills.io or arbitrary URLs are
  responsible for source trust.
- Security denylist is **assistive**, not exhaustive. It is intended to
  catch common abuse patterns and force review on flagged content.
- The agent that consumes a skill is the final authority on execution and
  must enforce capability/secret prompts.
- **Within-boot PID reuse on a stale lock.** The cross-process write lock
  (`.autovault-write-lock`) records the owner PID + start time + an
  unguessable token. Liveness combines `process.kill(pid, 0)` with a
  boot-epoch guard, so a crash + reboot cannot wedge the vault — the lock's
  `startedAt` predates the new boot and recovery reclaims it. Within a
  single boot, however, if a writer crashes and the OS later reuses that
  exact PID for an unrelated long-running process, AutoVault treats the
  lock as live and `withStorageLock` will time out every write after 10s.
  The remediation is operator-side: delete `.autovault-write-lock` from the
  storage root. We accept this rather than escalate to "reclaim aged-but-
  live locks", because that path was the round-25 finding — stealing a slow
  but legitimate writer's lock breaks mutual exclusion for far more common
  scenarios (debugger pauses, paged-out processes, IO stalls).

## Review Cadence

- Re-review on any new source adapter, new transport, or significant
  validation change.
- Re-review at least every six months.
