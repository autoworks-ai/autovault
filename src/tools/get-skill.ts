import { readSkill, readSkillSource } from "../storage/index.js";
import { renderSkillForAgent } from "../transforms/index.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { resourcePathsForSkill } from "../util/skill-resource-paths.js";
import { extractAuthor, extractSource, parseFrontmatter } from "../validation/frontmatter.js";
import { readSkillResources } from "./read-skill-resource.js";

export type GetSkillOptions = {
  includeResources?: boolean;
};

export async function getSkill(
  name: string,
  agent?: string,
  options: GetSkillOptions = {}
): Promise<Record<string, unknown>> {
  assertSafeSkillName(name);
  const skill = await readSkill(name);
  if (!skill) {
    throw new Error(`Skill not found: ${name}`);
  }
  const source = await readSkillSource(name);
  const resourceContents = options.includeResources
    ? await readResourceContents(name, resourcePathsForSkill(skill))
    : undefined;
  if (agent) {
    const rendered = await renderSkillForAgent(name, agent);
    return {
      name: skill.name,
      description: skill.description,
      version: skill.version,
      tags: skill.tags,
      category: skill.category,
      skill_md: rendered.skill_md,
      resources: skill.resources,
      bin: skill.bin,
      requires_secrets: skill.requiresSecrets,
      capabilities: parseRenderedCapabilities(rendered.skill_md),
      author: skill.author ?? extractAuthor(rendered.skill_md),
      source, // AutoVault provenance object (distinct from frontmatter metadata.source)
      frontmatter_source: skill.source ?? extractSource(rendered.skill_md),
      agent,
      applied_transforms: rendered.applied_transforms,
      warnings: rendered.warnings,
      ...(resourceContents ? { resource_contents: resourceContents } : {})
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
    bin: skill.bin,
    requires_secrets: skill.requiresSecrets,
    capabilities: skill.capabilities,
    author: skill.author,
    source, // AutoVault provenance object
    frontmatter_source: skill.source,
    ...(resourceContents ? { resource_contents: resourceContents } : {})
  };
}

async function readResourceContents(
  skillName: string,
  paths: string[]
): Promise<Array<{ path: string; content: string; mime_type: string }>> {
  return readSkillResources(skillName, paths);
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
