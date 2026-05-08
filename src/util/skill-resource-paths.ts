import type { SkillRecord } from "../types.js";
import { canonicalRelPath } from "./path.js";

export function resourcePathsForSkill(skill: Pick<SkillRecord, "resources" | "bin">): string[] {
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
