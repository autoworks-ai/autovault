import { readSkill, readSkillSource } from "../storage/index.js";
import { renderSkillForAgent } from "../transforms/index.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { parseFrontmatter } from "../validation/frontmatter.js";

export async function getSkill(name: string, agent?: string): Promise<Record<string, unknown>> {
  assertSafeSkillName(name);
  const skill = await readSkill(name);
  if (!skill) {
    throw new Error(`Skill not found: ${name}`);
  }
  const source = await readSkillSource(name);
  if (agent) {
    const rendered = await renderSkillForAgent(name, agent);
    return {
      name: skill.name,
      description: skill.description,
      version: skill.version,
      tags: skill.tags,
      category: skill.category,
      skill_md: rendered.skill_md,
      resources: rendered.resources.map((resource) => ({ path: resource.path, type: "file" })),
      requires_secrets: skill.requiresSecrets,
      capabilities: parseRenderedCapabilities(rendered.skill_md),
      source,
      agent,
      applied_transforms: rendered.applied_transforms,
      warnings: rendered.warnings
    };
  }
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

function parseRenderedCapabilities(skillMd: string): {
  network: boolean;
  filesystem: "readonly" | "readwrite";
  tools: string[];
} {
  const fallback = { network: false, filesystem: "readonly" as const, tools: [] };
  try {
    const { data } = parseFrontmatter(skillMd);
    const caps = data.capabilities;
    if (typeof caps === "object" && caps !== null && !Array.isArray(caps)) {
      const record = caps as Record<string, unknown>;
      return {
        network: typeof record.network === "boolean" ? record.network : fallback.network,
        filesystem: record.filesystem === "readwrite" ? "readwrite" : "readonly",
        tools: Array.isArray(record.tools)
          ? record.tools.filter((tool): tool is string => typeof tool === "string")
          : []
      };
    }
  } catch {
    return fallback;
  }
  return fallback;
}
