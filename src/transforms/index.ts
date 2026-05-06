import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { loadConfig } from "../config.js";
import {
  readSkill,
  skillDir,
  validateResourcePathShape
} from "../storage/index.js";
import { withStorageLock } from "../storage/lock.js";
import type { ValidationResult } from "../types.js";
import { MAX_RESOURCE_BYTES, MAX_SKILL_MD_BYTES, MAX_TOTAL_BYTES } from "../util/limits.js";
import { canonicalRelPath } from "../util/path.js";
import { parseManifest, signFiles, verifyFile } from "../util/sign.js";
import { sha256 } from "../util/hash.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { validateSkillInput, type ValidationResource } from "../validation/index.js";

const TRANSFORM_FILE = "TRANSFORM.md";
const BASE_SNAPSHOT_FILE = "BASE_SKILL.md";
const TRANSFORM_METADATA_FILE = ".autovault-transform.json";
const TRANSFORM_MANIFEST_FILE = ".autovault-manifest";
const RENDER_METADATA_FILE = ".autovault-render.json";

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

const toolsOverrideSchema = z
  .object({
    add: z.array(z.string().min(1)).optional().default([]),
    remove: z.array(z.string().min(1)).optional().default([])
  })
  .optional();

const capabilityOverridesSchema = z
  .object({
    network: z.boolean().optional(),
    filesystem: z.enum(["readonly", "readwrite"]).optional(),
    tools: toolsOverrideSchema
  })
  .optional()
  .default({});

const transformSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, "must be alphanumeric with - or _"),
  base: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, "must be alphanumeric with - or _"),
  description: z.string().min(20),
  targets: z
    .object({
      agents: z
        .array(
          z
            .string()
            .min(1)
            .regex(AGENT_NAME_PATTERN, "agent name must match ^[a-z][a-z0-9-]*$")
        )
        .optional()
        .default([])
    })
    .optional()
    .default({ agents: [] }),
  priority: z.number().int().finite().optional().default(0),
  capability_overrides: capabilityOverridesSchema,
  metadata: z
    .object({
      version: z.string().default("1.0.0")
    })
    .optional()
    .default({ version: "1.0.0" })
});

type ParsedTransformData = z.infer<typeof transformSchema>;

export type TransformCapabilityOverrides = {
  network?: boolean;
  filesystem?: "readonly" | "readwrite";
  tools?: {
    add: string[];
    remove: string[];
  };
};

export type SkillTransform = {
  name: string;
  base: string;
  description: string;
  priority: number;
  agents: string[];
  version: string;
  capabilityOverrides: TransformCapabilityOverrides;
  transformMd: string;
  body: string;
  pinnedBaseSkillMd: string;
  pinnedBaseHash: string;
  pinnedBaseVersion: string;
  updatedAt: string;
};

export type SkillTransformSummary = {
  name: string;
  base: string;
  description?: string;
  priority?: number;
  agents?: string[];
  version?: string;
  pinned_base_hash?: string;
  pinned_base_version?: string;
  updated_at?: string;
  status: "ok" | "tampered";
  error?: string;
};

export type ProposeSkillTransformInput = {
  transform_md: string;
  replace?: boolean;
};

export type ProposeSkillTransformResult =
  | {
      outcome: "accepted";
      base: string;
      name: string;
      warnings: string[];
      pinned_base_hash: string;
      pinned_base_version: string;
    }
  | { outcome: "duplicate"; base: string; name: string; errors: string[] }
  | { outcome: "invalid"; errors: string[]; warnings: string[] };

export type RenderedSkillTransform = {
  name: string;
  description: string;
  priority: number;
  version: string;
  pinned_base_hash: string;
  pinned_base_version: string;
};

export type RenderSkillForAgentResult = {
  name: string;
  agent: string;
  skill_md: string;
  resources: ValidationResource[];
  applied_transforms: RenderedSkillTransform[];
  warnings: string[];
  validation: ValidationResult;
};

export type MaterializedSkillRender = RenderSkillForAgentResult & {
  path: string;
};

export type TransformReview = {
  base: string;
  transform: string;
  reason: "base_skill_changed";
  pinned_base_hash: string;
  current_base_hash: string;
  pinned_base_version: string;
  current_base_version: string;
  pinned_skill_md: string;
};

type TransformMetadata = {
  base: string;
  name: string;
  pinnedBaseHash: string;
  pinnedBaseVersion: string;
  updatedAt: string;
};

function transformsRoot(): string {
  return path.join(loadConfig().storagePath, "transforms");
}

function renderedRoot(): string {
  return path.join(loadConfig().storagePath, "rendered");
}

export function skillTransformDir(base: string, name: string): string {
  return path.join(transformsRoot(), base, name);
}

function renderDir(agent: string, name: string): string {
  return path.join(renderedRoot(), agent, name);
}

function transformIdentity(base: string, name: string): string {
  return `transform:${base}:${name}`;
}

function renderIdentity(agent: string, name: string): string {
  return `rendered:${agent}:${name}`;
}

function validateAgentName(agent: string): void {
  if (!AGENT_NAME_PATTERN.test(agent)) {
    throw new Error(`Invalid agent name: ${agent}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeTransformData(data: ParsedTransformData): Omit<
  SkillTransform,
  "transformMd" | "body" | "pinnedBaseSkillMd" | "pinnedBaseHash" | "pinnedBaseVersion" | "updatedAt"
> {
  return {
    name: data.name,
    base: data.base,
    description: data.description,
    priority: data.priority,
    agents: data.targets.agents,
    version: data.metadata.version,
    capabilityOverrides: {
      network: data.capability_overrides.network,
      filesystem: data.capability_overrides.filesystem,
      tools: data.capability_overrides.tools
        ? {
            add: data.capability_overrides.tools.add,
            remove: data.capability_overrides.tools.remove
          }
        : undefined
    }
  };
}

function parseTransformMd(transformMd: string): {
  transform: Omit<
    SkillTransform,
    "transformMd" | "body" | "pinnedBaseSkillMd" | "pinnedBaseHash" | "pinnedBaseVersion" | "updatedAt"
  >;
  normalizedTransformMd: string;
  body: string;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  if (Buffer.byteLength(transformMd, "utf-8") > MAX_SKILL_MD_BYTES) {
    return {
      transform: {} as never,
      normalizedTransformMd: "",
      body: "",
      warnings,
      errors: [`TRANSFORM.md exceeds size limit: ${MAX_SKILL_MD_BYTES} bytes`]
    };
  }

  const { output, repaired } = attemptRepair(transformMd);
  if (repaired) warnings.push("Transform frontmatter formatting was auto-normalized.");

  let parsed: { data: Record<string, unknown>; content: string };
  try {
    parsed = parseFrontmatter(output);
  } catch (error) {
    return {
      transform: {} as never,
      normalizedTransformMd: output,
      body: "",
      warnings,
      errors: [`Transform frontmatter parsing failed: ${String(error)}`]
    };
  }

  const result = transformSchema.safeParse(parsed.data);
  if (!result.success) {
    return {
      transform: {} as never,
      normalizedTransformMd: output,
      body: parsed.content,
      warnings,
      errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    };
  }

  const body = parsed.content.trim();
  if (body.length === 0) {
    return {
      transform: normalizeTransformData(result.data),
      normalizedTransformMd: output,
      body,
      warnings,
      errors: ["Transform body must not be empty."]
    };
  }

  return {
    transform: normalizeTransformData(result.data),
    normalizedTransformMd: output,
    body,
    warnings,
    errors: []
  };
}

function transformMatchesAgent(transform: SkillTransform, agent: string): boolean {
  return transform.agents.length === 0 || transform.agents.includes(agent);
}

function sortTransforms(transforms: SkillTransform[]): SkillTransform[] {
  return [...transforms].sort((a, b) => {
    const priority = a.priority - b.priority;
    if (priority !== 0) return priority;
    return a.name.localeCompare(b.name);
  });
}

function applyCapabilityOverrides(
  frontmatter: Record<string, unknown>,
  transforms: SkillTransform[]
): void {
  if (transforms.length === 0) return;
  const caps = cloneRecord(asRecord(frontmatter.capabilities));
  for (const transform of transforms) {
    const override = transform.capabilityOverrides;
    if (override.network !== undefined) caps.network = override.network;
    if (override.filesystem !== undefined) caps.filesystem = override.filesystem;
    if (override.tools) {
      const current = Array.isArray(caps.tools)
        ? caps.tools.filter((item): item is string => typeof item === "string")
        : [];
      const remove = new Set(override.tools.remove.map((tool) => tool.toLowerCase()));
      const next = current.filter((tool) => !remove.has(tool.toLowerCase()));
      for (const tool of override.tools.add) {
        if (!next.some((existing) => existing.toLowerCase() === tool.toLowerCase())) {
          next.push(tool);
        }
      }
      caps.tools = next;
    }
  }
  frontmatter.capabilities = caps;
}

function composeSkillMd(baseSkillMd: string, transforms: SkillTransform[]): string {
  if (transforms.length === 0) return baseSkillMd;
  const parsed = parseFrontmatter(baseSkillMd);
  const frontmatter = cloneRecord(parsed.data);
  applyCapabilityOverrides(frontmatter, transforms);

  let content = parsed.content.trimEnd();
  content += "\n\n## AutoVault Transform Overlays\n\n";
  content +=
    "This generated skill variant applies vault-local transform instructions. " +
    "When a transform conflicts with the base skill, follow the transform for this generated profile.\n";

  for (const transform of transforms) {
    content += `\n### ${transform.name}\n\n`;
    content += `${transform.description}\n\n`;
    content += `${transform.body.trim()}\n`;
  }

  return matter.stringify(`${content}\n`, frontmatter).replace(/\n+$/, "\n");
}

function declaredBinPaths(skillMd: string): Set<string> {
  const paths = new Set<string>();
  try {
    const { data } = parseFrontmatter(skillMd);
    const bin = data.bin;
    if (typeof bin !== "object" || bin === null) return paths;
    for (const raw of Object.values(bin as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const command = (raw as Record<string, unknown>).command;
      if (typeof command === "string" && command.length > 0) {
        paths.add(canonicalRelPath(command));
      }
    }
  } catch {
    return paths;
  }
  return paths;
}

async function readResourceBundleUnlocked(name: string): Promise<ValidationResource[]> {
  const root = skillDir(name);
  const resources: ValidationResource[] = [];
  let totalBytes = 0;

  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === "SKILL.md" || entry.name.startsWith(".autovault-")) continue;
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.lstat(abs);
      if (!stat.isFile() || stat.size > MAX_RESOURCE_BYTES) continue;
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`Rendered resource bundle exceeds limit: ${MAX_TOTAL_BYTES} bytes`);
      }
      resources.push({
        path: canonicalRelPath(rel),
        content: await fs.readFile(abs, "utf-8")
      });
    }
  }

  await walk(root, "");
  return resources;
}

async function readResourceBundle(name: string): Promise<ValidationResource[]> {
  return withStorageLock(() => readResourceBundleUnlocked(name));
}

async function readTransformStatus(
  base: string,
  name: string
): Promise<{ status: "ok"; transform: SkillTransform } | { status: "tampered"; summary: SkillTransformSummary }> {
  assertSafeSkillName(base);
  assertSafeSkillName(name);
  const dir = skillTransformDir(base, name);
  const manifestRaw = await fs.readFile(path.join(dir, TRANSFORM_MANIFEST_FILE), "utf-8").catch(() => null);
  if (manifestRaw === null) {
    return {
      status: "tampered",
      summary: { base, name, status: "tampered", error: "Transform manifest is missing" }
    };
  }
  const manifest = parseManifest(manifestRaw);
  if (!manifest) {
    return {
      status: "tampered",
      summary: { base, name, status: "tampered", error: "Transform manifest is corrupt" }
    };
  }

  const files: Record<string, string> = {};
  for (const filePath of [TRANSFORM_FILE, BASE_SNAPSHOT_FILE, TRANSFORM_METADATA_FILE]) {
    const raw = await fs.readFile(path.join(dir, filePath), "utf-8").catch(() => null);
    if (raw === null) {
      return {
        status: "tampered",
        summary: {
          base,
          name,
          status: "tampered",
          error: `${filePath} is missing`
        }
      };
    }
    const verified = await verifyFile(manifest, transformIdentity(base, name), filePath, raw);
    if (!verified.present || !verified.valid) {
      return {
        status: "tampered",
        summary: {
          base,
          name,
          status: "tampered",
          error: `${filePath} signature is invalid`
        }
      };
    }
    files[filePath] = raw;
  }

  let metadata: TransformMetadata;
  try {
    metadata = JSON.parse(files[TRANSFORM_METADATA_FILE]) as TransformMetadata;
  } catch {
    return {
      status: "tampered",
      summary: { base, name, status: "tampered", error: "Transform metadata is unparseable" }
    };
  }
  if (metadata.base !== base || metadata.name !== name) {
    return {
      status: "tampered",
      summary: { base, name, status: "tampered", error: "Transform metadata identity mismatch" }
    };
  }

  const parsed = parseTransformMd(files[TRANSFORM_FILE]);
  if (parsed.errors.length > 0) {
    return {
      status: "tampered",
      summary: {
        base,
        name,
        status: "tampered",
        error: parsed.errors.join("; ")
      }
    };
  }
  if (parsed.transform.base !== base || parsed.transform.name !== name) {
    return {
      status: "tampered",
      summary: { base, name, status: "tampered", error: "TRANSFORM.md identity mismatch" }
    };
  }

  return {
    status: "ok",
    transform: {
      ...parsed.transform,
      transformMd: files[TRANSFORM_FILE],
      body: parsed.body,
      pinnedBaseSkillMd: files[BASE_SNAPSHOT_FILE],
      pinnedBaseHash: metadata.pinnedBaseHash,
      pinnedBaseVersion: metadata.pinnedBaseVersion,
      updatedAt: metadata.updatedAt
    }
  };
}

async function transformNamesForBase(base: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(transformsRoot(), base), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.includes("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function baseNamesWithTransforms(): Promise<string[]> {
  try {
    const entries = await fs.readdir(transformsRoot(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.includes("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function readTransformsForBase(base: string): Promise<{
  transforms: SkillTransform[];
  summaries: SkillTransformSummary[];
}> {
  const transforms: SkillTransform[] = [];
  const summaries: SkillTransformSummary[] = [];
  for (const name of await transformNamesForBase(base)) {
    const status = await readTransformStatus(base, name);
    if (status.status === "ok") {
      transforms.push(status.transform);
      summaries.push(transformSummary(status.transform, "ok"));
    } else {
      summaries.push(status.summary);
    }
  }
  return { transforms: sortTransforms(transforms), summaries };
}

function transformSummary(
  transform: SkillTransform,
  status: "ok" | "tampered",
  error?: string
): SkillTransformSummary {
  return {
    name: transform.name,
    base: transform.base,
    description: transform.description,
    priority: transform.priority,
    agents: transform.agents,
    version: transform.version,
    pinned_base_hash: transform.pinnedBaseHash,
    pinned_base_version: transform.pinnedBaseVersion,
    updated_at: transform.updatedAt,
    status,
    error
  };
}

function candidateTransformList(
  existing: SkillTransform[],
  proposed: SkillTransform
): SkillTransform[] {
  const withoutSame = existing.filter(
    (transform) => transform.base !== proposed.base || transform.name !== proposed.name
  );
  return sortTransforms([...withoutSame, proposed]);
}

function targetAgentsForValidation(
  proposed: SkillTransform,
  baseAgents: string[]
): string[] {
  if (proposed.agents.length > 0) return proposed.agents;
  return baseAgents.length > 0 ? baseAgents : ["codex"];
}

function composedValidationForAgent(args: {
  baseSkillMd: string;
  transforms: SkillTransform[];
  resources: ValidationResource[];
  agent: string;
}): { validation: ValidationResult; warnings: string[]; skillMd: string; applied: SkillTransform[] } {
  const applied = args.transforms.filter((transform) => transformMatchesAgent(transform, args.agent));
  const skillMd = composeSkillMd(args.baseSkillMd, applied);
  return {
    validation: validateSkillInput(skillMd, args.resources),
    warnings: [],
    skillMd,
    applied
  };
}

export async function proposeSkillTransform(
  input: ProposeSkillTransformInput
): Promise<ProposeSkillTransformResult> {
  const parsed = parseTransformMd(input.transform_md);
  if (parsed.errors.length > 0) {
    return { outcome: "invalid", errors: parsed.errors, warnings: parsed.warnings };
  }

  const proposedBase = parsed.transform.base;
  const proposedName = parsed.transform.name;
  try {
    assertSafeSkillName(proposedBase);
    assertSafeSkillName(proposedName);
  } catch (error) {
    return { outcome: "invalid", errors: [String(error)], warnings: parsed.warnings };
  }

  const baseSkill = await readSkill(proposedBase);
  if (!baseSkill) {
    return {
      outcome: "invalid",
      errors: [`Base skill is not installed: ${proposedBase}`],
      warnings: parsed.warnings
    };
  }

  const existingDir = skillTransformDir(proposedBase, proposedName);
  const existingPresent = await fs.lstat(existingDir).then(() => true).catch(() => false);
  if (existingPresent && !input.replace) {
    return {
      outcome: "duplicate",
      base: proposedBase,
      name: proposedName,
      errors: [`Transform already exists: ${proposedBase}/${proposedName}`]
    };
  }

  const resources = await readResourceBundle(proposedBase);
  const { transforms: existingTransforms } = await readTransformsForBase(proposedBase);
  const now = new Date().toISOString();
  const transform: SkillTransform = {
    ...parsed.transform,
    transformMd: parsed.normalizedTransformMd,
    body: parsed.body,
    pinnedBaseSkillMd: baseSkill.skillMd,
    pinnedBaseHash: sha256(baseSkill.skillMd),
    pinnedBaseVersion: baseSkill.version,
    updatedAt: now
  };
  const candidateTransforms = candidateTransformList(existingTransforms, transform);

  const validationErrors: string[] = [];
  const validationWarnings = [...parsed.warnings];
  for (const agent of targetAgentsForValidation(transform, baseSkill.agents)) {
    const generated = composedValidationForAgent({
      baseSkillMd: baseSkill.skillMd,
      transforms: candidateTransforms,
      resources,
      agent
    });
    validationWarnings.push(...generated.validation.warnings);
    if (!generated.validation.valid) {
      validationErrors.push(
        `Generated skill for agent "${agent}" failed validation: ${[
          ...generated.validation.errors,
          ...generated.validation.securityFlags
        ].join("; ")}`
      );
    }
  }

  if (validationErrors.length > 0) {
    return { outcome: "invalid", errors: validationErrors, warnings: validationWarnings };
  }

  const metadata: TransformMetadata = {
    base: transform.base,
    name: transform.name,
    pinnedBaseHash: transform.pinnedBaseHash,
    pinnedBaseVersion: transform.pinnedBaseVersion,
    updatedAt: now
  };

  await withStorageLock(async () => {
    const dir = skillTransformDir(transform.base, transform.name);
    const tmpDir = `${dir}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      const metadataContent = JSON.stringify(metadata, null, 2);
      const files: Record<string, string> = Object.create(null);
      files[TRANSFORM_FILE] = transform.transformMd;
      files[BASE_SNAPSHOT_FILE] = transform.pinnedBaseSkillMd;
      files[TRANSFORM_METADATA_FILE] = metadataContent;
      const manifest = await signFiles(transformIdentity(transform.base, transform.name), files);
      await fs.writeFile(path.join(tmpDir, TRANSFORM_FILE), transform.transformMd, "utf-8");
      await fs.writeFile(path.join(tmpDir, BASE_SNAPSHOT_FILE), transform.pinnedBaseSkillMd, "utf-8");
      await fs.writeFile(path.join(tmpDir, TRANSFORM_METADATA_FILE), metadataContent, "utf-8");
      await fs.writeFile(
        path.join(tmpDir, TRANSFORM_MANIFEST_FILE),
        JSON.stringify(manifest, null, 2),
        { encoding: "utf-8", mode: 0o600 }
      );
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(tmpDir, dir);
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });

  return {
    outcome: "accepted",
    base: transform.base,
    name: transform.name,
    warnings: validationWarnings,
    pinned_base_hash: transform.pinnedBaseHash,
    pinned_base_version: transform.pinnedBaseVersion
  };
}

export async function listSkillTransforms(input: { base?: string } = {}): Promise<{
  transforms: SkillTransformSummary[];
}> {
  const bases = input.base ? [input.base] : await baseNamesWithTransforms();
  const summaries: SkillTransformSummary[] = [];
  for (const base of bases) {
    assertSafeSkillName(base);
    const { summaries: baseSummaries } = await readTransformsForBase(base);
    summaries.push(...baseSummaries);
  }
  return { transforms: summaries };
}

export async function removeSkillTransform(input: { base: string; name: string }): Promise<{
  removed: boolean;
  base: string;
  name: string;
}> {
  assertSafeSkillName(input.base);
  assertSafeSkillName(input.name);
  const dir = skillTransformDir(input.base, input.name);
  const existed = await fs.lstat(dir).then(() => true).catch(() => false);
  await fs.rm(dir, { recursive: true, force: true });
  return { removed: existed, base: input.base, name: input.name };
}

export async function renderSkillForAgent(
  name: string,
  agent: string
): Promise<RenderSkillForAgentResult> {
  assertSafeSkillName(name);
  validateAgentName(agent);
  const base = await readSkill(name);
  if (!base) throw new Error(`Skill not found: ${name}`);
  const resources = await readResourceBundle(name);
  const { transforms, summaries } = await readTransformsForBase(name);
  const warnings: string[] = [];
  for (const summary of summaries) {
    if (summary.status === "tampered") {
      warnings.push(
        `Skipping tampered transform "${summary.base}/${summary.name}": ${summary.error ?? "integrity check failed"}`
      );
    }
  }

  const applied = sortTransforms(transforms.filter((transform) => transformMatchesAgent(transform, agent)));
  for (const transform of applied) {
    const currentHash = sha256(base.skillMd);
    if (currentHash !== transform.pinnedBaseHash) {
      warnings.push(
        `Transform "${transform.base}/${transform.name}" was pinned to base hash ${transform.pinnedBaseHash} but current base hash is ${currentHash}; review the transform.`
      );
    }
  }

  const skillMd = composeSkillMd(base.skillMd, applied);
  const validation = validateSkillInput(skillMd, resources);
  if (!validation.valid) {
    throw new Error(
      `Generated transformed skill failed validation: ${[
        ...validation.errors,
        ...validation.securityFlags
      ].join("; ")}`
    );
  }

  return {
    name,
    agent,
    skill_md: skillMd,
    resources,
    applied_transforms: applied.map((transform) => ({
      name: transform.name,
      description: transform.description,
      priority: transform.priority,
      version: transform.version,
      pinned_base_hash: transform.pinnedBaseHash,
      pinned_base_version: transform.pinnedBaseVersion
    })),
    warnings: [...warnings, ...validation.warnings],
    validation
  };
}

async function writeRenderedDirectory(rendered: RenderSkillForAgentResult): Promise<string> {
  const target = renderDir(rendered.agent, rendered.name);
  const tmpDir = `${target}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const metadata = {
    base: rendered.name,
    agent: rendered.agent,
    renderedAt: new Date().toISOString(),
    transforms: rendered.applied_transforms
  };
  const metadataContent = JSON.stringify(metadata, null, 2);
  const binPaths = declaredBinPaths(rendered.skill_md);
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "SKILL.md"), rendered.skill_md, "utf-8");
    const files: Record<string, string> = Object.create(null);
    files["SKILL.md"] = rendered.skill_md;
    for (const resource of rendered.resources) {
      const canonical = validateResourcePathShape(resource.path);
      const targetPath = path.join(tmpDir, canonical);
      const mode = binPaths.has(canonical) ? 0o755 : 0o644;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, resource.content, { encoding: "utf-8", mode });
      await fs.chmod(targetPath, mode);
      files[canonical] = resource.content;
    }
    files[RENDER_METADATA_FILE] = metadataContent;
    const manifest = await signFiles(renderIdentity(rendered.agent, rendered.name), files);
    await fs.writeFile(path.join(tmpDir, RENDER_METADATA_FILE), metadataContent, "utf-8");
    await fs.writeFile(
      path.join(tmpDir, TRANSFORM_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
      { encoding: "utf-8", mode: 0o600 }
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(tmpDir, target);
    return target;
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function materializeRenderedSkillForAgent(
  name: string,
  agent: string
): Promise<MaterializedSkillRender> {
  assertSafeSkillName(name);
  validateAgentName(agent);
  const { transforms, summaries } = await readTransformsForBase(name);
  const matching = transforms.filter((transform) => transformMatchesAgent(transform, agent));
  if (matching.length === 0) {
    const base = await readSkill(name);
    if (!base) throw new Error(`Skill not found: ${name}`);
    return {
      name,
      agent,
      skill_md: base.skillMd,
      resources: [],
      applied_transforms: [],
      warnings: summaries
        .filter((summary) => summary.status === "tampered")
        .map(
          (summary) =>
            `Skipping tampered transform "${summary.base}/${summary.name}": ${summary.error ?? "integrity check failed"}`
        ),
      validation: {
        valid: true,
        repaired: false,
        errors: [],
        warnings: [],
        securityFlags: []
      },
      path: skillDir(name)
    };
  }
  const rendered = await renderSkillForAgent(name, agent);
  const target = await writeRenderedDirectory(rendered);
  return { ...rendered, path: target };
}

export async function clearRenderedSkills(): Promise<void> {
  await fs.rm(renderedRoot(), { recursive: true, force: true });
}

export async function listTransformReviews(base?: string): Promise<TransformReview[]> {
  const bases = base ? [base] : await baseNamesWithTransforms();
  const reviews: TransformReview[] = [];
  for (const baseName of bases) {
    assertSafeSkillName(baseName);
    const current = await readSkill(baseName);
    if (!current) continue;
    const currentHash = sha256(current.skillMd);
    const currentVersion = current.version;
    const { transforms } = await readTransformsForBase(baseName);
    for (const transform of transforms) {
      if (transform.pinnedBaseHash === currentHash) continue;
      reviews.push({
        base: baseName,
        transform: transform.name,
        reason: "base_skill_changed",
        pinned_base_hash: transform.pinnedBaseHash,
        current_base_hash: currentHash,
        pinned_base_version: transform.pinnedBaseVersion,
        current_base_version: currentVersion,
        pinned_skill_md: transform.pinnedBaseSkillMd
      });
    }
  }
  return reviews;
}
