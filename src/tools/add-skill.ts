import { addLocalSkill } from "../installer/local.js";
import { formatResultSync } from "../util/sync-format.js";
import { installSkill } from "./install-skill.js";

export type AddSkillInput = {
  source: "github" | "agentskills" | "url" | "local";
  identifier?: string;
  version?: string;
  skill_dir?: string;
  sync_profiles?: boolean;
  profile_roots?: Record<string, string>;
  discover_profile_roots?: boolean;
  verbose?: boolean;
};

export async function addSkill(input: AddSkillInput): Promise<Record<string, unknown>> {
  if (input.source === "local") {
    if (!input.skill_dir) {
      return {
        success: false,
        name: "",
        validation: {},
        warnings: ["source='local' requires skill_dir."]
      };
    }
    return formatResultSync(
      await addLocalSkill({
        skillDir: input.skill_dir,
        source: input.identifier,
        syncProfiles: input.sync_profiles ?? true,
        profileRoots: input.profile_roots,
        discoverProfileRoots: input.discover_profile_roots
      }),
      input.verbose
    );
  }

  if (!input.identifier) {
    return {
      success: false,
      name: "",
      validation: {},
      warnings: [`source='${input.source}' requires identifier.`]
    };
  }

  return formatResultSync(
    await installSkill({
      source: input.source,
      identifier: input.identifier,
      version: input.version
    }),
    input.verbose
  );
}
