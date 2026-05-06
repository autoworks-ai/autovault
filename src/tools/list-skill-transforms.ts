import { listSkillTransforms } from "../transforms/index.js";

export async function listSkillTransformsTool(base?: string): Promise<Record<string, unknown>> {
  return listSkillTransforms({ base });
}
