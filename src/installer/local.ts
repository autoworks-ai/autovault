import fs from "node:fs/promises";
import matter from "gray-matter";
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
  skillMdOverride?: string;
};

export type LocalRepairField = {
  path: "agents" | "name" | "description" | "metadata.version" | "resources";
  reason: "missing" | "empty" | "invalid" | "defaulted";
  suggested?: string | string[];
};

export type LocalRepairProfileContext = {
  agent: string;
  root: string;
  label: string;
  matched: boolean;
  source: "configured" | "discovered" | "explicit" | "fallback" | "path";
};

export type LocalRepairProposal =
  | {
      available: true;
      reason: "frontmatter";
      fields: LocalRepairField[];
      suggestedAgents: string[];
      agentChoices: string[];
      profileContext: LocalRepairProfileContext[];
      resourcePaths: string[];
      sourcePath: string;
      canWriteBack: boolean;
    }
  | {
      available: false;
      reason: "security" | "resources" | "unsupported" | "parse";
      fields: LocalRepairField[];
      suggestedAgents: string[];
      agentChoices: string[];
      profileContext: LocalRepairProfileContext[];
      resourcePaths: string[];
      sourcePath: string;
      canWriteBack: boolean;
    };

export type AddLocalSkillResult = {
  success: boolean;
  name: string;
  validation: ReturnType<typeof validateSkillInput>;
  warnings: string[];
  repair?: LocalRepairProposal;
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
  source: LocalRepairProfileContext["source"];
};

async function existingClaudeFallbackRoots(): Promise<AgentRootCandidate[]> {
  const home = os.homedir();
  const candidates: AgentRootCandidate[] = [
    {
      agent: "claude-code",
      root: path.join(home, ".claude", "skills"),
      label: "~/.claude/skills",
      source: "fallback"
    },
    {
      agent: "claude-code",
      root: path.join(home, ".agents", "skills"),
      label: "~/.agents/skills",
      source: "fallback"
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
  const addRoots = (
    roots: Record<string, string>,
    label: string,
    source: LocalRepairProfileContext["source"]
  ): void => {
    for (const [agent, root] of Object.entries(roots)) {
      candidates.push({ agent, root, label, source });
    }
  };

  if (input.discoverProfileRoots !== false) {
    addRoots(await discoverProfileRoots(), "discovered profile root", "discovered");
  }
  addRoots(config.profileRoots, "configured profile root", "configured");
  addRoots(input.profileRoots ?? {}, "explicit profile root", "explicit");
  candidates.push(...(await existingClaudeFallbackRoots()));

  return candidates;
}

const COMMON_AGENT_CHOICES = ["claude-code", "codex", "cursor", "autojack"];
const UNDISCLOSED_RESOURCE_ERROR = /Bundle includes undisclosed file '([^']+)'/;

async function pathHeuristicCandidates(bundleRoot: string): Promise<AgentRootCandidate[]> {
  const home = await normalizePathForComparison(os.homedir());
  const normalizedBundleRoot = await normalizePathForComparison(bundleRoot);
  const dotRoots: AgentRootCandidate[] = [
    { agent: "cursor", root: path.join(home, ".cursor"), label: "~/.cursor", source: "path" },
    { agent: "codex", root: path.join(home, ".codex"), label: "~/.codex", source: "path" },
    { agent: "claude-code", root: path.join(home, ".claude"), label: "~/.claude", source: "path" },
    { agent: "claude-code", root: path.join(home, ".agents"), label: "~/.agents", source: "path" },
    { agent: "autojack", root: path.join(home, ".autojack"), label: "~/.autojack", source: "path" }
  ];
  return dotRoots.filter((candidate) => isSameOrInside(normalizedBundleRoot, candidate.root));
}

async function repairProfileContext(
  bundleRoot: string,
  input: AddLocalSkillInput
): Promise<LocalRepairProfileContext[]> {
  const normalizedBundleRoot = await normalizePathForComparison(bundleRoot);
  const allCandidates = [...(await pathHeuristicCandidates(bundleRoot)), ...(await agentInferenceCandidates(input))];
  const context: LocalRepairProfileContext[] = [];
  const seen = new Set<string>();
  for (const candidate of allCandidates) {
    const normalizedRoot = await normalizePathForComparison(candidate.root);
    const key = `${candidate.agent}\0${normalizedRoot}\0${candidate.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    context.push({
      agent: candidate.agent,
      root: path.resolve(candidate.root),
      label: candidate.label,
      matched: isSameOrInside(normalizedBundleRoot, normalizedRoot),
      source: candidate.source
    });
  }
  return context;
}

function fieldPath(error: string): string {
  return error.split(":", 1)[0] ?? "";
}

function undisclosedResourcePathsFrom(errors: string[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    const resourcePath = UNDISCLOSED_RESOURCE_ERROR.exec(error)?.[1];
    if (!resourcePath || seen.has(resourcePath)) continue;
    seen.add(resourcePath);
    paths.push(resourcePath);
  }
  return paths;
}

function safeDefaultName(bundleRoot: string): string {
  const candidate = path
    .basename(bundleRoot)
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "");
  return /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(candidate) ? candidate : "local-skill";
}

function missingOrEmptyString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

async function canWriteBack(bundleRoot: string): Promise<boolean> {
  const vaultSkillsPath = await normalizePathForComparison(path.join(loadConfig().storagePath, "skills"));
  const normalizedBundleRoot = await normalizePathForComparison(bundleRoot);
  return !isSameOrInside(normalizedBundleRoot, vaultSkillsPath);
}

function frontmatterPreview(skillMd: string): string {
  const parsed = matter(skillMd);
  return matter.stringify("", parsed.data).trimEnd();
}

export function previewSkillFrontmatter(skillMd: string): string {
  return frontmatterPreview(skillMd);
}

export async function buildLocalRepairProposal(
  bundle: LocalSkillBundle,
  skillMd: string,
  validation: ReturnType<typeof validateSkillInput>,
  input: AddLocalSkillInput
): Promise<LocalRepairProposal | undefined> {
  if (validation.valid) return undefined;

  const profileContext = await repairProfileContext(bundle.root, input);
  const matchedAgents = [
    ...new Set(profileContext.filter((item) => item.matched).map((item) => item.agent))
  ];
  const suggestedAgents = matchedAgents.length > 0 ? matchedAgents : ["codex"];
  const agentChoices = [...new Set([...suggestedAgents, ...COMMON_AGENT_CHOICES])];
  const base = {
    fields: [] as LocalRepairField[],
    suggestedAgents,
    agentChoices,
    profileContext,
    resourcePaths: [] as string[],
    sourcePath: path.join(bundle.root, "SKILL.md"),
    canWriteBack: await canWriteBack(bundle.root)
  };

  if (validation.securityFlags.length > 0) {
    return { available: false, reason: "security", ...base };
  }

  let data: Record<string, unknown>;
  try {
    data = parseFrontmatter(skillMd).data;
  } catch {
    return { available: false, reason: "parse", ...base };
  }

  if (!Object.prototype.hasOwnProperty.call(data, "agents")) {
    base.fields.push({ path: "agents", reason: "missing", suggested: suggestedAgents });
  } else if (Array.isArray(data.agents)) {
    if (data.agents.length === 0) {
      base.fields.push({ path: "agents", reason: "empty", suggested: suggestedAgents });
    } else if (data.agents.some((agent) => typeof agent !== "string" || agent.trim().length === 0)) {
      base.fields.push({ path: "agents", reason: "invalid", suggested: suggestedAgents });
    }
  } else {
    base.fields.push({ path: "agents", reason: "invalid", suggested: suggestedAgents });
  }

  if (missingOrEmptyString(data.name)) {
    base.fields.push({ path: "name", reason: "missing", suggested: safeDefaultName(bundle.root) });
  }

  if (missingOrEmptyString(data.description)) {
    base.fields.push({ path: "description", reason: "missing" });
  } else if (typeof data.description === "string" && data.description.trim().length < 20) {
    base.fields.push({ path: "description", reason: "invalid" });
  }

  const metadata = data.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    missingOrEmptyString((metadata as Record<string, unknown>).version)
  ) {
    base.fields.push({ path: "metadata.version", reason: "defaulted", suggested: "1.0.0" });
  }

  const resourcePaths = undisclosedResourcePathsFrom(validation.errors);
  if (resourcePaths.length > 0) {
    base.resourcePaths = resourcePaths;
    base.fields.push({ path: "resources", reason: "missing", suggested: resourcePaths });
  }

  const repairablePaths = new Set(base.fields.map((field) => field.path));
  const unsupportedErrors = validation.errors.filter((error) => {
    if (UNDISCLOSED_RESOURCE_ERROR.test(error) && repairablePaths.has("resources")) return false;
    const path = fieldPath(error);
    if (path === "agents" && repairablePaths.has("agents")) return false;
    if (path === "name" && repairablePaths.has("name")) return false;
    if (path === "description" && repairablePaths.has("description")) return false;
    if (path === "metadata.version" && repairablePaths.has("metadata.version")) return false;
    return true;
  });

  if (unsupportedErrors.length > 0) {
    return { available: false, reason: "resources", ...base };
  }
  const requiredFields = base.fields.filter((field) => field.path !== "metadata.version");
  if (requiredFields.length === 0) {
    return { available: false, reason: "unsupported", ...base };
  }
  return { available: true, reason: "frontmatter", ...base };
}

async function inferAgentsForLocalBundle(
  bundleRoot: string,
  skillMd: string,
  input: AddLocalSkillInput
): Promise<AgentInference | undefined> {
  if (input.syncProfiles === false) return undefined;
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
    if (input.skillMdOverride !== undefined) {
      bundle = { ...bundle, skillMd: input.skillMdOverride };
    }
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
    const repair = await buildLocalRepairProposal(bundle, normalizedSkillMd, validation, input);
    return {
      success: false,
      name: "",
      validation,
      warnings: [],
      ...(repair ? { repair } : {}),
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
  if (input.syncProfiles !== false) {
    try {
      sync = await syncProfiles({
        profileRoots: input.profileRoots,
        discover: input.discoverProfileRoots !== false
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
