import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { discoverProfileRoots } from "../profiles/discovery.js";
import { syncProfiles, type SyncProfilesResult } from "../profiles/sync.js";
import {
  skillDir,
  validateResourcePathShape,
  writeSkill,
  type SkillSource,
  type WrittenResource
} from "../storage/index.js";
import { bundleHash } from "../util/hash.js";
import {
  MAX_RESOURCE_BYTES,
  MAX_RESOURCES,
  MAX_SKILL_MD_BYTES,
  MAX_TOTAL_BYTES,
  checkBundleLimits
} from "../util/limits.js";
import { canonicalRelPath } from "../util/path.js";
import { isIgnoredArtifactPath } from "../util/ignored-artifacts.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { synthesizeSkillFrontmatter } from "../validation/frontmatter-synthesis.js";
import { validateSkillInput } from "../validation/index.js";

export type LocalSkillResource = {
  path: string;
  content: string;
};

export type LocalSkillBundle = {
  root: string;
  skillMd: string;
  resources: LocalSkillResource[];
};

export type AddLocalSkillInput = {
  skillDir: string;
  source?: string;
  syncProfiles?: boolean;
  profileRoots?: Record<string, string>;
  discoverProfileRoots?: boolean;
  inferredAgents?: string[];
};

export type AddLocalSkillResult = {
  success: boolean;
  name: string;
  validation: ReturnType<typeof validateSkillInput>;
  warnings: string[];
  source?: SkillSource;
  bundleRoot?: string;
  sourceInferred?: boolean;
  inferredAgents?: string[];
  agentInferenceReason?: string;
  paths?: {
    skill: string;
    storage: string;
  };
  sync?: SyncProfilesResult;
};

function shouldSkipEntry(name: string): boolean {
  return name.startsWith(".autovault-") || isIgnoredArtifactPath(name);
}

async function formatSymlinkRejection(
  baseMessage: string,
  displayPath: string,
  absolutePath: string,
  targetSuffix = ""
): Promise<string> {
  try {
    const target = await fs.realpath(absolutePath);
    return `${baseMessage}: ${displayPath} -> ${target}${targetSuffix}`;
  } catch {
    return `${baseMessage}: ${displayPath}`;
  }
}

export class LocalBundleLimitError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
  }
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function normalizePathForComparison(inputPath: string): Promise<string> {
  const expanded = path.resolve(expandHome(inputPath));
  try {
    return await fs.realpath(expanded);
  } catch {
    return expanded;
  }
}

export async function collectLocalSkillBundle(
  skillDirInput: string,
  options: { followRootSymlink?: boolean } = {}
): Promise<LocalSkillBundle> {
  let inputPath = path.resolve(expandHome(skillDirInput));
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(inputPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Local skill path does not exist: ${skillDirInput}`);
    }
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    if (!options.followRootSymlink) {
      throw new Error(
        await formatSymlinkRejection(
          "Refusing to install local bundle through a symlink directory",
          skillDirInput,
          inputPath,
          ". Use the canonical target path instead."
        )
      );
    }
    inputPath = await fs.realpath(inputPath);
  }
  const resolvedRootStat = rootStat.isSymbolicLink() ? await fs.stat(inputPath) : rootStat;
  let root = inputPath;
  let skillMdPath = path.join(root, "SKILL.md");
  if (resolvedRootStat.isFile()) {
    if (path.basename(inputPath) !== "SKILL.md") {
      throw new Error(`Local skill file must be named SKILL.md: ${skillDirInput}`);
    }
    skillMdPath = inputPath;
    root = path.dirname(inputPath);
  } else if (resolvedRootStat.isDirectory()) {
    skillMdPath = path.join(root, "SKILL.md");
  } else {
    throw new Error(`Local skill path is not a skill directory or SKILL.md file: ${skillDirInput}`);
  }

  let skillMdStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    skillMdStat = await fs.lstat(skillMdPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Local skill directory must contain SKILL.md: ${skillMdPath}`);
    }
    throw error;
  }
  if (!skillMdStat.isFile()) {
    throw new Error(`Local skill directory must contain a regular SKILL.md: ${skillMdPath}`);
  }
  if (skillMdStat.size > MAX_SKILL_MD_BYTES) {
    throw new LocalBundleLimitError([
      `SKILL.md is ${skillMdStat.size} bytes (> ${MAX_SKILL_MD_BYTES})`
    ]);
  }

  const candidates: Array<{ path: string; absolute: string }> = [];
  const seen = new Set<string>();
  let totalBytes = skillMdStat.size;

  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (shouldSkipEntry(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(
          await formatSymlinkRejection(
            "Refusing to install local bundle with symlink resource",
            rel,
            absolute
          )
        );
      }
      if (stat.isDirectory()) {
        await walk(absolute, rel);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Refusing to install local bundle with non-file resource: ${rel}`);
      }
      if (rel === "SKILL.md") continue;
      const canonical = validateResourcePathShape(rel);
      if (seen.has(canonical)) {
        throw new Error(`Duplicate local resource path after normalization: ${canonical}`);
      }
      seen.add(canonical);
      if (candidates.length + 1 > MAX_RESOURCES) {
        throw new LocalBundleLimitError([`Too many resources: ${candidates.length + 1} > ${MAX_RESOURCES}`]);
      }
      if (stat.size > MAX_RESOURCE_BYTES) {
        throw new LocalBundleLimitError([
          `Resource '${canonical}' is ${stat.size} bytes (> ${MAX_RESOURCE_BYTES})`
        ]);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new LocalBundleLimitError([`Bundle total bytes ${totalBytes} > ${MAX_TOTAL_BYTES}`]);
      }
      candidates.push({ path: canonical, absolute });
    }
  }

  await walk(root, "");

  const skillMd = await fs.readFile(skillMdPath, "utf-8");
  const resources: LocalSkillResource[] = [];
  for (const candidate of candidates) {
    resources.push({
      path: canonicalRelPath(candidate.path),
      content: await fs.readFile(candidate.absolute, "utf-8")
    });
  }

  return { root, skillMd, resources };
}

type AgentInference = {
  agents: string[];
  reason: string;
};

type AgentRootCandidate = {
  agent: string;
  root: string;
  label: string;
};

async function existingClaudeFallbackRoots(): Promise<AgentRootCandidate[]> {
  const home = os.homedir();
  const candidates: AgentRootCandidate[] = [
    {
      agent: "claude-code",
      root: path.join(home, ".claude", "skills"),
      label: "~/.claude/skills"
    },
    {
      agent: "claude-code",
      root: path.join(home, ".agents", "skills"),
      label: "~/.agents/skills"
    }
  ];
  const existing: AgentRootCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate.root);
      if (stat.isDirectory()) existing.push(candidate);
    } catch {
      // Missing fallback roots are not profile evidence.
    }
  }
  return existing;
}

async function agentInferenceCandidates(input: AddLocalSkillInput): Promise<AgentRootCandidate[]> {
  const config = loadConfig();
  const candidates: AgentRootCandidate[] = [];
  const addRoots = (roots: Record<string, string>, label: string): void => {
    for (const [agent, root] of Object.entries(roots)) {
      candidates.push({ agent, root, label });
    }
  };

  if (input.discoverProfileRoots) {
    addRoots(await discoverProfileRoots(), "discovered profile root");
  }
  addRoots(config.profileRoots, "configured profile root");
  addRoots(input.profileRoots ?? {}, "explicit profile root");
  candidates.push(...(await existingClaudeFallbackRoots()));

  return candidates;
}

async function inferAgentsForLocalBundle(
  bundleRoot: string,
  skillMd: string,
  input: AddLocalSkillInput
): Promise<AgentInference | undefined> {
  if (!input.syncProfiles) return undefined;
  let data: Record<string, unknown>;
  try {
    data = parseFrontmatter(skillMd).data;
  } catch {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(data, "agents")) return undefined;

  const normalizedBundleRoot = await normalizePathForComparison(bundleRoot);
  const matches: AgentRootCandidate[] = [];
  for (const candidate of await agentInferenceCandidates(input)) {
    const normalizedRoot = await normalizePathForComparison(candidate.root);
    if (isSameOrInside(normalizedBundleRoot, normalizedRoot)) {
      matches.push(candidate);
    }
  }

  const agents = [...new Set(matches.map((match) => match.agent))];
  if (agents.length === 0) return undefined;
  const rootLabels = [
    ...new Set(matches.map((match) => `${match.label} (${path.resolve(expandHome(match.root))})`))
  ];
  return {
    agents,
    reason: `missing agents inferred from ${rootLabels.join(", ")}`
  };
}

export async function addLocalSkill(input: AddLocalSkillInput): Promise<AddLocalSkillResult> {
  let bundle: LocalSkillBundle;
  try {
    bundle = await collectLocalSkillBundle(input.skillDir);
  } catch (error) {
    if (error instanceof LocalBundleLimitError) {
      return {
        success: false,
        name: "",
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

  const sourceInferred = input.source === undefined || input.source.trim().length === 0;
  const sourceIdentifier = sourceInferred ? bundle.root : input.source!;

  const limitErrors = checkBundleLimits(bundle.skillMd, bundle.resources);
  if (limitErrors.length > 0) {
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
      warnings: [],
      bundleRoot: bundle.root,
      sourceInferred
    };
  }

  const { output: repairedSkillMd } = attemptRepair(bundle.skillMd);
  let normalizedSkillMd = repairedSkillMd;
  const agentInference = input.inferredAgents
    ? {
        agents: input.inferredAgents,
        reason: "agents provided by caller"
      }
    : await inferAgentsForLocalBundle(bundle.root, repairedSkillMd, input);
  if ((agentInference?.agents.length ?? 0) > 0) {
    try {
      const synthesized = synthesizeSkillFrontmatter(repairedSkillMd, {
        agents: agentInference?.agents
      });
      normalizedSkillMd = synthesized.skillMd;
    } catch {
      normalizedSkillMd = repairedSkillMd;
    }
  }
  const validation = validateSkillInput(normalizedSkillMd, bundle.resources);
  if (!validation.valid) {
    return {
      success: false,
      name: "",
      validation,
      warnings: [],
      bundleRoot: bundle.root,
      sourceInferred,
      ...(agentInference
        ? {
            inferredAgents: agentInference.agents,
            agentInferenceReason: agentInference.reason
          }
        : {})
    };
  }

  const { data } = parseFrontmatter(normalizedSkillMd);
  const name = typeof data.name === "string" ? data.name : "unnamed-skill";
  const resources: WrittenResource[] = bundle.resources.map((resource) => ({
    path: resource.path,
    content: resource.content
  }));
  const source: SkillSource = {
    source: "local",
    identifier: sourceIdentifier,
    fetchedAt: new Date().toISOString(),
    contentHash: bundleHash(normalizedSkillMd, resources)
  };

  await writeSkill(name, normalizedSkillMd, resources, source);

  const warnings = [...validation.warnings];
  let sync: SyncProfilesResult | undefined;
  if (input.syncProfiles) {
    try {
      sync = await syncProfiles({
        profileRoots: input.profileRoots,
        discover: input.discoverProfileRoots
      });
      warnings.push(...sync.warnings);
    } catch (error) {
      warnings.push(`Profile sync failed after local install (vault state is correct): ${String(error)}`);
    }
  }

  const config = loadConfig();
  return {
    success: true,
    name,
    validation,
    warnings,
    source,
    bundleRoot: bundle.root,
    sourceInferred,
    ...(agentInference
      ? {
          inferredAgents: agentInference.agents,
          agentInferenceReason: agentInference.reason
        }
      : {}),
    paths: {
      skill: skillDir(name),
      storage: config.storagePath
    },
    sync
  };
}
