import matter from "gray-matter";
import { canonicalRelPath } from "../util/path.js";
import { parseFrontmatter } from "./frontmatter.js";

export type SynthesizedResource = {
  path: string;
  type: "file";
};

export type FrontmatterSynthesisResult = {
  skillMd: string;
  inferredResources: SynthesizedResource[];
  inferredAgents: string[];
};

export function synthesizeSkillFrontmatter(
  skillMd: string,
  input: {
    resources?: Array<{ path: string }>;
    agents?: string[];
    allowSynthesizedFrontmatter?: boolean;
  } = {}
): FrontmatterSynthesisResult {
  const { data, content } = parseFrontmatter(skillMd);
  const frontmatter = { ...data };
  const inferredResources: SynthesizedResource[] = [];
  const inferredAgents: string[] = [];
  const allow = input.allowSynthesizedFrontmatter ?? true;

  if (
    allow &&
    (input.resources?.length ?? 0) > 0 &&
    !Object.prototype.hasOwnProperty.call(frontmatter, "resources")
  ) {
    for (const resource of input.resources ?? []) {
      inferredResources.push({
        path: canonicalRelPath(resource.path) || resource.path,
        type: "file"
      });
    }
    frontmatter.resources = inferredResources;
  }

  if (
    allow &&
    (input.agents?.length ?? 0) > 0 &&
    !Object.prototype.hasOwnProperty.call(frontmatter, "agents")
  ) {
    inferredAgents.push(...input.agents!);
    frontmatter.agents = inferredAgents;
  }

  if (inferredResources.length === 0 && inferredAgents.length === 0) {
    return { skillMd, inferredResources, inferredAgents };
  }

  return {
    skillMd: stringifySkill(content, frontmatter),
    inferredResources,
    inferredAgents
  };
}

function stringifySkill(content: string, frontmatter: Record<string, unknown>): string {
  return matter.stringify(`${content.trimEnd()}\n`, frontmatter).replace(/\n+$/, "\n");
}
