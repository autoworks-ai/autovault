import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { validateSkillInput } from "../validation/index.js";
import {
  type SkillSource,
  writeSkill,
  writeSkillSource
} from "../storage/index.js";
import { fetchSkillFromAgentSkills } from "../sources/agentskills.js";
import { fetchSkillFromGitHub } from "../sources/github.js";
import { fetchSkillFromUrl } from "../sources/url.js";
import type { FetchedSkill } from "../sources/types.js";
import { sha256 } from "../util/hash.js";
import { log } from "../util/log.js";
import { syncProfiles } from "../profiles/sync.js";

export type InstallSkillInput = {
  source: "github" | "agentskills" | "url";
  identifier: string;
  version?: string;
  skill_md?: string;
  bundled_skill_name?: string;
};

type InstallDeps = {
  fetchers?: {
    github?: typeof fetchSkillFromGitHub;
    agentskills?: typeof fetchSkillFromAgentSkills;
    url?: typeof fetchSkillFromUrl;
  };
};

async function fetchByInput(
  input: InstallSkillInput,
  deps: InstallDeps
): Promise<FetchedSkill> {
  switch (input.source) {
    case "github":
      return (deps.fetchers?.github ?? fetchSkillFromGitHub)(input.identifier);
    case "agentskills":
      return (deps.fetchers?.agentskills ?? fetchSkillFromAgentSkills)(input.identifier);
    case "url":
      return (deps.fetchers?.url ?? fetchSkillFromUrl)(input.identifier);
  }
}

export async function installSkill(
  input: InstallSkillInput,
  deps: InstallDeps = {}
): Promise<Record<string, unknown>> {
  let skillMd = input.skill_md;
  let fetched: FetchedSkill | null = null;

  if (!skillMd) {
    try {
      fetched = await fetchByInput(input, deps);
      skillMd = fetched.skillMd;
    } catch (error) {
      log.warn("install_skill.fetch_failed", {
        source: input.source,
        identifier: input.identifier,
        error: String(error)
      });
      return {
        success: false,
        name: "",
        validation: {},
        warnings: [`Fetch failed: ${String(error)}`]
      };
    }
  }

  const { output: normalizedSkillMd } = attemptRepair(skillMd);
  const validation = validateSkillInput(skillMd);
  if (!validation.valid) {
    log.info("install_skill.rejected", {
      identifier: input.identifier,
      errors: validation.errors,
      securityFlags: validation.securityFlags
    });
    return {
      success: false,
      name: "",
      validation,
      warnings: []
    };
  }

  const { data } = parseFrontmatter(normalizedSkillMd);
  const name = typeof data.name === "string" ? data.name : "unnamed-skill";

  await writeSkill(name, normalizedSkillMd);

  const sourceMeta: SkillSource = {
    source: input.skill_md ? "inline" : input.source,
    identifier: input.identifier,
    bundledSkillName: input.bundled_skill_name,
    version: input.version,
    upstreamSha: fetched?.upstreamSha,
    fetchedAt: new Date().toISOString(),
    contentHash: sha256(normalizedSkillMd)
  };
  await writeSkillSource(name, sourceMeta);
  await syncProfiles();

  log.info("install_skill.installed", { name, source: sourceMeta.source });

  return {
    success: true,
    name,
    validation,
    warnings: validation.warnings,
    source: sourceMeta
  };
}
