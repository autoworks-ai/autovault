import fs from "node:fs/promises";
import path from "node:path";
import parseSpdxExpression from "spdx-expression-parse";
import { z } from "zod";
import { declaredBinPaths, readVerifiedInstalledSkillBundle } from "../storage/index.js";
import { bundleHash } from "../util/hash.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { parseFrontmatter } from "../validation/frontmatter.js";

const REGISTRY_PATH = path.join("catalog", "autovault-publication.json");
const RECEIPT_PATH = path.join("catalog", "autovault-sync.json");

const registryEntrySchema = z.object({
  visibility: z.enum(["public", "hidden"]),
  replacement: z.string().min(1).optional()
});

const registrySchema = z.object({
  schemaVersion: z.literal(1),
  target: z.string().min(1),
  skills: z.record(z.string(), registryEntrySchema)
});

export type PublishRegistryEntry = z.infer<typeof registryEntrySchema>;
export type PublishRegistry = z.infer<typeof registrySchema>;

export type PublishBlockReason =
  | "not_installed"
  | "integrity_failed"
  | "license_missing"
  | "license_not_redistributable"
  | "version_missing"
  | "story_missing";

export type PublishStatusEntry = {
  name: string;
  version?: string;
  replacement?: string;
  reasons?: PublishBlockReason[];
};

export type PublishTargetStatus = {
  targetRoot: string;
  registry: PublishRegistry;
  eligible: PublishStatusEntry[];
  hidden: PublishStatusEntry[];
  blocked: Array<PublishStatusEntry & { reasons: PublishBlockReason[] }>;
};

type PublishBundle = {
  name: string;
  version: string;
  contentHash: string;
  files: Array<{ path: string; content: string; mode?: number }>;
};

export type PublishSyncPlan = PublishTargetStatus & {
  copy: PublishBundle[];
  remove: string[];
};

export type PublishSyncResult = {
  applied: true;
  copied: string[];
  removed: string[];
  receiptPath: string;
};

async function pathIsDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function resolveTargetRoot(input: string): string {
  return path.resolve(input);
}

function targetPath(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Publication target path escapes repository: ${relative}`);
  }
  return resolved;
}

async function assertOwnedTargetPath(
  root: string,
  relative: string,
  expected: "file" | "directory",
  options: { allowMissing?: boolean } = {}
): Promise<string> {
  const target = targetPath(root, relative);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      if (options.allowMissing && index === parts.length - 1) return target;
      throw new Error(`Publication target path is missing: ${relative}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Publication target path must not be a symlink: ${relative}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Publication target ancestor is not a directory: ${relative}`);
    }
    if (index === parts.length - 1) {
      if (expected === "file" && !stat.isFile()) {
        throw new Error(`Publication target path is not a file: ${relative}`);
      }
      if (expected === "directory" && !stat.isDirectory()) {
        throw new Error(`Publication target path is not a directory: ${relative}`);
      }
      const real = await fs.realpath(current);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Publication target path escapes repository: ${relative}`);
      }
    }
  }
  return target;
}

async function resolvePublicationTarget(input: string): Promise<string> {
  const requested = resolveTargetRoot(input);
  const stat = await fs.lstat(requested);
  if (!stat.isDirectory()) throw new Error(`Publication target is not a directory: ${requested}`);
  return fs.realpath(requested);
}

async function readRegistry(targetRoot: string): Promise<PublishRegistry> {
  const registryPath = await assertOwnedTargetPath(targetRoot, REGISTRY_PATH, "file");
  let raw: string;
  try {
    raw = await fs.readFile(registryPath, "utf-8");
  } catch {
    throw new Error(`Publication registry not found: ${registryPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Publication registry is not valid JSON: ${String(error)}`);
  }
  const result = registrySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Publication registry is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  for (const [name, entry] of Object.entries(result.data.skills)) {
    assertSafeSkillName(name);
    if (entry.replacement) assertSafeSkillName(entry.replacement);
  }
  return result.data;
}

function isRedistributableLicense(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const expression = parseSpdxExpression(value.trim());
    return !containsCustomLicenseReference(expression);
  } catch {
    return false;
  }
}

function containsCustomLicenseReference(
  expression: ReturnType<typeof parseSpdxExpression>
): boolean {
  if (expression.license?.includes("LicenseRef-")) return true;
  return Boolean(
    (expression.left && containsCustomLicenseReference(expression.left)) ||
      (expression.right && containsCustomLicenseReference(expression.right))
  );
}

async function inspectPublicSkill(
  targetRoot: string,
  name: string
): Promise<
  | { entry: PublishStatusEntry; bundle: PublishBundle }
  | { entry: PublishStatusEntry & { reasons: PublishBlockReason[] } }
> {
  const verified = await readVerifiedInstalledSkillBundle(name);
  if (verified.kind === "not_installed") return { entry: { name, reasons: ["not_installed"] } };
  if (verified.kind !== "ok") {
    return { entry: { name, reasons: ["integrity_failed"] } };
  }
  const { skill, resources: verifiedResources } = verified;
  const { data } = parseFrontmatter(skill.skillMd);
  if (typeof data.license !== "string" || data.license.trim().length === 0) {
    return { entry: { name, version: skill.version, reasons: ["license_missing"] } };
  }
  if (!isRedistributableLicense(data.license)) {
    return {
      entry: { name, version: skill.version, reasons: ["license_not_redistributable"] }
    };
  }
  const version = skill.version.trim();
  if (!version || version === "0.0.0") {
    return { entry: { name, reasons: ["version_missing"] } };
  }

  if (verifiedResources.some((resource) => resource.path.split("/")[0]?.toLowerCase() === "story.md")) {
    return { entry: { name, version, reasons: ["integrity_failed"] } };
  }

  try {
    await assertOwnedTargetPath(targetRoot, path.join("skills", name, "story.md"), "file");
  } catch (error) {
    if (error instanceof Error && error.message.includes("is missing")) {
      return { entry: { name, version, reasons: ["story_missing"] } };
    }
    throw error;
  }
  const skillMd = skill.skillMd;
  const binPaths = declaredBinPaths(skill.bin);
  const resources = verifiedResources.map((resource) => ({
    ...resource,
    mode: binPaths.has(resource.path) ? 0o755 : 0o644
  }));
  const files = [{ path: "SKILL.md", content: skillMd }, ...resources];
  return {
    entry: { name, version },
    bundle: {
      name,
      version,
      contentHash: bundleHash(skillMd, resources),
      files
    }
  };
}

export async function inspectPublishTarget(targetInput: string): Promise<PublishTargetStatus> {
  const targetRoot = await resolvePublicationTarget(targetInput);
  const registry = await readRegistry(targetRoot);
  const eligible: PublishStatusEntry[] = [];
  const hidden: PublishStatusEntry[] = [];
  const blocked: Array<PublishStatusEntry & { reasons: PublishBlockReason[] }> = [];

  for (const name of Object.keys(registry.skills).sort((a, b) => a.localeCompare(b))) {
    const config = registry.skills[name];
    if (config.visibility === "hidden") {
      hidden.push({ name, replacement: config.replacement });
      continue;
    }
    const inspection = await inspectPublicSkill(targetRoot, name);
    if ("bundle" in inspection) eligible.push(inspection.entry);
    else blocked.push(inspection.entry);
  }

  return { targetRoot, registry, eligible, hidden, blocked };
}

async function listCurrentSkillDirs(targetRoot: string): Promise<string[]> {
  const skillsRoot = targetPath(targetRoot, "skills");
  try {
    await assertOwnedTargetPath(targetRoot, "skills", "directory");
  } catch (error) {
    if (error instanceof Error && error.message.includes("is missing")) return [];
    throw error;
  }
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error("Publication target skills directory must not contain symlinks");
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function planPublishSync(targetInput: string): Promise<PublishSyncPlan> {
  const targetRoot = await resolvePublicationTarget(targetInput);
  const registry = await readRegistry(targetRoot);
  const eligible: PublishStatusEntry[] = [];
  const hidden: PublishStatusEntry[] = [];
  const blocked: Array<PublishStatusEntry & { reasons: PublishBlockReason[] }> = [];
  const copy: PublishBundle[] = [];

  for (const name of Object.keys(registry.skills).sort((a, b) => a.localeCompare(b))) {
    const config = registry.skills[name];
    if (config.visibility === "hidden") {
      hidden.push({ name, replacement: config.replacement });
      continue;
    }
    const inspection = await inspectPublicSkill(targetRoot, name);
    if ("bundle" in inspection) {
      eligible.push(inspection.entry);
      copy.push(inspection.bundle);
    } else {
      blocked.push(inspection.entry);
    }
  }

  const publicNames = new Set(
    Object.entries(registry.skills)
      .filter(([, config]) => config.visibility === "public")
      .map(([name]) => name)
  );
  const folded = new Map<string, string>();
  for (const name of publicNames) {
    const key = name.toLocaleLowerCase("en-US");
    const existing = folded.get(key);
    if (existing && existing !== name) throw new Error(`Publication registry has a case collision: ${existing}, ${name}`);
    folded.set(key, name);
  }
  const current = await listCurrentSkillDirs(targetRoot);
  for (const name of current) {
    const canonical = folded.get(name.toLocaleLowerCase("en-US"));
    if (canonical && canonical !== name) {
      throw new Error(`Publication target has a case collision: ${name}, ${canonical}`);
    }
  }
  const remove = current.filter((name) => !publicNames.has(name));
  return { targetRoot, registry, eligible, hidden, blocked, copy, remove };
}

async function stageBundle(
  stagingRoot: string,
  targetRoot: string,
  bundle: PublishBundle
): Promise<string> {
  const stagedDir = path.join(stagingRoot, bundle.name);
  await fs.mkdir(stagedDir, { recursive: true });
  for (const file of bundle.files) {
    const outputPath = path.join(stagedDir, file.path);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, file.content, { encoding: "utf-8", mode: file.mode });
    if (file.mode !== undefined) await fs.chmod(outputPath, file.mode);
  }
  const storyPath = await assertOwnedTargetPath(
    targetRoot,
    path.join("skills", bundle.name, "story.md"),
    "file"
  );
  const story = await fs.readFile(storyPath, "utf-8");
  await fs.writeFile(path.join(stagedDir, "story.md"), story, "utf-8");
  return stagedDir;
}

export async function applyPublishSync(plan: PublishSyncPlan): Promise<PublishSyncResult> {
  if (plan.blocked.length > 0) {
    const names = plan.blocked.map((entry) => entry.name).join(", ");
    throw new Error(`Publication sync is blocked by ineligible skills: ${names}`);
  }

  const skillsRoot = targetPath(plan.targetRoot, "skills");
  await fs.mkdir(skillsRoot, { recursive: true });
  await assertOwnedTargetPath(plan.targetRoot, "skills", "directory");
  await assertOwnedTargetPath(plan.targetRoot, "catalog", "directory");
  for (const bundle of plan.copy) {
    await assertOwnedTargetPath(plan.targetRoot, path.join("skills", bundle.name), "directory", {
      allowMissing: true
    });
  }
  for (const name of plan.remove) {
    await assertOwnedTargetPath(plan.targetRoot, path.join("skills", name), "directory");
  }
  const receiptPath = await assertOwnedTargetPath(
    plan.targetRoot,
    RECEIPT_PATH,
    "file",
    { allowMissing: true }
  );
  const stagingRoot = path.join(
    plan.targetRoot,
    `.autovault-publish.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(stagingRoot, { recursive: true });
  const bundlesRoot = path.join(stagingRoot, "bundles");
  const backupsRoot = path.join(stagingRoot, "backups");
  let preserveStaging = false;
  const rollback: Array<{ target: string; backup?: string }> = [];
  try {
    for (const bundle of plan.copy) {
      await stageBundle(bundlesRoot, plan.targetRoot, bundle);
    }
    const receipt = {
      schemaVersion: 1,
      target: plan.registry.target,
      skills: plan.copy.map((bundle) => ({
        name: bundle.name,
        version: bundle.version,
        contentHash: bundle.contentHash
      }))
    };
    const stagedReceipt = path.join(stagingRoot, "receipt.json");
    await fs.writeFile(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");

    for (const bundle of plan.copy) {
      const targetDir = path.join(skillsRoot, bundle.name);
      const backupDir = path.join(backupsRoot, "replaced", bundle.name);
      if (await pathIsDirectory(targetDir)) {
        await fs.mkdir(path.dirname(backupDir), { recursive: true });
        await fs.rename(targetDir, backupDir);
        rollback.push({ target: targetDir, backup: backupDir });
      } else {
        rollback.push({ target: targetDir });
      }
      await fs.rename(path.join(bundlesRoot, bundle.name), targetDir);
    }
    for (const name of plan.remove) {
      const targetDir = path.join(skillsRoot, name);
      const backupDir = path.join(backupsRoot, "removed", name);
      await fs.mkdir(path.dirname(backupDir), { recursive: true });
      await fs.rename(targetDir, backupDir);
      rollback.push({ target: targetDir, backup: backupDir });
    }
    const receiptBackup = path.join(backupsRoot, "receipt.json");
    if (await pathExists(receiptPath)) {
      await fs.mkdir(path.dirname(receiptBackup), { recursive: true });
      await fs.rename(receiptPath, receiptBackup);
      rollback.push({ target: receiptPath, backup: receiptBackup });
    } else {
      rollback.push({ target: receiptPath });
    }
    await fs.rename(stagedReceipt, receiptPath);
    return {
      applied: true,
      copied: plan.copy.map((bundle) => bundle.name),
      removed: [...plan.remove],
      receiptPath
    };
  } catch (error) {
    for (const mutation of rollback.reverse()) {
      try {
        await fs.rm(mutation.target, { recursive: true, force: true });
        if (mutation.backup) await fs.rename(mutation.backup, mutation.target);
      } catch {
        preserveStaging = true;
      }
    }
    throw error;
  } finally {
    if (!preserveStaging) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
