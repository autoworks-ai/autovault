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
    replaceEmptyAgents?: boolean;
    name?: string;
    description?: string;
    metadataVersion?: string;
    appendMissingResources?: boolean;
    allowSynthesizedFrontmatter?: boolean;
  } = {}
): FrontmatterSynthesisResult {
  const { data, content } = parseFrontmatter(skillMd);
  const frontmatter = { ...data };
  const inferredResources: SynthesizedResource[] = [];
  const inferredAgents: string[] = [];
  const allow = input.allowSynthesizedFrontmatter ?? true;

  if (allow && (input.resources?.length ?? 0) > 0) {
    const hasResourcesField = Object.prototype.hasOwnProperty.call(frontmatter, "resources");
    if (!hasResourcesField) {
      const declared = input.appendMissingResources ? declaredResourcePaths(frontmatter) : new Set<string>();
      for (const resource of input.resources ?? []) {
        const resourcePath = canonicalRelPath(resource.path) || resource.path;
        if (declared.has(resourcePath)) continue;
        const synthesized = {
          path: resourcePath,
          type: "file" as const
        };
        inferredResources.push(synthesized);
        declared.add(resourcePath);
      }
      if (inferredResources.length > 0) {
        frontmatter.resources = inferredResources;
      }
    } else if (input.appendMissingResources) {
      const declared = declaredResourcePaths(frontmatter);
      const existingResources = Array.isArray(frontmatter.resources)
        ? [...(frontmatter.resources as unknown[])]
        : [];
      for (const resource of input.resources ?? []) {
        const resourcePath = canonicalRelPath(resource.path) || resource.path;
        if (declared.has(resourcePath)) continue;
        const synthesized = {
          path: resourcePath,
          type: "file" as const
        };
        existingResources.push(synthesized);
        inferredResources.push(synthesized);
        declared.add(resourcePath);
      }
      if (inferredResources.length > 0) {
        frontmatter.resources = existingResources;
      }
    }
  }

  if (
    allow &&
    (input.agents?.length ?? 0) > 0 &&
    (!Object.prototype.hasOwnProperty.call(frontmatter, "agents") ||
      (input.replaceEmptyAgents === true &&
        (!Array.isArray(frontmatter.agents) ||
          frontmatter.agents.length === 0 ||
          frontmatter.agents.some((agent) => typeof agent !== "string" || agent.trim().length === 0))))
  ) {
    inferredAgents.push(...input.agents!);
    frontmatter.agents = inferredAgents;
  }

  if (allow && input.name !== undefined) {
    frontmatter.name = input.name;
  }

  if (allow && input.description !== undefined) {
    frontmatter.description = input.description;
  }

  if (allow && input.metadataVersion !== undefined) {
    const metadata =
      typeof frontmatter.metadata === "object" && frontmatter.metadata !== null && !Array.isArray(frontmatter.metadata)
        ? { ...(frontmatter.metadata as Record<string, unknown>) }
        : {};
    if (typeof metadata.version !== "string" || metadata.version.trim().length === 0) {
      metadata.version = input.metadataVersion;
      frontmatter.metadata = metadata;
    }
  }

  if (inferredResources.length === 0 && inferredAgents.length === 0) {
    const unchanged =
      input.name === undefined &&
      input.description === undefined &&
      input.metadataVersion === undefined;
    if (unchanged) return { skillMd, inferredResources, inferredAgents };
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

function declaredResourcePaths(frontmatter: Record<string, unknown>): Set<string> {
  const declared = new Set<string>();
  if (Array.isArray(frontmatter.resources)) {
    for (const raw of frontmatter.resources as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const resourcePath = (raw as Record<string, unknown>).path;
      if (typeof resourcePath === "string" && resourcePath.length > 0) {
        declared.add(canonicalRelPath(resourcePath) || resourcePath);
      }
    }
  }
  if (typeof frontmatter.bin === "object" && frontmatter.bin !== null) {
    for (const raw of Object.values(frontmatter.bin as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const command = (raw as Record<string, unknown>).command;
      if (typeof command === "string" && command.length > 0) {
        declared.add(canonicalRelPath(command) || command);
      }
    }
  }
  return declared;
}
