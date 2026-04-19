import {
  listInstalledSkillNames,
  readSkill,
  writeSkill,
  writeSkillResources,
  writeSkillSource
} from "../storage/index.js";
import { parseFrontmatter } from "../validation/frontmatter.js";
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
  const validation = validateSkillInput(input.skill_md);
  if (validation.securityFlags.length > 0 && !validation.valid) {
    log.info("propose_skill.security_blocked", { flags: validation.securityFlags });
    return { outcome: "security_blocked", security_flags: validation.securityFlags };
  }

  if (!validation.valid) {
    log.info("propose_skill.invalid", { errors: validation.errors });
    return { outcome: "invalid", errors: validation.errors };
  }

  const { data } = parseFrontmatter(input.skill_md);
  const nextName = typeof data.name === "string" ? data.name : "proposed-skill";

  const installed = await listInstalledSkillNames();
  for (const existingName of installed) {
    const existing = await readSkill(existingName);
    if (!existing) continue;

    const similarity = scoreSimilarity(existing.skillMd, input.skill_md);
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

  await writeSkill(nextName, input.skill_md);
  if (input.resources && input.resources.length > 0) {
    try {
      await writeSkillResources(nextName, input.resources);
    } catch (error) {
      log.warn("propose_skill.resource_rejected", { name: nextName, error: String(error) });
      return {
        outcome: "invalid",
        errors: [`Resource write rejected: ${String(error)}`]
      };
    }
  }

  await writeSkillSource(nextName, {
    source: "inline",
    identifier: input.source_session ?? "proposed",
    fetchedAt: new Date().toISOString(),
    contentHash: sha256(input.skill_md)
  });

  log.info("propose_skill.accepted", { name: nextName });
  return { outcome: "accepted", name: nextName, warnings: validation.warnings };
}
