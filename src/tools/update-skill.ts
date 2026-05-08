import { collectLocalSkillBundle, addLocalSkill, LocalBundleLimitError } from "../installer/local.js";
import {
  readSkill,
  readSkillSource,
  readVerifiedSkillResources
} from "../storage/index.js";
import type { SkillRecord } from "../types.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { resourcePathsForSkill } from "../util/skill-resource-paths.js";
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
  reuse_existing_resources?: boolean;
  sync_profiles?: boolean;
  profile_roots?: Record<string, string>;
  discover_profile_roots?: boolean;
  verbose?: boolean;
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
  if (input.skill_md && input.source !== "inline") {
    return {
      success: false,
      name: input.name,
      validation: {},
      warnings: ["skill_md requires source='inline'."]
    };
  }
  if (input.reuse_existing_resources && input.source !== "inline") {
    return {
      success: false,
      name: input.name,
      validation: {},
      warnings: ["reuse_existing_resources requires source='inline'."]
    };
  }
  if (input.reuse_existing_resources && input.resources && input.resources.length > 0) {
    return {
      success: false,
      name: input.name,
      validation: {},
      warnings: ["reuse_existing_resources cannot be combined with resources[]."]
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
    let bundle: Awaited<ReturnType<typeof collectLocalSkillBundle>>;
    try {
      bundle = await collectLocalSkillBundle(input.skill_dir);
    } catch (error) {
      if (error instanceof LocalBundleLimitError) {
        return {
          success: false,
          name: input.name,
          validation: {
            valid: false,
            repaired: false,
            errors: error.errors,
            warnings: [],
            securityFlags: []
          },
          warnings: []
        };
      }
      throw error;
    }
    const bundleName = skillNameFromMarkdown(bundle.skillMd);
    if (bundleName.error) {
      return {
        success: false,
        name: input.name,
        validation: {},
        warnings: [
          `Update refused: candidate skill frontmatter could not be parsed: ${bundleName.error}`
        ]
      };
    }
    if (bundleName.name !== input.name) {
      return nameMismatch(input.name, bundleName.name);
    }
    return formatUpdateResult(
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

  if (input.source === "inline") {
    if (!input.skill_md) {
      return {
        success: false,
        name: input.name,
        validation: {},
        warnings: ["source='inline' requires skill_md."]
      };
    }
    let resources = input.resources;
    if (input.reuse_existing_resources) {
      const reused = await existingResourcesOrFailure(input.name, existing);
      if (!Array.isArray(reused)) return reused;
      resources = reused;
    }
    return formatUpdateResult(await installSkill({
      source: "url",
      identifier: input.identifier ?? `inline:${input.name}`,
      version: input.version,
      skill_md: input.skill_md,
      resources,
      expected_name: input.name
    }), input.verbose);
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
    return formatUpdateResult(await installSkill({
      source: input.source,
      identifier: input.identifier,
      version: input.version,
      expected_name: input.name
    }), input.verbose);
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
    return formatUpdateResult(await installSkill({
      source: source.source,
      identifier: source.identifier,
      version: source.version,
      expected_name: input.name
    }), input.verbose);
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

async function existingResourcesOrFailure(
  name: string,
  existing: SkillRecord
): Promise<Array<{ path: string; content: string }> | Record<string, unknown>> {
  const paths = resourcePathsForSkill(existing);
  const result = await readVerifiedSkillResources(name, paths);
  if (result.kind !== "ok") {
    return {
      success: false,
      name,
      validation: {},
      warnings: [`Cannot reuse existing resources: ${formatResourceReadFailure(result)}`]
    };
  }
  return result.resources;
}

function formatResourceReadFailure(result: Exclude<
  Awaited<ReturnType<typeof readVerifiedSkillResources>>,
  { kind: "ok" }
>): string {
  switch (result.kind) {
    case "no_manifest":
      return "installed skill has no signed manifest; reinstall before reusing resources";
    case "manifest_corrupt":
      return "installed skill has a corrupt signed manifest; reinstall before reusing resources";
    case "tampered":
      return `installed skill integrity check failed: ${result.mismatches
        .map((m) => `${m.file} (${m.reason})`)
        .join(", ")}`;
    case "not_covered":
      return `'${result.resource}' is not covered by the signed manifest`;
    case "signature_invalid":
      return `signature mismatch for '${result.resource}'`;
    case "missing_on_disk":
      return `'${result.resource}' is missing on disk`;
  }
}

function formatUpdateResult(result: Record<string, unknown>, verbose?: boolean): Record<string, unknown> {
  if (verbose) return result;
  const sync = result.sync;
  if (typeof sync !== "object" || sync === null) return result;
  const syncRecord = sync as {
    profiles?: Record<string, string[]>;
    linkedRoots?: Record<string, string>;
    warnings?: string[];
  };
  const compactSync = {
    profiles: Object.fromEntries(
      Object.entries(syncRecord.profiles ?? {}).map(([agent, names]) => [agent, names.length])
    ),
    linkedRoots: syncRecord.linkedRoots ?? {},
    warningCount: syncRecord.warnings?.length ?? 0
  };
  const { sync: _sync, ...rest } = result;
  return { ...rest, sync: compactSync };
}

function skillNameFromMarkdown(skillMd: string): { name: string; error?: string } {
  try {
    const { output } = attemptRepair(skillMd);
    const { data } = parseFrontmatter(output);
    return { name: typeof data.name === "string" ? data.name : "" };
  } catch (error) {
    return {
      name: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function nameMismatch(expected: string, actual: string): Record<string, unknown> {
  return {
    success: false,
    name: expected,
    validation: {},
    warnings: [`Update refused: candidate skill name '${actual}' does not match '${expected}'.`]
  };
}
