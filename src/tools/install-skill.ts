import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { validateSkillInput } from "../validation/index.js";
import {
  type SkillSource,
  validateResourcePathShape,
  writeSkill
} from "../storage/index.js";
import { fetchSkillFromAgentSkills } from "../sources/agentskills.js";
import { fetchSkillFromGitHub } from "../sources/github.js";
import { fetchSkillFromUrl } from "../sources/url.js";
import type { FetchedSkill } from "../sources/types.js";
import { bundleHash } from "../util/hash.js";
import { checkBundleLimits } from "../util/limits.js";
import { log } from "../util/log.js";
import { syncProfiles } from "../profiles/sync.js";

export type InstallSkillResource = { path: string; content: string };

export type InstallSkillInput = {
  source: "github" | "agentskills" | "url";
  identifier: string;
  version?: string;
  skill_md?: string;
  bundled_skill_name?: string;
  resources?: InstallSkillResource[];
};

type InstallDeps = {
  fetchers?: {
    github?: typeof fetchSkillFromGitHub;
    agentskills?: typeof fetchSkillFromAgentSkills;
    url?: typeof fetchSkillFromUrl;
  };
};

type ResourceMergeResult = {
  resources: InstallSkillResource[];
  rejection: string | null;
};

function mergeResources(
  fromInput: InstallSkillResource[],
  fromFetch: InstallSkillResource[],
  isInline: boolean
): ResourceMergeResult {
  // Provenance rule: when the install resolves bytes from a remote source, the
  // adapter's resources are authoritative. Allowing caller-supplied resources
  // would let an MCP caller substitute their own bin/setup while keeping the
  // recorded source/upstreamSha pointing at a trusted repo — laundered
  // provenance that check_updates can't detect (contentHash covers SKILL.md
  // only). Inline installs (skill_md supplied) are the documented path for
  // shipping resources from the caller.
  if (!isInline && fromInput.length > 0) {
    return {
      resources: [],
      rejection:
        "Caller-supplied resources are not accepted for non-inline installs. " +
        "Either install inline (provide skill_md) or remove resources[]."
    };
  }
  if (isInline) return { resources: fromInput, rejection: null };
  return { resources: fromFetch, rejection: null };
}

async function fetchByInput(
  input: InstallSkillInput,
  deps: InstallDeps
): Promise<FetchedSkill> {
  switch (input.source) {
    case "github":
      return (deps.fetchers?.github ?? fetchSkillFromGitHub)(input.identifier);
    case "agentskills":
      return (deps.fetchers?.agentskills ?? fetchSkillFromAgentSkills)(input.identifier);
    case "url":
      return (deps.fetchers?.url ?? fetchSkillFromUrl)(input.identifier);
  }
}

export async function installSkill(
  input: InstallSkillInput,
  deps: InstallDeps = {}
): Promise<Record<string, unknown>> {
  let skillMd = input.skill_md;
  let fetched: FetchedSkill | null = null;

  if (!skillMd) {
    try {
      fetched = await fetchByInput(input, deps);
      skillMd = fetched.skillMd;
    } catch (error) {
      log.warn("install_skill.fetch_failed", {
        source: input.source,
        identifier: input.identifier,
        error: String(error)
      });
      return {
        success: false,
        name: "",
        validation: {},
        warnings: [`Fetch failed: ${String(error)}`]
      };
    }
  }

  const isInline = Boolean(input.skill_md);

  // URL/agentskills adapters don't fetch sibling files — they return only
  // SKILL.md + sourceUrl. If the SKILL.md they fetched declares `bin:` or
  // frontmatter `resources:`, no merge path can satisfy the bundle: caller
  // resources are rejected for non-inline (laundered provenance), and the
  // adapter delivered nothing. Validation would still catch this — but the
  // error message says "declare it in resources[]", which is wrong for non-
  // inline sources where the caller can't supply resources at all. Emit a
  // source-specific error here so the user sees the actual remediation
  // ("install via github or inline") instead of a misleading hint.
  if (!isInline && fetched && (fetched.resources?.length ?? 0) === 0) {
    let parsedFrontmatter: Record<string, unknown> | null = null;
    try {
      parsedFrontmatter = parseFrontmatter(skillMd).data as Record<string, unknown>;
    } catch {
      parsedFrontmatter = null;
    }
    if (parsedFrontmatter) {
      const binBlock = parsedFrontmatter.bin;
      const hasBin =
        typeof binBlock === "object" &&
        binBlock !== null &&
        Object.keys(binBlock as Record<string, unknown>).length > 0;
      const declaredResources = parsedFrontmatter.resources;
      const hasResources = Array.isArray(declaredResources) && declaredResources.length > 0;
      if (hasBin || hasResources) {
        const message =
          `Source '${input.source}' does not fetch skill resources — only SKILL.md. ` +
          `The fetched skill declares ${hasBin ? "bin actions" : "resources"}, which require a complete bundle. ` +
          `Install via 'github' source (which fetches all declared resources at the pinned SHA) or inline ` +
          `(provide skill_md and resources[] directly).`;
        log.warn("install_skill.source_lacks_resources", {
          source: input.source,
          identifier: input.identifier,
          hasBin,
          hasResources
        });
        return {
          success: false,
          name: "",
          validation: {},
          warnings: [message]
        };
      }
    }
  }

  const merge = mergeResources(input.resources ?? [], fetched?.resources ?? [], isInline);
  if (merge.rejection) {
    log.warn("install_skill.resources_rejected", {
      source: input.source,
      identifier: input.identifier,
      reason: merge.rejection
    });
    return {
      success: false,
      name: "",
      validation: {},
      warnings: [merge.rejection]
    };
  }
  const resources = merge.resources;

  // Enforce raw byte caps BEFORE any repair/parse work. attemptRepair runs
  // full-string regex passes — feeding it a 100 MiB SKILL.md burns CPU and
  // memory before validateSkillInput's internal limit check fires. Repeating
  // the cheap byte check here keeps the DoS guard at the actual entry point.
  const limitErrors = checkBundleLimits(skillMd, resources);
  if (limitErrors.length > 0) {
    log.info("install_skill.rejected_size", { identifier: input.identifier, errors: limitErrors });
    return {
      success: false,
      name: "",
      validation: {
        valid: false,
        repaired: false,
        errors: limitErrors,
        warnings: [],
        securityFlags: []
      },
      warnings: []
    };
  }

  const { output: normalizedSkillMd } = attemptRepair(skillMd);
  const validation = validateSkillInput(skillMd, resources);
  if (!validation.valid) {
    log.info("install_skill.rejected", {
      identifier: input.identifier,
      errors: validation.errors,
      securityFlags: validation.securityFlags
    });
    return {
      success: false,
      name: "",
      validation,
      warnings: []
    };
  }

  const { data } = parseFrontmatter(normalizedSkillMd);
  const name = typeof data.name === "string" ? data.name : "unnamed-skill";

  for (const resource of resources) {
    try {
      // Round-62: path-shape only. The live-tree variant (validateResourcePath)
      // probes the existing skill directory's ancestors and rejects if e.g.
      // bin/ has been left as a symlink to /tmp by a partial-write or
      // attacker. That's the corruption a reinstall is meant to recover
      // from, so probing the live tree here wedges the very recovery path.
      // writeSkill's internal validateStagedResourcePath still probes the
      // freshly-staged tmp dir to catch staging-side TOCTOU.
      validateResourcePathShape(resource.path);
    } catch (error) {
      log.warn("install_skill.resource_rejected", { name, error: String(error) });
      return {
        success: false,
        name: "",
        validation,
        warnings: [`Resource path rejected: ${String(error)}`]
      };
    }
  }

  // Build the source record BEFORE writeSkill so the staged tmp dir lands
  // SKILL.md/resources/manifest/source atomically. A crash between the swap
  // and a follow-up source write would otherwise leave live bytes paired with
  // stale source metadata, fooling check_updates' contentHash drift detection.
  const sourceMeta: SkillSource = {
    source: input.skill_md ? "inline" : input.source,
    identifier: input.identifier,
    bundledSkillName: input.bundled_skill_name,
    version: input.version,
    upstreamSha: fetched?.upstreamSha,
    fetchedAt: new Date().toISOString(),
    contentHash: bundleHash(normalizedSkillMd, resources)
  };
  await writeSkill(name, normalizedSkillMd, resources, sourceMeta);

  // Profile sync is post-install convenience — the vault is already committed
  // by the time we get here. A failure inside syncProfiles (e.g. an external
  // profile root whose path for this skill is a non-symlink directory, or a
  // permission denial on `~/.claude/skills/`) must NOT escalate to a hard
  // install failure: the SKILL.md, manifest, source provenance, and bin
  // resources are already on disk, so a "failed" return would (a) lie about
  // vault state, breaking idempotency, and (b) cause callers to retry into a
  // dedup-rejected state instead of fixing the profile-root conflict.
  // Surface as a warning the caller can present to the user, log the detail
  // for the operator, and return success.
  const postInstallWarnings: string[] = [];
  try {
    const syncResult = await syncProfiles();
    for (const w of syncResult.warnings) postInstallWarnings.push(w);
  } catch (error) {
    const message = `Profile sync failed after install (vault state is correct): ${String(error)}`;
    log.warn("install_skill.profile_sync_failed", { name, error: String(error) });
    postInstallWarnings.push(message);
  }

  log.info("install_skill.installed", { name, source: sourceMeta.source });

  return {
    success: true,
    name,
    validation,
    warnings: [...validation.warnings, ...postInstallWarnings],
    source: sourceMeta
  };
}
