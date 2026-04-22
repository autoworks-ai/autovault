import {
  listInstalledSkillNames,
  readSkill,
  validateResourcePath,
  writeSkill,
  writeSkillResources,
  writeSkillSource
} from "../storage/index.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { classifyDedup, type DedupCandidate } from "../validation/dedup.js";
import { validateSkillInput } from "../validation/index.js";
import { sha256 } from "../util/hash.js";
import { log } from "../util/log.js";

export type ProposeSkillInput = {
  skill_md: string;
  resources?: Array<{ path: string; content: string }>;
  source_session?: string;
};

export async function proposeSkill(input: ProposeSkillInput): Promise<Record<string, unknown>> {
  const { output: normalizedSkillMd } = attemptRepair(input.skill_md);
  const validation = validateSkillInput(input.skill_md);
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
  const candidateHash = sha256(normalizedSkillMd);

  const existing: DedupCandidate[] = [];
  for (const existingName of await listInstalledSkillNames()) {
    const record = await readSkill(existingName);
    if (!record) continue;
    existing.push({
      name: record.name,
      contentHash: sha256(record.skillMd),
      content: record.skillMd
    });
  }

  const dedup = classifyDedup(candidateHash, normalizedSkillMd, existing);

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

  await writeSkill(nextName, normalizedSkillMd);
  if (input.resources && input.resources.length > 0) {
    await writeSkillResources(nextName, input.resources);
  }

  await writeSkillSource(nextName, {
    source: "inline",
    identifier: input.source_session ?? "proposed",
    fetchedAt: new Date().toISOString(),
    contentHash: candidateHash
  });

  const warnings = [...validation.warnings];
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
