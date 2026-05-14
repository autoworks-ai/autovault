import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { syncProfiles } from "../profiles/sync.js";
import { skillDir } from "../storage/index.js";
import { withStorageLock } from "../storage/lock.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { log } from "../util/log.js";

export type DeleteSkillInput = {
  name: string;
  profile_roots?: Record<string, string>;
  discover_profile_roots?: boolean;
};

export async function deleteSkill(input: DeleteSkillInput): Promise<Record<string, unknown>> {
  assertSafeSkillName(input.name);
  let deleted = false;

  await withStorageLock(async () => {
    const root = skillDir(input.name);
    deleted = await fs.lstat(root).then(() => true).catch(() => false);
    await fs.rm(root, { recursive: true, force: true });
  });

  const transformRoot = path.join(loadConfig().storagePath, "transforms", input.name);
  await fs.rm(transformRoot, { recursive: true, force: true }).catch((error) => {
    log.warn("delete_skill.transform_cleanup_failed", { name: input.name, error: String(error) });
  });

  const warnings: string[] = [];
  try {
    const sync = await syncProfiles({
      profileRoots: input.profile_roots,
      discover: input.discover_profile_roots
    });
    warnings.push(...sync.warnings);
    return { deleted, name: input.name, warnings, sync };
  } catch (error) {
    const message = `Profile sync failed after delete (vault state is correct): ${String(error)}`;
    log.warn("delete_skill.profile_sync_failed", { name: input.name, error: String(error) });
    warnings.push(message);
    return { deleted, name: input.name, warnings };
  }
}
