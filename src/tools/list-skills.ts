import { listInstalledSkillNames, readSkillSummary } from "../storage/index.js";
import type { SkillSummary } from "../types.js";

export async function listSkills(): Promise<{ skills: SkillSummary[] }> {
  const names = await listInstalledSkillNames();
  const summaries: SkillSummary[] = [];
  for (const name of names) {
    const summary = await readSkillSummary(name);
    if (summary) summaries.push(summary);
  }
  return { skills: summaries };
}
