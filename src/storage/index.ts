import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { parseFrontmatter } from "../validation/frontmatter.js";
import type { SkillBinAction, SkillRecord, SkillSummary } from "../types.js";
import {
  parseManifest,
  signFiles,
  verifyContent,
  verifyFile,
  type SignedManifest
} from "../util/sign.js";
import { log } from "../util/log.js";
import { canonicalRelPath } from "../util/path.js";
import { MAX_RESOURCE_BYTES, MAX_SKILL_MD_BYTES } from "../util/limits.js";
import { tryWithStorageLock, withStorageLock } from "./lock.js";

const SOURCE_FILE = ".autovault-source.json";
const SIGNATURE_FILE = ".autovault-signature";
const MANIFEST_FILE = ".autovault-manifest";

// Reserved on-disk filenames a resource MUST NOT canonicalize to. Without this
// guard a caller-supplied resource named `SKILL.md` would overwrite the
// already-validated SKILL.md bytes during writeSkill — and the resulting file
// would still get a fresh manifest signature, so the install ships an
// attacker-controlled SKILL.md that was never validated. Same hazard for
// `.autovault-manifest` (signs itself), `.autovault-signature` (legacy), and
// `.autovault-source.json` (provenance). Compared case-insensitively because
// macOS APFS/HFS+ defaults are case-preserving but case-insensitive — a
// resource named `skill.md` would still overwrite `SKILL.md` on disk.
export const RESERVED_RESOURCE_PATHS = [
  "SKILL.md",
  MANIFEST_FILE,
  SIGNATURE_FILE,
  SOURCE_FILE
] as const;

// Path segments that, when used as object keys, do not behave like own
// properties: `__proto__` writes mutate Object.prototype on a plain object;
// `constructor` and `prototype` are reachable from `Object.create(null)`-free
// codepaths via lookups. The manifest map and any other path-keyed structure
// must never accept these names. We reject them at every position in the
// path (not just the first segment) because `bin/__proto__` would still bypass
// manifest signing for that single entry.
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function hasForbiddenPathSegment(canonical: string): boolean {
  return canonical.split("/").some((seg) => FORBIDDEN_PATH_SEGMENTS.has(seg));
}

export function isReservedResourcePath(canonical: string): boolean {
  // Reject when the FIRST canonical segment matches a reserved name. Without
  // segment-level matching, a path like `.autovault-source.json/payload` slips
  // past — validation accepts it, then writeSkill mkdirs `.autovault-source.json`
  // as a directory and the post-swap provenance write fails, leaving a partial
  // install without source metadata. Lowercase compare because macOS APFS
  // defaults are case-insensitive, so `Skill.md` and `SKILL.md` address the
  // same on-disk file.
  const firstSegment = canonical.split("/")[0]?.toLowerCase() ?? "";
  if (firstSegment.length === 0) return false;
  return RESERVED_RESOURCE_PATHS.some(
    (reserved) => reserved.toLowerCase() === firstSegment
  );
}

export type SkillSource = {
  source: "github" | "agentskills" | "url" | "inline" | "local";
  identifier: string;
  bundledSkillName?: string;
  version?: string;
  upstreamSha?: string;
  fetchedAt: string;
  contentHash: string;
};

function skillsDir(): string {
  return path.join(loadConfig().storagePath, "skills");
}

export function skillDir(name: string): string {
  return path.join(skillsDir(), name);
}

export async function ensureStorage(): Promise<void> {
  await fs.mkdir(skillsDir(), { recursive: true });
}

// writeSkill swaps via rename(live → bak) then rename(tmp → live). If the
// process is killed between those two renames, the live directory is gone but
// the .bak.<rand> sibling still holds the previous full install. Without
// recovery, listInstalledSkillNames hides that .bak.* entry (skill names
// disallow `.`) and the install becomes invisible — silently dropped.
//
// CRITICAL: this runs ONCE at server boot, NOT from `ensureStorage`. Recovery
// inspects `.tmp.*` and `.bak.*` siblings — exactly the names writeSkill
// uses transiently during normal operation. Calling it from ensureStorage
// would race a concurrent install: a `list_skills` request mid-write could
// delete the active staging dir or roll a fresh backup back over the live
// install. Server-startup-only is the simplest correct lifecycle for v1.
//
// Multi-process guard: AutoVault is stdio-hosted, so a single user can have
// multiple server processes sharing one $AUTOVAULT_STORAGE_PATH (Claude Code
// + Cursor + Codex all spawning their own server). Each boots and tries to
// recover, but recovery is destructive — it sweeps .tmp.* and .bak.* dirs
// that an active writeSkill in another process is currently using as staging.
// Gate recovery behind tryWithStorageLock: if another live process holds the
// write lock (i.e. is mid-install), skip recovery this boot. Recovery is a
// startup nicety; missing one boot is fixed by the next start. Racing an
// active writer is not.
//
// On startup, scan the skills root: for any `<name>.bak.*` directory whose
// `<name>` has no live counterpart, rename the bak back to live. This restores
// the previous install on crash. We also clean up `<name>.tmp.*` directories
// (always orphaned debris from a failed staging) regardless of whether live
// exists.
export async function recoverOrphanBackups(): Promise<void> {
  await tryWithStorageLock(async () => {
    let entries;
    try {
      entries = await fs.readdir(skillsDir(), { withFileTypes: true });
    } catch {
      return;
    }
    const presentLiveDirs = new Set<string>();
    const baks: Array<{ name: string; full: string; suffix: string }> = [];
    const tmps: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!name.includes(".")) {
        presentLiveDirs.add(name);
        continue;
      }
      const tmpIdx = name.indexOf(".tmp.");
      if (tmpIdx > 0) {
        tmps.push(path.join(skillsDir(), name));
        continue;
      }
      const bakIdx = name.indexOf(".bak.");
      if (bakIdx > 0) {
        baks.push({
          name: name.slice(0, bakIdx),
          full: path.join(skillsDir(), name),
          suffix: name.slice(bakIdx)
        });
      }
    }
    // Roll forward bak → live when the live counterpart is missing. Multiple
    // baks for the same name are unlikely (rename(live, bak) only succeeds when
    // bak is unique), but if they collide pick the lexicographically last
    // (newest timestamp suffix) and tear down the rest.
    const baksByName = new Map<string, typeof baks>();
    for (const bak of baks) {
      if (presentLiveDirs.has(bak.name)) continue;
      const list = baksByName.get(bak.name) ?? [];
      list.push(bak);
      baksByName.set(bak.name, list);
    }
    for (const [name, list] of baksByName) {
      list.sort((a, b) => b.suffix.localeCompare(a.suffix));
      const [keep, ...drop] = list;
      try {
        await fs.rename(keep.full, path.join(skillsDir(), name));
      } catch {
        // If rollback fails, leave the bak in place; next startup will retry.
      }
      for (const extra of drop) {
        await fs.rm(extra.full, { recursive: true, force: true }).catch(() => {});
      }
    }
    // Stale tmp dirs: always safe to remove. They are by construction
    // partial writes whose manifest was never produced.
    for (const tmp of tmps) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
}

// Unlocked reader for callers that already hold the storage lock (e.g.
// profiles/sync.ts builds its keep-set inside a single lock acquisition so the
// snapshot is coherent across many readSkill calls). Takes no lock itself —
// re-entering withStorageLock from a holder would deadlock because the file
// lock is non-reentrant.
export async function listInstalledSkillNamesUnlocked(): Promise<string[]> {
  const entries = await fs.readdir(skillsDir(), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    // writeSkill stages into `<name>.tmp.<rand>` and briefly creates
    // `<name>.bak.<rand>` during the swap. Skill names disallow `.` (see
    // util/skill-name.ts), so any dir containing a dot is a transient
    // artifact and must not be reported as installed.
    if (entry.name.includes(".")) continue;
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      const stat = await fs.stat(path.join(skillsDir(), entry.name));
      if (stat.isDirectory()) names.push(entry.name);
    } catch {
      // Ignore broken symlinks; profile sync can clean those up.
    }
  }
  return names;
}

export async function listInstalledSkillNames(): Promise<string[]> {
  await ensureStorage();
  // Round-54: take the storage lock for the readdir + per-entry stat pair so
  // a concurrent writeSkill swap (live → bak rename, then tmp → live rename)
  // cannot expose us to the transient window where the live skill directory
  // is briefly absent. Without the lock, an unlocked reader in another
  // stdio server process could observe ENOENT and report the in-flight
  // skill as missing — silently dropping it from list_skills, search, and
  // profile sync until the next read.
  return withStorageLock(() => listInstalledSkillNamesUnlocked());
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asSecretsArray(
  value: unknown
): Array<{ name: string; description?: string; required?: boolean }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      name: String(item.name ?? ""),
      description: typeof item.description === "string" ? item.description : undefined,
      required: typeof item.required === "boolean" ? item.required : undefined
    }))
    .filter((entry) => entry.name.length > 0);
}

function asResourcesArray(value: unknown): Array<{ path: string; type: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      path: String(item.path ?? ""),
      type: typeof item.type === "string" ? item.type : "file"
    }))
    .filter((entry) => entry.path.length > 0);
}

// Exported so callers (CLI exec path) can derive bin metadata from already
// verified SKILL.md bytes without a second on-disk read that could race a
// concurrent swap.
export function asBinBlock(value: unknown): Record<string, SkillBinAction> {
  if (typeof value !== "object" || value === null) return {};
  const block: Record<string, SkillBinAction> = {};
  for (const [action, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const command = typeof entry.command === "string" ? entry.command : "";
    if (command.length === 0) continue;
    const args = asStringArray(entry.args);
    const description = typeof entry.description === "string" ? entry.description : undefined;
    const requiresTtyRaw = entry["requires-tty"];
    const requiresTty = typeof requiresTtyRaw === "boolean" ? requiresTtyRaw : true;
    block[action] = { command, args, description, requiresTty };
  }
  return block;
}

export function declaredBinPaths(bin: Record<string, SkillBinAction>): Set<string> {
  const paths = new Set<string>();
  for (const action of Object.values(bin)) {
    if (action.command.length > 0) paths.add(canonicalRelPath(action.command));
  }
  return paths;
}

function asCapabilities(value: unknown): SkillRecord["capabilities"] {
  const fallback: SkillRecord["capabilities"] = {
    network: false,
    filesystem: "readonly",
    tools: []
  };
  if (typeof value !== "object" || value === null) return fallback;
  const cap = value as Record<string, unknown>;
  return {
    network: typeof cap.network === "boolean" ? cap.network : fallback.network,
    filesystem: cap.filesystem === "readwrite" ? "readwrite" : "readonly",
    tools: asStringArray(cap.tools)
  };
}

function buildSummary(name: string, frontmatter: Record<string, unknown>): SkillSummary {
  const metadata = (frontmatter.metadata ?? {}) as Record<string, unknown>;
  return {
    name: asString(frontmatter.name, name),
    description: asString(frontmatter.description, ""),
    version: asString(metadata.version, "0.0.0"),
    tags: asStringArray(frontmatter.tags),
    category: typeof frontmatter.category === "string" ? frontmatter.category : undefined,
    agents: asStringArray(frontmatter.agents)
  };
}

// Unlocked reader for callers that already hold the storage lock (see
// listInstalledSkillNamesUnlocked rationale).
export async function readSkillUnlocked(name: string): Promise<SkillRecord | null> {
  const skillPath = path.join(skillDir(name), "SKILL.md");
  try {
    // Round-51 fix: stat-first cap on the on-disk SKILL.md. Every write path
    // already enforces MAX_SKILL_MD_BYTES via checkBundleLimits, but a legacy
    // pre-cap install or a manually-tampered skill directory can still hold a
    // multi-megabyte SKILL.md. propose_skill calls readSkill for every
    // installed skill on each invocation; without this guard, one polluted
    // skill turns every proposal into an unbounded fs.readFile + parse +
    // tokenize + hash on that file. Skip oversized installs the same way the
    // resource walker does — log loud, return null, let dedup proceed without
    // the polluted entry.
    const stat = await fs.stat(skillPath);
    if (stat.size > MAX_SKILL_MD_BYTES) {
      log.warn("storage.skill_md_oversize", {
        name,
        bytes: stat.size,
        max: MAX_SKILL_MD_BYTES
      });
      return null;
    }
    const skillMd = await fs.readFile(skillPath, "utf-8");
    await verifySignatureIfPresent(name, skillMd);
    const { data } = parseFrontmatter(skillMd);
    const summary = buildSummary(name, data);
    return {
      ...summary,
      skillMd,
      resources: asResourcesArray(data.resources),
      capabilities: asCapabilities(data.capabilities),
      requiresSecrets: asSecretsArray(data["requires-secrets"]),
      bin: asBinBlock(data.bin)
    };
  } catch {
    return null;
  }
}

export async function readSkill(name: string): Promise<SkillRecord | null> {
  // Round-54: serialize SKILL.md + manifest read against writeSkill's swap
  // window. Without the lock, a concurrent install in another stdio server
  // process can rename live → bak between our stat and our readFile, leaving
  // us with a stale handle (or ENOENT, depending on platform) and returning
  // null even though the skill is fully installed both before and after the
  // swap.
  return withStorageLock(() => readSkillUnlocked(name));
}

async function readManifestRaw(name: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(skillDir(name), MANIFEST_FILE), "utf-8");
  } catch {
    return null;
  }
}

async function readManifest(name: string): Promise<SignedManifest | null> {
  const raw = await readManifestRaw(name);
  if (raw === null) return null;
  return parseManifest(raw);
}

async function verifySignatureIfPresent(name: string, skillMd: string): Promise<void> {
  // A manifest file that exists but is corrupt or missing the SKILL.md entry
  // must still surface a warning — silently falling through to the legacy
  // detached-signature path (which writeSkill deletes on every modern install)
  // would mean a deliberately corrupted manifest hides tampering.
  const raw = await readManifestRaw(name);
  if (raw !== null) {
    const manifest = parseManifest(raw);
    if (!manifest) {
      log.warn("storage.signature_mismatch", {
        name,
        file: "SKILL.md",
        reason: "manifest_corrupt"
      });
      return;
    }
    const result = await verifyFile(manifest, name, "SKILL.md", skillMd);
    if (!result.present) {
      log.warn("storage.signature_mismatch", {
        name,
        file: "SKILL.md",
        reason: "manifest_missing_skillmd"
      });
    } else if (!result.valid) {
      log.warn("storage.signature_mismatch", { name, file: "SKILL.md" });
    }
    return;
  }
  // Legacy: detached SKILL.md signature, written before manifests existed.
  const signaturePath = path.join(skillDir(name), SIGNATURE_FILE);
  let signature: string | null = null;
  try {
    signature = (await fs.readFile(signaturePath, "utf-8")).trim();
  } catch {
    signature = null;
  }
  if (signature === null) {
    // No manifest AND no legacy signature: either a hand-built install or an
    // attacker deleted the integrity file to silence tamper warnings on a
    // mutated SKILL.md. writeSkill always writes a manifest, so on any skill
    // produced by this codebase reaching this branch is suspicious.
    log.warn("storage.signature_mismatch", {
      name,
      file: "SKILL.md",
      reason: "no_integrity_file"
    });
    return;
  }
  const ok = await verifyContent(skillMd, signature);
  if (!ok) {
    log.warn("storage.signature_mismatch", { name, file: "SKILL.md" });
  }
}

export async function readSkillManifest(name: string): Promise<SignedManifest | null> {
  return readManifest(name);
}

export type IntegrityMismatchReason =
  | "missing_on_disk"
  | "signature_invalid"
  | "not_covered"
  | "missing_from_manifest"
  | "unmanifested_file";

export type SkillIntegrityStatus =
  | { kind: "ok" }
  | { kind: "no_manifest" }
  | { kind: "manifest_corrupt" }
  | {
      kind: "tampered";
      mismatches: Array<{
        file: string;
        reason: IntegrityMismatchReason;
      }>;
    };

// Round-55: walk the signed manifest and verify each entry's on-disk bytes
// against its recorded signature so check_updates can fail closed on local
// tampering instead of inheriting the log-only readSkill behavior.
//
// Round-57 hardening: the manifest itself is unsigned (its `files` map is
// authoritative for membership), so a local tamperer who deletes an entry
// from .autovault-manifest and mutates the corresponding file would slip
// past a "iterate manifest.files keys and verify each" loop — the deleted
// key is simply never checked. Fix the membership gap by also requiring an
// expected key set to be present:
//   - SKILL.md (always)
//   - .autovault-source.json (always — every install records source data)
//   - every resources[].path declared in SKILL.md frontmatter
//   - every bin.<action>.command path declared in SKILL.md frontmatter
// SKILL.md is verified first so its frontmatter is trustworthy before we
// derive expected resources/bins from it. After membership is enforced,
// every manifest entry (required or extra) is verified against on-disk
// bytes; missing or unsigned-bytes-on-disk surfaces as tampered.
//
// Lock: take the storage lock for the entire walk so the manifest map and
// the file bytes we verify against it are both read from a single coherent
// post-swap snapshot, not split across a concurrent writeSkill.
export async function verifyInstalledIntegrity(
  name: string
): Promise<SkillIntegrityStatus> {
  return withStorageLock(() => verifyIntegrityLocked(name));
}

// Round-62: split the integrity walk from its lock acquisition so callers
// that already hold the storage lock (e.g. readVerifiedSkillResource) can
// run the same gate without re-entering the lock — the file lock is not
// reentrant, so a nested withStorageLock would deadlock for 10s and throw.
// Public callers must continue to use verifyInstalledIntegrity above.
async function verifyIntegrityLocked(
  name: string
): Promise<SkillIntegrityStatus> {
  {
    const raw = await readManifestRaw(name);
    if (raw === null) return { kind: "no_manifest" };
    const parsed = parseManifest(raw);
    if (!parsed) return { kind: "manifest_corrupt" };
    const manifest: SignedManifest = parsed;
    const root = skillDir(name);
    const resolvedRoot = path.resolve(root);
    const realRoot = realpathIfExists(root) ?? resolvedRoot;
    const mismatches: Array<{ file: string; reason: IntegrityMismatchReason }> = [];
    const verified = new Set<string>();

    async function readManifestEntry(
      filePath: string,
      maxBytes: number
    ): Promise<{ kind: "ok"; content: string } | { kind: "mismatch"; reason: IntegrityMismatchReason }> {
      const target = path.join(root, filePath);
      const resolved = path.resolve(target);
      if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        return { kind: "mismatch", reason: "signature_invalid" };
      }

      let stat: fsSync.Stats;
      try {
        stat = await fs.lstat(target);
      } catch {
        return { kind: "mismatch", reason: "missing_on_disk" };
      }

      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { kind: "mismatch", reason: "unmanifested_file" };
      }
      if (stat.size > maxBytes) {
        return { kind: "mismatch", reason: "signature_invalid" };
      }

      const realTarget = realpathIfExists(target);
      if (realTarget !== null && !isWithinRoot(realTarget, realRoot)) {
        return { kind: "mismatch", reason: "unmanifested_file" };
      }

      try {
        return { kind: "ok", content: await fs.readFile(target, "utf-8") };
      } catch {
        return { kind: "mismatch", reason: "missing_on_disk" };
      }
    }

    async function verifyEntry(filePath: string, maxBytes: number): Promise<string | null> {
      const read = await readManifestEntry(filePath, maxBytes);
      if (read.kind === "mismatch") {
        mismatches.push({ file: filePath, reason: read.reason });
        return null;
      }
      const content = read.content;
      const result = await verifyFile(manifest, name, filePath, content);
      if (!result.present) {
        mismatches.push({ file: filePath, reason: "not_covered" });
      } else if (!result.valid) {
        mismatches.push({ file: filePath, reason: "signature_invalid" });
      } else {
        verified.add(filePath);
        return content;
      }
      return null;
    }

    // Step 1: verify SKILL.md before trusting its frontmatter to derive the
    // required-key set. If SKILL.md is missing, unverified, or unsigned,
    // we fall through to membership checks against a minimal required set
    // (SKILL.md + source.json) so the failure still surfaces.
    const skillMdContent = await verifyEntry("SKILL.md", MAX_SKILL_MD_BYTES);

    // Step 2: derive the required key set. Only consult SKILL.md frontmatter
    // when its signature verified — otherwise an attacker who tampers
    // SKILL.md to remove resource/bin declarations would shrink the required
    // set and slip extra mutations past membership.
    //
    // Round-60 note: SOURCE_FILE is intentionally NOT in the initial required
    // set. Source-less installs (e.g. test harnesses calling writeSkill
    // without a `source` argument) legitimately have no source.json. Attacker
    // scenarios involving source.json are still caught: Step 4 verifies any
    // manifest entry pointing at source.json (so deletion → missing_on_disk
    // and tampering → signature_invalid), and Step 5 walks the live directory
    // (so a rogue source.json without a manifest entry → unmanifested_file).
    const requiredKeys = new Set<string>(["SKILL.md"]);
    if (verified.has("SKILL.md") && skillMdContent !== null) {
      try {
        const { data } = parseFrontmatter(skillMdContent);
        for (const resource of asResourcesArray(data.resources)) {
          if (resource.path.length > 0) requiredKeys.add(canonicalRelPath(resource.path));
        }
        for (const binPath of declaredBinPaths(asBinBlock(data.bin))) {
          requiredKeys.add(binPath);
        }
      } catch {
        // Frontmatter parse failed despite a valid signature — treat as
        // tampered so the user reinstalls. Surface as a SKILL.md
        // signature_invalid mismatch since the signed bytes no longer
        // round-trip through our parser cleanly.
        mismatches.push({ file: "SKILL.md", reason: "signature_invalid" });
      }
    }

    // Step 3: enforce manifest membership for every required key. This is
    // the round-57 fix — without it, a removed manifest entry was simply
    // never checked, so paired SKILL.md / bin tampering would go silent.
    for (const required of requiredKeys) {
      if (!Object.hasOwn(manifest.files, required)) {
        mismatches.push({ file: required, reason: "missing_from_manifest" });
      }
    }

    // Step 4: verify every manifest entry on disk. Includes both required
    // and extra entries so an attacker who adds a stale extra entry still
    // produces a missing_on_disk or invalid-bytes mismatch.
    for (const filePath of Object.keys(manifest.files)) {
      if (verified.has(filePath)) continue;
      await verifyEntry(
        filePath,
        filePath === "SKILL.md" ? MAX_SKILL_MD_BYTES : MAX_RESOURCE_BYTES
      );
    }

    // Step 5 (round-58/61 hardening): walk the live skill directory and
    // reject any entry that is NOT covered by the manifest. Without this, an
    // attacker can drop an unsigned helper (e.g. lib/helper.sh) alongside a
    // signed bin script — the bin script runs with cwd set to the skill
    // directory, so a wrapper that `source`s a sibling file would pull in
    // unsigned code without modifying any signed entry. Round-61 widens the
    // walk beyond regular files + symlinks: an empty control directory or a
    // FIFO at a path the script reads from also alters behavior without
    // changing any manifest entry, so the integrity check now flags them.
    //
    // Allowed directory set: derived from manifest file paths (every parent
    // segment of every manifested file). A directory present on disk that
    // isn't in this set has no manifest-recorded contents — flagged.
    const allowedDirs = new Set<string>();
    for (const filePath of Object.keys(manifest.files)) {
      const parts = filePath.split("/");
      for (let i = 1; i < parts.length; i++) {
        allowedDirs.add(parts.slice(0, i).join("/"));
      }
    }

    const metadataNames = new Set<string>([MANIFEST_FILE, SIGNATURE_FILE]);
    const liveEntries = await walkLiveFiles(root);
    for (const live of liveEntries) {
      if (live.type === "symlink" || live.type === "special") {
        // writeSkill never produces these under the skill dir, so any such
        // entry is hostile injection regardless of name.
        mismatches.push({ file: live.path, reason: "unmanifested_file" });
        continue;
      }
      if (live.type === "directory") {
        if (allowedDirs.has(live.path)) continue;
        mismatches.push({ file: live.path, reason: "unmanifested_file" });
        continue;
      }
      // file
      if (live.path.indexOf("/") === -1 && metadataNames.has(live.path)) continue;
      if (Object.hasOwn(manifest.files, live.path)) continue;
      mismatches.push({ file: live.path, reason: "unmanifested_file" });
    }

    if (mismatches.length === 0) return { kind: "ok" };
    return { kind: "tampered", mismatches };
  }
}

// Round-62: read path now runs the full open-set integrity walk (incl.
// unmanifested files / dirs / special files) before serving bytes. Earlier
// the read tool only verified the requested file's signature, so an install
// with a valid signed resource plus an injected sibling helper / FIFO /
// control directory would still return the resource as trusted. The MCP
// caller couldn't tell the install was tampered. Hold one storage lock for
// the integrity walk + resource verify so the result is from a coherent
// snapshot — no TOCTOU between gate and read.
export type ReadVerifiedResourceResult =
  | { kind: "ok"; content: string }
  | { kind: "no_manifest" }
  | { kind: "manifest_corrupt" }
  | {
      kind: "tampered";
      mismatches: Array<{ file: string; reason: IntegrityMismatchReason }>;
    }
  | { kind: "not_covered"; resource: string }
  | { kind: "signature_invalid"; resource: string }
  | { kind: "missing_on_disk"; resource: string };

export type ReadVerifiedResourcesResult =
  | { kind: "ok"; resources: Array<{ path: string; content: string }> }
  | Exclude<ReadVerifiedResourceResult, { kind: "ok" }>;

export async function readVerifiedSkillResource(
  name: string,
  resourcePath: string
): Promise<ReadVerifiedResourceResult> {
  const result = await readVerifiedSkillResources(name, [resourcePath]);
  if (result.kind !== "ok") return result;
  const resource = result.resources[0];
  if (!resource) {
    return { kind: "missing_on_disk", resource: canonicalRelPath(resourcePath) };
  }
  return { kind: "ok", content: resource.content };
}

export async function readVerifiedSkillResources(
  name: string,
  resourcePaths: string[]
): Promise<ReadVerifiedResourcesResult> {
  // Path-shape + live-probe sanity check before taking the lock. If the live
  // tree is parent-symlink-corrupted, this throws "escapes skill directory"
  // before integrity gets a chance — same outcome (refuse), different
  // message, defense-in-depth above the lock.
  const requests = resourcePaths.map((resourcePath) => ({
    key: canonicalRelPath(resourcePath),
    fullPath: validateResourcePath(name, resourcePath)
  }));
  return withStorageLock(async () => {
    const integrity = await verifyIntegrityLocked(name);
    if (integrity.kind !== "ok") return integrity;
    const raw = await readManifestRaw(name);
    if (raw === null) return { kind: "no_manifest" };
    const manifest = parseManifest(raw);
    if (!manifest) return { kind: "manifest_corrupt" };
    const resources: Array<{ path: string; content: string }> = [];
    for (const request of requests) {
      let content: string;
      try {
        content = await fs.readFile(request.fullPath, "utf-8");
      } catch {
        return { kind: "missing_on_disk", resource: request.key };
      }
      const result = await verifyFile(manifest, name, request.key, content);
      if (!result.present) return { kind: "not_covered", resource: request.key };
      if (!result.valid) return { kind: "signature_invalid", resource: request.key };
      resources.push({ path: request.key, content });
    }
    return { kind: "ok", resources };
  });
}

type LiveEntryType = "file" | "symlink" | "directory" | "special";

// Round-61 fix: emit every dirent type — not just regular files and symlinks.
// Bin scripts run with cwd=skillDir, so a post-install FIFO/socket/device at
// a path the script reads from (or an empty control directory the script
// existence-checks) can change exec behavior without modifying any manifest
// entry. Directories used to be silently skipped if they had no children;
// special files were ignored entirely. Both are now reported so the Step 5
// open-set check in verifyInstalledIntegrity can flag them. writeSkill never
// produces symlinks, special files, or empty intermediate directories that
// aren't already implied by a manifest path, so any such entry is hostile.
async function walkLiveFiles(
  root: string
): Promise<Array<{ path: string; type: LiveEntryType }>> {
  const out: Array<{ path: string; type: LiveEntryType }> = [];
  async function walk(current: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out.push({ path: rel, type: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        out.push({ path: rel, type: "directory" });
        await walk(path.join(current, entry.name), rel);
      } else if (entry.isFile()) {
        out.push({ path: rel, type: "file" });
      } else {
        // FIFO, socket, block/char device — never produced by writeSkill, so
        // any such entry under the skill dir is a post-install injection.
        out.push({ path: rel, type: "special" });
      }
    }
  }
  await walk(root, "");
  return out;
}

export type SkillManifestStatus =
  | { kind: "present"; manifest: SignedManifest }
  | { kind: "corrupt" }
  | { kind: "absent" };

// Distinguish "manifest file exists but unparseable" from "manifest file is
// missing entirely" so readers (read_skill_resource, future tools) can mirror
// readSkill's behavior of warning in either case rather than silently skipping
// integrity checks when the file isn't there.
export async function readSkillManifestStatus(name: string): Promise<SkillManifestStatus> {
  const raw = await readManifestRaw(name);
  if (raw === null) return { kind: "absent" };
  const manifest = parseManifest(raw);
  if (!manifest) return { kind: "corrupt" };
  return { kind: "present", manifest };
}

export async function readSkillSummary(name: string): Promise<SkillSummary | null> {
  const record = await readSkill(name);
  if (!record) return null;
  return {
    name: record.name,
    description: record.description,
    version: record.version,
    tags: record.tags,
    category: record.category,
    agents: record.agents
  };
}

export type WrittenResource = { path: string; content: string; mode?: number };

// Stage every byte of a write into a freshly-created sibling directory, then
// rename live → backup, tmp → live, rm backup. Both renames live within
// skillsDir so they are POSIX-atomic, and the live skill directory is either
// the previous full install or the new full install — never a partially
// migrated mix. A failure during staging (resource write, signing, manifest
// write, disk full) leaves the live install untouched and tears down the tmp
// dir.
export async function writeSkill(
  name: string,
  skillMd: string,
  resources: WrittenResource[] = [],
  source?: SkillSource
): Promise<void> {
  // Hold the storage write lock for the WHOLE write — staging through swap
  // through cleanup. The lock isn't just protecting the rename pair; it also
  // protects the .tmp.<rand> staging directory from another process's
  // recoverOrphanBackups() sweep. recovery deletes any .tmp.* it sees, which
  // would torch an active writer's staging dir if it ran concurrently.
  await withStorageLock(async () => {
  const liveDir = skillDir(name);
  const suffix = `.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmpDir = `${liveDir}${suffix}`;

  let bin: Record<string, SkillBinAction> = {};
  try {
    const { data } = parseFrontmatter(skillMd);
    bin = asBinBlock(data.bin);
  } catch {
    bin = {};
  }
  const binPaths = declaredBinPaths(bin);

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "SKILL.md"), skillMd, "utf-8");

    for (const resource of resources) {
      // Round-60 fix: validate against the freshly-created tmpDir, not the
      // live skill directory. The live-root variant probes the on-disk
      // ancestors and refuses paths whose realpath escapes — correct for
      // in-place writes/reads, but wrong here because a corrupted live install
      // (e.g. `skills/<name>/bin` left as a symlink to /tmp by a partial
      // write or attacker) would reject reinstall of the very bytes that
      // replace it. Path-shape invariants (traversal, reserved, forbidden
      // segments) still trip identically; only the ancestor walk is rerouted.
      validateStagedResourcePath(tmpDir, resource.path);
      const relCanonical = canonicalRelPath(resource.path);
      if (relCanonical.length === 0) {
        throw new Error(`Invalid resource path: ${resource.path}`);
      }
      const targetAbs = path.join(tmpDir, relCanonical);
      const mode = resource.mode ?? (binPaths.has(relCanonical) ? 0o755 : 0o644);
      await fs.mkdir(path.dirname(targetAbs), { recursive: true });
      await fs.writeFile(targetAbs, resource.content, { encoding: "utf-8", mode });
      await fs.chmod(targetAbs, mode);
    }

    // Determine source bytes BEFORE signing so `.autovault-source.json` can be
    // bound into the manifest alongside SKILL.md and resources. Either:
    //   (a) the caller passed `source` for this install — serialize it.
    //   (b) the caller did not — carry forward the prior install's source so
    //       a writeSkill that doesn't refresh provenance (rare; tests only)
    //       doesn't blank out a legitimate upstream record.
    // Round-54: Before this fix the source.json was written AFTER signFiles,
    // so the manifest never covered it. check_updates trusts
    // source.contentHash / upstreamSha to decide up_to_date vs drifted; an
    // attacker with FS write access could rewrite source.json to claim any
    // contentHash and silently produce false "up_to_date" verdicts for
    // tampered bytes. Binding source.json into the signed manifest closes
    // that window — readSkillSource refuses to return source bytes whose
    // signature does not verify against the recorded manifest.
    let sourceContent: string | null = null;
    if (source) {
      sourceContent = JSON.stringify(source, null, 2);
    } else {
      try {
        sourceContent = await fs.readFile(path.join(liveDir, SOURCE_FILE), "utf-8");
      } catch {
        sourceContent = null;
      }
    }

    // Sign SKILL.md + every resource + source.json (when present). Failure
    // here propagates and the swap never runs — the prior install (if any)
    // is intact.
    // Null-prototype map for the same reason signFiles uses one — a path
    // equal to `__proto__` must not silently route writes onto Object.prototype
    // and disappear from the manifest. Validation rejects those names too;
    // this is the second wall.
    const files: Record<string, string> = Object.create(null);
    files["SKILL.md"] = skillMd;
    for (const resource of resources) {
      files[canonicalRelPath(resource.path)] = resource.content;
    }
    if (sourceContent !== null) {
      files[SOURCE_FILE] = sourceContent;
    }
    const manifest = await signFiles(name, files);
    await fs.writeFile(
      path.join(tmpDir, MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
      { encoding: "utf-8", mode: 0o600 }
    );

    // Write source.json AFTER manifest (order is irrelevant for atomicity —
    // both land inside the staged tmp dir before the rename swap). Bytes
    // written here MUST equal `sourceContent` exactly so the signature in
    // the manifest validates the bytes on disk.
    if (sourceContent !== null) {
      await fs.writeFile(path.join(tmpDir, SOURCE_FILE), sourceContent, "utf-8");
    }

    // Atomic-ish swap: rename live → backup, rename tmp → live, rm backup.
    const backupDir = `${liveDir}.bak.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    let liveExisted = false;
    try {
      await fs.rename(liveDir, backupDir);
      liveExisted = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    try {
      await fs.rename(tmpDir, liveDir);
    } catch (error) {
      // Best-effort rollback so the prior install is still observable.
      if (liveExisted) {
        try {
          await fs.rename(backupDir, liveDir);
        } catch {
          // Rollback failed — the caller will see the original throw and the
          // log layer surfaces the failure path; nothing usable left to do.
        }
      }
      throw error;
    }

    if (liveExisted) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  });
}


function isAbsoluteLikePath(input: string): boolean {
  return path.isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.startsWith("\\\\");
}

function hasTraversalSegment(input: string): boolean {
  return input.split(/[\\/]+/).some((segment) => segment === "..");
}

function realpathIfExists(inputPath: string): string | null {
  try {
    return fsSync.realpathSync.native(inputPath);
  } catch {
    return null;
  }
}

function isWithinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

// Walk from `target` up to `root`, returning the deepest existing parent. We
// can't realpath the leaf when it doesn't exist yet (the typical case during a
// fresh resource write), but we MUST realpath whatever ancestor *does* exist —
// otherwise a parent symlink (planted by a previous attacker write or by the
// user out-of-band) silently relocates fs.writeFile outside the skill root.
function findExistingAncestor(target: string, root: string): string {
  let current = path.dirname(target);
  while (current.length >= root.length) {
    if (realpathIfExists(current) !== null) return current;
    const parent = path.dirname(current);
    if (parent === current) return root;
    current = parent;
  }
  return root;
}

// Round-60 fix: writeSkill staging needs a path validator that probes the
// fresh tmpDir (which the caller just mkdir'd) rather than the live skill
// directory. The live-root variant (validateResourcePath below) is correct
// for in-place writes and reads, but using it during atomic staging means a
// corrupted live install — say, `skills/foo/bin -> /tmp` planted by an
// attacker or a partial-write crash — rejects the very reinstall that would
// replace the hostile state. The user is then forced to manually `rm -rf`
// before the normal reinstall path will accept the bytes. Keep the
// path-shape invariants identical so traversal/reserved-name/forbidden
// segment checks still trip; only swap which directory we ancestor-walk.
export function validateStagedResourcePath(
  stagingRoot: string,
  resourcePath: string
): string {
  if (typeof resourcePath !== "string" || resourcePath.length === 0) {
    throw new Error(`Invalid resource path: ${resourcePath}`);
  }
  if (isAbsoluteLikePath(resourcePath) || hasTraversalSegment(resourcePath)) {
    throw new Error(`Invalid resource path: ${resourcePath}`);
  }
  const canonical = canonicalRelPath(resourcePath);
  if (canonical.length === 0 || isReservedResourcePath(canonical)) {
    throw new Error(`Reserved resource path: ${resourcePath}`);
  }
  if (hasForbiddenPathSegment(canonical)) {
    throw new Error(`Reserved resource path: ${resourcePath}`);
  }
  const root = path.resolve(stagingRoot);
  const target = path.resolve(root, canonical);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Resource escapes skill directory: ${resourcePath}`);
  }
  const realRoot = realpathIfExists(root) ?? root;
  const realTarget = realpathIfExists(target);
  if (realTarget && !isWithinRoot(realTarget, realRoot)) {
    throw new Error(`Resource escapes skill directory: ${resourcePath}`);
  }
  // Walk up from the not-yet-created target inside stagingRoot. The caller
  // freshly mkdir'd stagingRoot, so a hostile ancestor here would only
  // materialize via a same-process race — defense-in-depth, not the common
  // case. The live-skill ancestor walk that this replaces was the source of
  // the recovery wedge.
  const ancestor = findExistingAncestor(target, root);
  const realAncestor = realpathIfExists(ancestor);
  if (realAncestor !== null && !isWithinRoot(realAncestor, realRoot)) {
    throw new Error(`Resource escapes skill directory (parent symlink): ${resourcePath}`);
  }
  return realTarget ?? target;
}

// Round-62: path-shape-only check. install_skill / propose_skill use this
// to preflight incoming resources WITHOUT walking the live skill tree —
// otherwise a corrupted live install (e.g. `bin -> /tmp` from a partial
// write or attacker injection) wedges the very reinstall whose staged swap
// would replace the hostile state. writeSkill's staging validator
// (validateStagedResourcePath) still probes the freshly-mkdir'd tmp dir for
// staging-side TOCTOU; this is just the public-input boundary check.
export function validateResourcePathShape(resourcePath: string): string {
  if (typeof resourcePath !== "string" || resourcePath.length === 0) {
    throw new Error(`Invalid resource path: ${resourcePath}`);
  }
  if (isAbsoluteLikePath(resourcePath) || hasTraversalSegment(resourcePath)) {
    throw new Error(`Invalid resource path: ${resourcePath}`);
  }
  const canonical = canonicalRelPath(resourcePath);
  if (canonical.length === 0 || isReservedResourcePath(canonical)) {
    throw new Error(`Reserved resource path: ${resourcePath}`);
  }
  // Hard-reject __proto__/constructor/prototype anywhere in the path. These
  // collide with Object.prototype machinery — writing manifest[filePath]=sig
  // for `__proto__` mutates the prototype rather than recording an own key,
  // so the file would be bundle-hashed but missing from the signed manifest.
  // Defense-in-depth: signFiles/parseManifest also use Object.create(null) +
  // Object.hasOwn, but rejecting at the boundary keeps the invariant simple.
  if (hasForbiddenPathSegment(canonical)) {
    throw new Error(`Reserved resource path: ${resourcePath}`);
  }
  return canonical;
}

export function validateResourcePath(name: string, resourcePath: string): string {
  // Shape checks (boundary invariants) — same checks every variant runs.
  const canonical = validateResourcePathShape(resourcePath);
  const root = path.resolve(skillDir(name));
  // Resolve against the *canonical* relative path. Using the raw `resourcePath`
  // here forks the read and write views: writeSkill stages every file under
  // `canonicalRelPath(resource.path)`, so a declaration like `examples\guide.md`
  // lands at `examples/guide.md` on disk; if the validator returned a literal
  // backslash filename, read_skill_resource would resolve to a path that does
  // not exist. Canonicalizing here keeps validation/write/read keyed to one
  // filesystem target.
  const target = path.resolve(root, canonical);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Resource escapes skill directory: ${resourcePath}`);
  }

  const realRoot = realpathIfExists(root) ?? root;
  const realTarget = realpathIfExists(target);
  if (realTarget && !isWithinRoot(realTarget, realRoot)) {
    throw new Error(`Resource escapes skill directory: ${resourcePath}`);
  }

  // Defense against parent-symlink TOCTOU: if any ancestor already exists and
  // is a symlink (or sits behind one) pointing outside the skill root, the
  // subsequent fs.writeFile would follow it. Reject before any write touches
  // the filesystem.
  const ancestor = findExistingAncestor(target, root);
  const realAncestor = realpathIfExists(ancestor);
  if (realAncestor !== null && !isWithinRoot(realAncestor, realRoot)) {
    throw new Error(`Resource escapes skill directory (parent symlink): ${resourcePath}`);
  }

  return realTarget ?? target;
}

export async function writeSkillResources(
  name: string,
  resources: Array<{ path: string; content: string; mode?: number }>,
  binPathsHint?: Set<string>
): Promise<void> {
  if (resources.length === 0) return;
  const binPaths = binPathsHint ?? (await loadBinPaths(name));
  const targets = resources.map((resource) => ({
    target: validateResourcePath(name, resource.path),
    content: resource.content,
    mode: resource.mode ?? (binPaths.has(canonicalRelPath(resource.path)) ? 0o755 : 0o644)
  }));
  for (const { target, content, mode } of targets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { encoding: "utf-8", mode });
    // fs.writeFile honors mode only when creating a new file; chmod ensures
    // we update permissions on overwrites of existing files too.
    await fs.chmod(target, mode);
  }
}

async function loadBinPaths(name: string): Promise<Set<string>> {
  try {
    const skillMd = await fs.readFile(path.join(skillDir(name), "SKILL.md"), "utf-8");
    const { data } = parseFrontmatter(skillMd);
    return declaredBinPaths(asBinBlock(data.bin));
  } catch {
    return new Set();
  }
}

export type SkillSourceStatus =
  | { kind: "present"; source: SkillSource }
  | { kind: "legacy"; source: SkillSource }
  | { kind: "tampered"; reason: "signature_invalid" | "manifest_corrupt" | "manifest_missing_entry" }
  | { kind: "unparseable" }
  | { kind: "absent" };

// Round-56: detect pre-v1 installs (detached .autovault-signature + unsigned
// source.json + no manifest) so callers can distinguish "needs migration" from
// "tampered". Caller already holds the storage lock; this helper does only
// reads. Returns "legacy" only if the detached signature exists AND verifies
// SKILL.md — a missing or invalid signature alongside a missing manifest is
// indistinguishable from tampering, so we refuse to grant legacy status there.
async function readLegacyInstallStatus(
  name: string
): Promise<{ kind: "legacy" } | { kind: "not_legacy" }> {
  const dir = skillDir(name);
  let signature: string;
  try {
    signature = (await fs.readFile(path.join(dir, SIGNATURE_FILE), "utf-8")).trim();
  } catch {
    return { kind: "not_legacy" };
  }
  let skillMd: string;
  try {
    skillMd = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");
  } catch {
    return { kind: "not_legacy" };
  }
  const ok = await verifyContent(skillMd, signature);
  return ok ? { kind: "legacy" } : { kind: "not_legacy" };
}

// Round-54: source.json is now bound into the signed manifest by writeSkill.
// Verify here on every read so a tampered (or pre-round-54-unsigned) source
// record cannot falsify check_updates' drift verdict. Returning a status
// (vs. just null) lets callers like check_updates surface an actionable error
// — "Source metadata signature invalid; reinstall the skill" — instead of the
// generic "No source metadata recorded" message.
//
// Lock domain: take the storage lock for the manifest+source.json read pair.
// Without it, a concurrent writeSkill swap could expose us to the live → bak
// → tmp window where the skill directory is briefly absent (round-54 medium
// finding). The lock is also the right serialization point because manifest
// and source.json are written together inside writeSkill's tmp dir; reading
// them under the same lock guarantees we don't catch a half-swapped pair.
export async function readSkillSourceStatus(name: string): Promise<SkillSourceStatus> {
  return withStorageLock(async () => {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(skillDir(name), SOURCE_FILE), "utf-8");
    } catch {
      return { kind: "absent" };
    }

    let parsed: SkillSource;
    try {
      parsed = JSON.parse(raw) as SkillSource;
    } catch {
      return { kind: "unparseable" };
    }

    const manifestRaw = await readManifestRaw(name);
    if (manifestRaw === null) {
      // Round-56: distinguish legacy pre-manifest installs from tampering.
      // Pre-v1 writeSkill produced a detached `.autovault-signature` over
      // SKILL.md and an unsigned `.autovault-source.json`, with no
      // `.autovault-manifest`. Treating that case as tampered would
      // version-skew-break every existing install on upgrade — users would
      // see "Source metadata signature invalid" on legitimate skills they
      // installed before this upgrade. Detect the legacy shape by checking
      // the detached signature against SKILL.md; if it verifies, this is a
      // legacy install whose source metadata is trustworthy at install time
      // (main wrote both atomically) but is NOT bound by the manifest, so
      // post-install source.json tampering is undetectable. Caller
      // (check_updates) should mark these `unchecked` with a reinstall
      // hint rather than running drift checks against unverified metadata.
      const legacy = await readLegacyInstallStatus(name);
      if (legacy.kind === "legacy") {
        return { kind: "legacy", source: parsed };
      }
      log.warn("storage.signature_mismatch", {
        name,
        file: SOURCE_FILE,
        reason: "no_manifest"
      });
      return { kind: "tampered", reason: "manifest_missing_entry" };
    }
    const manifest = parseManifest(manifestRaw);
    if (!manifest) {
      log.warn("storage.signature_mismatch", {
        name,
        file: SOURCE_FILE,
        reason: "manifest_corrupt"
      });
      return { kind: "tampered", reason: "manifest_corrupt" };
    }
    const result = await verifyFile(manifest, name, SOURCE_FILE, raw);
    if (!result.present) {
      // Manifest exists but does not cover SOURCE_FILE. This is either a
      // pre-round-54 install (writeSkill wrote source.json outside the
      // signed bundle) OR an attacker swapped a fresh source.json in but
      // could not produce a valid signature. We cannot distinguish; refuse
      // to trust the metadata in either case. v1 accepts the cost: legacy
      // installs must reinstall to regain check_updates support.
      log.warn("storage.signature_missing", {
        name,
        file: SOURCE_FILE,
        reason: "manifest_missing_source"
      });
      return { kind: "tampered", reason: "manifest_missing_entry" };
    }
    if (!result.valid) {
      log.warn("storage.signature_mismatch", { name, file: SOURCE_FILE });
      return { kind: "tampered", reason: "signature_invalid" };
    }
    return { kind: "present", source: parsed };
  });
}

export async function readSkillSource(name: string): Promise<SkillSource | null> {
  const status = await readSkillSourceStatus(name);
  return status.kind === "present" ? status.source : null;
}
