import { syncProfiles } from "../profiles/sync.js";
import {
  proposeSkillTransform,
  type ProposeSkillTransformInput
} from "../transforms/index.js";
import { log } from "../util/log.js";

export async function proposeSkillTransformTool(
  input: ProposeSkillTransformInput
): Promise<Record<string, unknown>> {
  const result = await proposeSkillTransform(input);
  if (result.outcome !== "accepted") return result;

  const warnings = [...result.warnings];
  try {
    const syncResult = await syncProfiles();
    warnings.push(...syncResult.warnings);
  } catch (error) {
    const message = `Profile sync failed after transform proposal (vault state is correct): ${String(error)}`;
    log.warn("propose_skill_transform.profile_sync_failed", {
      base: result.base,
      name: result.name,
      error: String(error)
    });
    warnings.push(message);
  }

  return { ...result, warnings };
}
