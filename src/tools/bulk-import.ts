import fs from "node:fs/promises";
import path from "node:path";
import { collectLocalSkillBundle, LocalBundleLimitError } from "../installer/local.js";
import { syncProfiles, type SyncProfilesResult } from "../profiles/sync.js";
import type { SkillSource } from "../storage/index.js";
import { bundleHash } from "../util/hash.js";
import { log } from "../util/log.js";
import { formatResultSync } from "../util/sync-format.js";
import { buildSimilarityCorpus, type DedupCandidate } from "../validation/dedup.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import {
  analyzeProposedSkill,
  buildInstalledDedupCorpus,
  writeAcceptedProposedSkill,
  type AcceptedProposedSkill
} from "./propose-skill.js";

export type BulkImportInput = {
  source_dir: string;
  agents?: string[];
  allow_synthesized_frontmatter?: boolean;
  sync_profiles?: boolean;
  profile_roots?: Record<string, string>;
  discover_profile_roots?: boolean;
  verbose?: boolean;
};

type BulkImportEntry = {
  directory: string;
  name?: string;
};

type BulkImportResult = {
  success: boolean;
  source_dir: string;
  summary: {
    accepted: number;
    duplicate: number;
    invalid: number;
    security_blocked: number;
    skipped: number;
    total: number;
  };
  imported: Array<BulkImportEntry & {
    name: string;
    inferred_resources?: Array<{ path: string; type: "file" }>;
    inferred_agents?: string[];
  }>;
  duplicates: Array<BulkImportEntry & { existing_match?: unknown }>;
  invalid: Array<BulkImportEntry & { outcome: "invalid"; errors: string[] }>;
  security_blocked: Array<BulkImportEntry & { security_flags: string[] }>;
  skipped: Array<BulkImportEntry & { reason: string }>;
  warnings: string[];
  sync?: SyncProfilesResult;
};

export async function bulkImport(input: BulkImportInput): Promise<Record<string, unknown>> {
  const sourceDir = path.resolve(input.source_dir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const result: BulkImportResult = {
    success: true,
    source_dir: sourceDir,
    summary: {
      accepted: 0,
      duplicate: 0,
      invalid: 0,
      security_blocked: 0,
      skipped: 0,
      total: 0
    },
    imported: [],
    duplicates: [],
    invalid: [],
    security_blocked: [],
    skipped: [],
    warnings: []
  };
  const dedupCorpus = await buildInstalledDedupCorpus();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    result.summary.total += 1;
    const directory = entry.name;
    const skillDir = path.join(sourceDir, directory);
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!(await pathExists(skillPath))) {
      result.summary.skipped += 1;
      result.skipped.push({ directory, reason: "directory does not contain SKILL.md" });
      continue;
    }

    let bundle: Awaited<ReturnType<typeof collectLocalSkillBundle>>;
    try {
      bundle = await collectLocalSkillBundle(skillDir);
    } catch (error) {
      result.summary.invalid += 1;
      result.invalid.push({
        directory,
        name: undefined,
        outcome: "invalid",
        errors: error instanceof LocalBundleLimitError ? error.errors : [String(error)]
      });
      continue;
    }

    const candidateName = skillNameFromMarkdown(bundle.skillMd);
    const analysis = await analyzeProposedSkill({
      skill_md: bundle.skillMd,
      resources: bundle.resources,
      agents: input.agents,
      allow_synthesized_frontmatter: input.allow_synthesized_frontmatter,
      dedupCorpus
    });

    if (analysis.kind === "response") {
      const response = analysis.response;
      const outcome = response.outcome;
      if (outcome === "duplicate") {
        result.summary.duplicate += 1;
        result.duplicates.push({
          directory,
          name: candidateName,
          existing_match: response.existing_match
        });
      } else if (outcome === "security_blocked") {
        result.summary.security_blocked += 1;
        result.security_blocked.push({
          directory,
          name: candidateName,
          security_flags: asStringArray(response.security_flags)
        });
      } else {
        result.summary.invalid += 1;
        result.invalid.push({
          directory,
          name: candidateName,
          outcome: "invalid",
          errors: asStringArray(response.errors)
        });
      }
      continue;
    }

    const accepted = analysis.accepted;
    await writeAcceptedProposedSkill(accepted, sourceForBundle(sourceDir, directory, accepted));
    dedupCorpus.push(dedupCandidateForAccepted(accepted));
    result.summary.accepted += 1;
    result.imported.push({
      directory,
      name: accepted.name,
      ...(accepted.inferredResources.length > 0
        ? { inferred_resources: accepted.inferredResources }
        : {}),
      ...(accepted.inferredAgents.length > 0 ? { inferred_agents: accepted.inferredAgents } : {})
    });
  }

  if ((input.sync_profiles ?? true) && result.summary.accepted > 0) {
    try {
      result.sync = await syncProfiles({
        profileRoots: input.profile_roots,
        discover: input.discover_profile_roots
      });
      result.warnings.push(...result.sync.warnings);
    } catch (error) {
      const message = `Profile sync failed after bulk import (vault state is correct): ${String(error)}`;
      log.warn("bulk_import.profile_sync_failed", { sourceDir, error: String(error) });
      result.warnings.push(message);
    }
  }

  result.success = result.summary.invalid === 0 && result.summary.security_blocked === 0;
  return formatResultSync(result as unknown as Record<string, unknown>, input.verbose);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function skillNameFromMarkdown(skillMd: string): string | undefined {
  try {
    const { output } = attemptRepair(skillMd);
    const { data } = parseFrontmatter(output);
    return typeof data.name === "string" ? data.name : undefined;
  } catch {
    return undefined;
  }
}

function sourceForBundle(
  sourceDir: string,
  directory: string,
  accepted: AcceptedProposedSkill
): SkillSource {
  return {
    source: "local",
    identifier: path.join(sourceDir, directory),
    fetchedAt: new Date().toISOString(),
    contentHash: bundleHash(accepted.skillMd, accepted.resources)
  };
}

function dedupCandidateForAccepted(accepted: AcceptedProposedSkill): DedupCandidate {
  return {
    name: accepted.name,
    contentHash: accepted.contentHash,
    similarityCorpus: buildSimilarityCorpus(accepted.skillMd, accepted.resources)
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
