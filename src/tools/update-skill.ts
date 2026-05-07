import { collectLocalSkillBundle, addLocalSkill } from "../installer/local.js";
import { readSkill, readSkillSource } from "../storage/index.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { installSkill } from "./install-skill.js";

export type UpdateSkillInput = {
  name: string;
  source?: "github" | "agentskills" | "url" | "local" | "inline";
  identifier?: string;
  version?: string;
  skill_dir?: string;
  skill_md?: string;
  resources?: Array<{ path: string; content: string }>;
  sync_profiles?: boolean;
  profile_roots?: Record<string, string>;
  discover_profile_roots?: boolean;
};

export async function updateSkill(input: UpdateSkillInput): Promise<Record<string, unknown>> {
  assertSafeSkillName(input.name);
  const existing = await readSkill(input.name);
  if (!existing) {
    return {
      success: false,
      name: input.name,
      validation: {},
      warnings: [`Skill is not installed: ${input.name}`]
    };
  }

  if (input.source === "local") {
    if (!input.skill_dir || !input.identifier) {
      return {
        success: false,
        name: input.name,
        validation: {},
        warnings: ["source='local' requires skill_dir and identifier."]
      };
    }
    const bundle = await collectLocalSkillBundle(input.skill_dir);
    const bundleName = skillNameFromMarkdown(bundle.skillMd);
    if (bundleName !== input.name) {
      return nameMismatch(input.name, bundleName);
    }
    return addLocalSkill({
      skillDir: input.skill_dir,
      source: input.identifier,
      syncProfiles: input.sync_profiles ?? true,
      profileRoots: input.profile_roots,
      discoverProfileRoots: input.discover_profile_roots
    });
  }

  if (input.source === "inline" || input.skill_md) {
    if (!input.skill_md) {
      return {
        success: false,
        name: input.name,
        validation: {},
        warnings: ["source='inline' requires skill_md."]
      };
    }
    return installSkill({
      source: "url",
      identifier: input.identifier ?? `inline:${input.name}`,
      version: input.version,
      skill_md: input.skill_md,
      resources: input.resources,
      expected_name: input.name
    });
  }

  if (input.source) {
    if (!input.identifier) {
      return {
        success: false,
        name: input.name,
        validation: {},
        warnings: [`source='${input.source}' requires identifier.`]
      };
    }
    return installSkill({
      source: input.source,
      identifier: input.identifier,
      version: input.version,
      expected_name: input.name
    });
  }

  const source = await readSkillSource(input.name);
  if (!source) {
    return {
      success: false,
      name: input.name,
      validation: {},
      warnings: ["Skill has no source metadata; provide source/identifier or inline skill_md."]
    };
  }

  if (source.source === "github" || source.source === "agentskills" || source.source === "url") {
    return installSkill({
      source: source.source,
      identifier: source.identifier,
      version: source.version,
      expected_name: input.name
    });
  }

  return {
    success: false,
    name: input.name,
    validation: {},
    warnings: [
      source.source === "local"
        ? "Local skill updates require source='local', skill_dir, and identifier."
        : "Inline skills have no checkable upstream; provide source='inline' and skill_md."
    ]
  };
}

function skillNameFromMarkdown(skillMd: string): string {
  const { output } = attemptRepair(skillMd);
  const { data } = parseFrontmatter(output);
  return typeof data.name === "string" ? data.name : "";
}

function nameMismatch(expected: string, actual: string): Record<string, unknown> {
  return {
    success: false,
    name: expected,
    validation: {},
    warnings: [`Update refused: candidate skill name '${actual}' does not match '${expected}'.`]
  };
}
