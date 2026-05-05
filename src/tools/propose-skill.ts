import fs from "node:fs/promises";
import path from "node:path";
import {
  listInstalledSkillNames,
  readSkill,
  skillDir,
  validateResourcePath,
  writeSkill
} from "../storage/index.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import {
  buildSimilarityCorpus,
  classifyDedup,
  type DedupCandidate
} from "../validation/dedup.js";
import { validateSkillInput } from "../validation/index.js";
import { bundleHash, type HashedResource } from "../util/hash.js";
import {
  MAX_RESOURCES,
  MAX_RESOURCE_BYTES,
  MAX_TOTAL_BYTES,
  checkBundleLimits
} from "../util/limits.js";
import { log } from "../util/log.js";
import { syncProfiles } from "../profiles/sync.js";

// Walk an installed skill's directory and collect every non-metadata file as a
// HashedResource so we can recompute its bundle hash from current disk state.
// Dedup intentionally does NOT use the recorded source.contentHash: that hash
// is frozen at install time, but readSkill is log-only on signature mismatch
// (V1) — so a tampered or partially-corrupted install still ships its original
// hash. Trusting that hash for dedup means a user proposing the clean original
// bundle (to repair tampered bytes) gets blocked as an "exact duplicate" of
// itself, with no way to recover via propose_skill. Always recompute from disk
// so dedup reflects what is actually on the user's machine right now.
//
// Bound the walk by the same MAX_RESOURCES / MAX_RESOURCE_BYTES / MAX_TOTAL_BYTES
// caps we apply to candidate bundles. A stale pre-limit install, a manually-
// dropped file, or a tampered skill directory could otherwise force every
// propose_skill call to fs.readFile multi-megabyte content into memory before
// dedup runs — the candidate gate doesn't help here because it only validates
// the proposal, not the existing corpus. fs.stat lets us refuse oversized
// files BEFORE the read, so a 100 MiB file in one polluted skill costs one
// stat() per call instead of one allocation per call.
async function readInstalledResources(name: string): Promise<HashedResource[]> {
  const root = skillDir(name);
  const resources: HashedResource[] = [];
  let totalBytes = 0;
  let truncated = false;

  // Round-43 fix: the corpus walk used to follow symlinks via fs.stat /
  // fs.readFile. A polluted installed skill directory containing a symlink
  // to a file outside the vault (e.g., dropped by a hostile process between
  // install_skill calls) would cause every propose_skill invocation to read
  // that target into the dedup/similarity corpus. The bytes are not
  // returned to the caller, but they cross the storage-root boundary —
  // which contradicts every other path-safety invariant in storage — and
  // they leak into duplicate/similarity decisions. Skip symlinks via
  // entry.isSymbolicLink(), and as defense-in-depth confirm fs.realpath
  // resolves under the skill root before we open the file.
  const realRoot = await fs.realpath(root).catch(() => root);
  async function walk(current: string, relative: string): Promise<void> {
    if (truncated) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        log.warn("propose_skill.dedup_skipped_symlink", { name, path: rel });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) {
        // Sockets, fifos, char/block devices: not real skill content.
        continue;
      }
      if (entry.name === "SKILL.md" || entry.name.startsWith(".autovault-")) {
        continue;
      }
      if (resources.length >= MAX_RESOURCES) {
        truncated = true;
        log.warn("propose_skill.dedup_corpus_truncated_count", {
          name,
          collected: resources.length,
          max: MAX_RESOURCES
        });
        return;
      }
      let size: number;
      try {
        // lstat (not stat) so a TOCTOU swap between readdir and stat — entry
        // was a regular file when the directory was scanned but turned into
        // a symlink before we read it — gets caught here too.
        const st = await fs.lstat(abs);
        if (st.isSymbolicLink()) {
          log.warn("propose_skill.dedup_skipped_symlink", { name, path: rel });
          continue;
        }
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      // Defense-in-depth: even after the lstat reject, confirm the real path
      // lives under the skill root. If a parent directory is a symlink (or
      // sits behind one) the dirent walk can land in a directory outside the
      // root without the leaf being a symlink. Skip anything that resolves
      // outside.
      let realAbs: string;
      try {
        realAbs = await fs.realpath(abs);
      } catch {
        continue;
      }
      if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
        log.warn("propose_skill.dedup_skipped_outside_root", {
          name,
          path: rel,
          realAbs
        });
        continue;
      }
      if (size > MAX_RESOURCE_BYTES) {
        log.warn("propose_skill.dedup_resource_skipped_oversize", {
          name,
          path: rel,
          size,
          max: MAX_RESOURCE_BYTES
        });
        continue;
      }
      if (totalBytes + size > MAX_TOTAL_BYTES) {
        truncated = true;
        log.warn("propose_skill.dedup_corpus_truncated_total", {
          name,
          totalBytes,
          nextSize: size,
          max: MAX_TOTAL_BYTES
        });
        return;
      }
      const content = await fs.readFile(abs, "utf-8");
      resources.push({ path: rel, content });
      totalBytes += size;
    }
  }
  try {
    await walk(root, "");
  } catch {
    // Skill dir missing or unreadable — caller treats this as "no resources".
  }
  return resources;
}

export type ProposeSkillInput = {
  skill_md: string;
  resources?: Array<{ path: string; content: string }>;
  source_session?: string;
};

export async function proposeSkill(input: ProposeSkillInput): Promise<Record<string, unknown>> {
  // Enforce raw byte caps BEFORE attemptRepair. attemptRepair runs full-string
  // regex passes — feeding it a 100 MiB SKILL.md burns CPU before
  // validateSkillInput's internal limit check fires. Match installSkill's
  // entry-point gate so the DoS guard works on every inline write surface.
  const limitErrors = checkBundleLimits(input.skill_md, input.resources ?? []);
  if (limitErrors.length > 0) {
    log.info("propose_skill.invalid_size", { errors: limitErrors });
    return { outcome: "invalid", errors: limitErrors };
  }

  const { output: normalizedSkillMd } = attemptRepair(input.skill_md);
  const validation = validateSkillInput(input.skill_md, input.resources ?? []);
  if (validation.securityFlags.length > 0 && !validation.valid) {
    log.info("propose_skill.security_blocked", { flags: validation.securityFlags });
    return { outcome: "security_blocked", security_flags: validation.securityFlags };
  }

  if (!validation.valid) {
    log.info("propose_skill.invalid", { errors: validation.errors });
    return { outcome: "invalid", errors: validation.errors };
  }

  const { data } = parseFrontmatter(normalizedSkillMd);
  const nextName = typeof data.name === "string" ? data.name : "proposed-skill";
  // Candidate identity covers SKILL.md AND every proposed resource. Without
  // resources in the hash, two proposals with identical SKILL.md but different
  // bin/setup would collide as duplicates and the bytes that actually run on
  // the user's machine wouldn't be part of the dedup signal.
  const candidateHash = bundleHash(normalizedSkillMd, input.resources ?? []);
  const candidateCorpus = buildSimilarityCorpus(normalizedSkillMd, input.resources ?? []);

  const existing: DedupCandidate[] = [];
  for (const existingName of await listInstalledSkillNames()) {
    const record = await readSkill(existingName);
    if (!record) continue;
    // Always hash live disk bytes — see readInstalledResources for why
    // source.contentHash is unsafe for dedup.
    const existingResources = await readInstalledResources(existingName);
    const existingHash = bundleHash(record.skillMd, existingResources);
    existing.push({
      name: record.name,
      contentHash: existingHash,
      similarityCorpus: buildSimilarityCorpus(record.skillMd, existingResources)
    });
  }

  const dedup = classifyDedup(candidateHash, candidateCorpus, existing);

  if (dedup.tier === "exact") {
    log.info("propose_skill.duplicate_exact", { existing: dedup.existingName });
    return {
      outcome: "duplicate",
      existing_match: {
        name: dedup.existingName,
        similarity: 1,
        match_type: "exact",
        merge_options: ["keep_existing"]
      }
    };
  }

  if (dedup.tier === "near_exact") {
    log.info("propose_skill.duplicate_near", {
      existing: dedup.existingName,
      similarity: dedup.similarity
    });
    return {
      outcome: "duplicate",
      existing_match: {
        name: dedup.existingName,
        similarity: dedup.similarity,
        match_type: "near_exact",
        merge_options: ["keep_existing", "replace", "merge", "keep_both"]
      }
    };
  }

  if (input.resources && input.resources.length > 0) {
    for (const resource of input.resources) {
      try {
        validateResourcePath(nextName, resource.path);
      } catch (error) {
        log.warn("propose_skill.resource_rejected", { name: nextName, error: String(error) });
        return {
          outcome: "invalid",
          errors: [`Resource path rejected: ${String(error)}`]
        };
      }
    }
  }

  // Pass source through writeSkill so SKILL.md/resources/manifest/source land
  // atomically in the same staged-tmp swap. A separate post-swap write would
  // create a window where SKILL.md is paired with no source record (or worse,
  // the previous skill's source record carried forward) — corrupting the
  // contentHash drift signal check_updates relies on.
  await writeSkill(nextName, normalizedSkillMd, input.resources ?? [], {
    source: "inline",
    identifier: input.source_session ?? "proposed",
    fetchedAt: new Date().toISOString(),
    contentHash: candidateHash
  });

  // Profile sync is post-commit convenience — the vault is the source of truth
  // and is already on disk by the time we get here. Mirrors install_skill: a
  // failure inside syncProfiles (external profile root with a non-symlink
  // collision, permission denial on `~/.claude/skills/`, etc.) must NOT
  // escalate to a hard propose failure, because the SKILL.md/resources/
  // manifest/source records are committed and the caller would re-propose into
  // a dedup-rejected state instead of fixing the profile-root conflict. Surface
  // as a warning, log the detail, and return accepted.
  const postCommitWarnings: string[] = [];
  try {
    const syncResult = await syncProfiles();
    for (const w of syncResult.warnings) postCommitWarnings.push(w);
  } catch (error) {
    const message = `Profile sync failed after propose (vault state is correct): ${String(error)}`;
    log.warn("propose_skill.profile_sync_failed", { name: nextName, error: String(error) });
    postCommitWarnings.push(message);
  }

  const warnings = [...validation.warnings, ...postCommitWarnings];
  if (dedup.tier === "functional" && dedup.existingName) {
    warnings.push(
      `Functionally similar to existing skill "${dedup.existingName}" (similarity ${dedup.similarity.toFixed(2)}). Consider reviewing for overlap.`
    );
  }

  log.info("propose_skill.accepted", { name: nextName, tier: dedup.tier });
  return {
    outcome: "accepted",
    name: nextName,
    warnings,
    dedup: {
      tier: dedup.tier,
      similarity: dedup.similarity,
      similar_to: dedup.existingName ?? null
    }
  };
}
