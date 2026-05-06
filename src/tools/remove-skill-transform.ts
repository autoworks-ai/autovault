import { syncProfiles } from "../profiles/sync.js";
import { removeSkillTransform } from "../transforms/index.js";
import { log } from "../util/log.js";

export async function removeSkillTransformTool(input: {
  base: string;
  name: string;
}): Promise<Record<string, unknown>> {
  const result = await removeSkillTransform(input);
  const warnings: string[] = [];
  try {
    const syncResult = await syncProfiles();
    warnings.push(...syncResult.warnings);
  } catch (error) {
    const message = `Profile sync failed after transform removal (vault state is correct): ${String(error)}`;
    log.warn("remove_skill_transform.profile_sync_failed", {
      base: input.base,
      name: input.name,
      error: String(error)
    });
    warnings.push(message);
  }
  return { ...result, warnings };
}
