import { readSkill, readSkillSource } from "../storage/index.js";
import { assertSafeSkillName } from "../util/skill-name.js";

export async function getSkill(name: string): Promise<Record<string, unknown>> {
  assertSafeSkillName(name);
  const skill = await readSkill(name);
  if (!skill) {
    throw new Error(`Skill not found: ${name}`);
  }
  const source = await readSkillSource(name);
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    tags: skill.tags,
    category: skill.category,
    skill_md: skill.skillMd,
    resources: skill.resources,
    requires_secrets: skill.requiresSecrets,
    capabilities: skill.capabilities,
    source
  };
}
