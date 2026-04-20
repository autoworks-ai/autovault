import {
  listInstalledSkillNames,
  readSkill,
  validateResourcePath,
  writeSkill,
  writeSkillResources,
  writeSkillSource
} from "../storage/index.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { scoreSimilarity } from "../validation/dedup.js";
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

  const installed = await listInstalledSkillNames();
  for (const existingName of installed) {
    const existing = await readSkill(existingName);
    if (!existing) continue;

    const similarity = scoreSimilarity(existing.skillMd, normalizedSkillMd);
    if (similarity > 0.9) {
      log.info("propose_skill.duplicate", { existing: existing.name, similarity });
      return {
        outcome: "duplicate",
        existing_match: {
          name: existing.name,
          similarity,
          merge_options: ["keep_existing", "replace", "merge", "keep_both"]
        }
      };
    }
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
    contentHash: sha256(normalizedSkillMd)
  });

  log.info("propose_skill.accepted", { name: nextName });
  return { outcome: "accepted", name: nextName, warnings: validation.warnings };
}
