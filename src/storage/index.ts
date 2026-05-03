import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { parseFrontmatter } from "../validation/frontmatter.js";
import type { SkillRecord, SkillSummary } from "../types.js";
import { signContent, verifyContent } from "../util/sign.js";
import { log } from "../util/log.js";

const SOURCE_FILE = ".autovault-source.json";
const SIGNATURE_FILE = ".autovault-signature";

export type SkillSource = {
  source: "github" | "agentskills" | "url" | "inline";
  identifier: string;
  bundledSkillName?: string;
  version?: string;
  upstreamSha?: string;
  fetchedAt: string;
  contentHash: string;
};

function skillsDir(): string {
  return path.join(loadConfig().storagePath, "skills");
}

export function skillDir(name: string): string {
  return path.join(skillsDir(), name);
}

export async function ensureStorage(): Promise<void> {
  await fs.mkdir(skillsDir(), { recursive: true });
}

export async function listInstalledSkillNames(): Promise<string[]> {
  await ensureStorage();
  const entries = await fs.readdir(skillsDir(), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      const stat = await fs.stat(path.join(skillsDir(), entry.name));
      if (stat.isDirectory()) names.push(entry.name);
    } catch {
      // Ignore broken symlinks; profile sync can clean those up.
    }
  }
  return names;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asSecretsArray(
  value: unknown
): Array<{ name: string; description?: string; required?: boolean }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      name: String(item.name ?? ""),
      description: typeof item.description === "string" ? item.description : undefined,
      required: typeof item.required === "boolean" ? item.required : undefined
    }))
    .filter((entry) => entry.name.length > 0);
}

function asResourcesArray(value: unknown): Array<{ path: string; type: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      path: String(item.path ?? ""),
      type: typeof item.type === "string" ? item.type : "file"
    }))
    .filter((entry) => entry.path.length > 0);
}

function asCapabilities(value: unknown): SkillRecord["capabilities"] {
  const fallback: SkillRecord["capabilities"] = {
    network: false,
    filesystem: "readonly",
    tools: []
  };
  if (typeof value !== "object" || value === null) return fallback;
  const cap = value as Record<string, unknown>;
  return {
    network: typeof cap.network === "boolean" ? cap.network : fallback.network,
    filesystem: cap.filesystem === "readwrite" ? "readwrite" : "readonly",
    tools: asStringArray(cap.tools)
  };
}

function buildSummary(name: string, frontmatter: Record<string, unknown>): SkillSummary {
  const metadata = (frontmatter.metadata ?? {}) as Record<string, unknown>;
  return {
    name: asString(frontmatter.name, name),
    description: asString(frontmatter.description, ""),
    version: asString(metadata.version, "0.0.0"),
    tags: asStringArray(frontmatter.tags),
    category: typeof frontmatter.category === "string" ? frontmatter.category : undefined,
    agents: asStringArray(frontmatter.agents)
  };
}

export async function readSkill(name: string): Promise<SkillRecord | null> {
  const skillPath = path.join(skillDir(name), "SKILL.md");
  try {
    const skillMd = await fs.readFile(skillPath, "utf-8");
    await verifySignatureIfPresent(name, skillMd);
    const { data } = parseFrontmatter(skillMd);
    const summary = buildSummary(name, data);
    return {
      ...summary,
      skillMd,
      resources: asResourcesArray(data.resources),
      capabilities: asCapabilities(data.capabilities),
      requiresSecrets: asSecretsArray(data["requires-secrets"])
    };
  } catch {
    return null;
  }
}

async function verifySignatureIfPresent(name: string, skillMd: string): Promise<void> {
  const signaturePath = path.join(skillDir(name), SIGNATURE_FILE);
  let signature: string;
  try {
    signature = (await fs.readFile(signaturePath, "utf-8")).trim();
  } catch {
    return;
  }
  const ok = await verifyContent(skillMd, signature);
  if (!ok) {
    log.warn("storage.signature_mismatch", { name });
  }
}

export async function readSkillSummary(name: string): Promise<SkillSummary | null> {
  const record = await readSkill(name);
  if (!record) return null;
  return {
    name: record.name,
    description: record.description,
    version: record.version,
    tags: record.tags,
    category: record.category,
    agents: record.agents
  };
}

export async function writeSkill(name: string, skillMd: string): Promise<void> {
  const dir = skillDir(name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMd, "utf-8");
  try {
    const signature = await signContent(skillMd);
    await fs.writeFile(path.join(dir, SIGNATURE_FILE), signature, { encoding: "utf-8", mode: 0o600 });
  } catch (error) {
    log.warn("storage.sign_failed", { name, error: String(error) });
  }
}

function isAbsoluteLikePath(input: string): boolean {
  return path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith("\\\\");
}

function hasTraversalSegment(input: string): boolean {
  return input.split(/[\\/]+/).some((segment) => segment === "..");
}

function realpathIfExists(inputPath: string): string | null {
  try {
    return fsSync.realpathSync.native(inputPath);
  } catch {
    return null;
  }
}

function isWithinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

export function validateResourcePath(name: string, resourcePath: string): string {
  if (typeof resourcePath !== "string" || resourcePath.length === 0) {
    throw new Error(`Invalid resource path: ${resourcePath}`);
  }
  if (isAbsoluteLikePath(resourcePath) || hasTraversalSegment(resourcePath)) {
    throw new Error(`Invalid resource path: ${resourcePath}`);
  }
  const root = path.resolve(skillDir(name));
  const target = path.resolve(root, resourcePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Resource escapes skill directory: ${resourcePath}`);
  }

  const realRoot = realpathIfExists(root) ?? root;
  const realTarget = realpathIfExists(target);
  if (realTarget && !isWithinRoot(realTarget, realRoot)) {
    throw new Error(`Resource escapes skill directory: ${resourcePath}`);
  }
  return realTarget ?? target;
}

export async function writeSkillResources(
  name: string,
  resources: Array<{ path: string; content: string }>
): Promise<void> {
  if (resources.length === 0) return;
  const targets = resources.map((resource) => ({
    target: validateResourcePath(name, resource.path),
    content: resource.content
  }));
  for (const { target, content } of targets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  }
}

export async function writeSkillSource(name: string, source: SkillSource): Promise<void> {
  const target = path.join(skillDir(name), SOURCE_FILE);
  await fs.writeFile(target, JSON.stringify(source, null, 2), "utf-8");
}

export async function readSkillSource(name: string): Promise<SkillSource | null> {
  try {
    const raw = await fs.readFile(path.join(skillDir(name), SOURCE_FILE), "utf-8");
    return JSON.parse(raw) as SkillSource;
  } catch {
    return null;
  }
}
