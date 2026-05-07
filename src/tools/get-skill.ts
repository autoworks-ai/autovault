import { readSkill, readSkillSource } from "../storage/index.js";
import { renderSkillForAgent } from "../transforms/index.js";
import type { SkillRecord } from "../types.js";
import { canonicalRelPath } from "../util/path.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { parseFrontmatter } from "../validation/frontmatter.js";
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
      source,
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
    source,
    ...(resourceContents ? { resource_contents: resourceContents } : {})
  };
}

function resourcePathsForSkill(skill: SkillRecord): string[] {
  const paths = new Set<string>();
  const addPath = (candidate: string): void => {
    const canonical = canonicalRelPath(candidate);
    if (canonical.length > 0) paths.add(canonical);
  };
  for (const resource of skill.resources) addPath(resource.path);
  for (const action of Object.values(skill.bin)) {
    if (action.command.length > 0) addPath(action.command);
  }
  return [...paths].sort();
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
