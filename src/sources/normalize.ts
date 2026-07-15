import { canonicalRelPath } from "../util/path.js";
import { attemptRepair } from "../validation/frontmatter.js";
import {
  synthesizeSkillFrontmatter,
  type SynthesizedResource
} from "../validation/frontmatter-synthesis.js";
import type { FetchedSkill, FetchedSkillResource } from "./types.js";

export type NormalizedFetchedBundle = FetchedSkill & {
  resources: FetchedSkillResource[];
  inferredResources: SynthesizedResource[];
};

export function normalizeFetchedBundle(fetched: FetchedSkill): NormalizedFetchedBundle {
  const resources = [...(fetched.resources ?? [])].sort((a, b) =>
    canonicalRelPath(a.path).localeCompare(canonicalRelPath(b.path))
  );
  const { output: repaired } = attemptRepair(fetched.skillMd);
  const synthesized = synthesizeSkillFrontmatter(repaired, {
    resources,
    appendMissingResources: true
  });
  const { output: skillMd } = attemptRepair(synthesized.skillMd);

  return {
    ...fetched,
    skillMd,
    resources,
    inferredResources: synthesized.inferredResources
  };
}
