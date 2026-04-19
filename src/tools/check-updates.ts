import {
  listInstalledSkillNames,
  readSkill,
  readSkillSource,
  type SkillSource
} from "../storage/index.js";
import { fetchSkillFromAgentSkills } from "../sources/agentskills.js";
import { fetchSkillFromGitHub } from "../sources/github.js";
import { fetchSkillFromUrl } from "../sources/url.js";
import type { FetchedSkill } from "../sources/types.js";
import { sha256 } from "../util/hash.js";

type DriftEntry = {
  name: string;
  source: SkillSource["source"];
  identifier: string;
  reason: string;
  upstreamSha?: string;
};

export type CheckUpdatesDeps = {
  fetchers?: {
    github?: typeof fetchSkillFromGitHub;
    agentskills?: typeof fetchSkillFromAgentSkills;
    url?: typeof fetchSkillFromUrl;
  };
};

async function fetchForSource(
  source: SkillSource,
  deps: CheckUpdatesDeps
): Promise<FetchedSkill | null> {
  switch (source.source) {
    case "github":
      return (deps.fetchers?.github ?? fetchSkillFromGitHub)(source.identifier);
    case "agentskills":
      return (deps.fetchers?.agentskills ?? fetchSkillFromAgentSkills)(source.identifier);
    case "url":
      return (deps.fetchers?.url ?? fetchSkillFromUrl)(source.identifier);
    case "inline":
      return null;
  }
}

export async function checkUpdates(
  skill?: string,
  deps: CheckUpdatesDeps = {}
): Promise<{
  drifted: DriftEntry[];
  up_to_date: string[];
  errors: Array<{ name: string; error: string }>;
}> {
  const names = skill ? [skill] : await listInstalledSkillNames();
  const drifted: DriftEntry[] = [];
  const upToDate: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const name of names) {
    const installed = await readSkill(name);
    if (!installed) {
      errors.push({ name, error: "Skill not installed" });
      continue;
    }
    const source = await readSkillSource(name);
    if (!source) {
      errors.push({ name, error: "No source metadata recorded" });
      continue;
    }
    if (source.source === "inline") {
      upToDate.push(name);
      continue;
    }
    try {
      const fetched = await fetchForSource(source, deps);
      if (!fetched) {
        upToDate.push(name);
        continue;
      }
      const upstreamHash = sha256(fetched.skillMd);
      if (
        upstreamHash !== source.contentHash ||
        (fetched.upstreamSha && source.upstreamSha && fetched.upstreamSha !== source.upstreamSha)
      ) {
        drifted.push({
          name,
          source: source.source,
          identifier: source.identifier,
          reason: upstreamHash !== source.contentHash ? "content hash changed" : "upstream sha changed",
          upstreamSha: fetched.upstreamSha
        });
      } else {
        upToDate.push(name);
      }
    } catch (error) {
      errors.push({ name, error: String(error) });
    }
  }

  return { drifted, up_to_date: upToDate, errors };
}
