import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { syncProfiles, type SyncProfilesResult } from "../profiles/sync.js";
import {
  skillDir,
  validateResourcePathShape,
  writeSkill,
  type SkillSource,
  type WrittenResource
} from "../storage/index.js";
import { bundleHash } from "../util/hash.js";
import { checkBundleLimits } from "../util/limits.js";
import { canonicalRelPath } from "../util/path.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
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
  source: string;
  syncProfiles?: boolean;
  profileRoots?: Record<string, string>;
  discoverProfileRoots?: boolean;
};

export type AddLocalSkillResult = {
  success: boolean;
  name: string;
  validation: ReturnType<typeof validateSkillInput>;
  warnings: string[];
  source?: SkillSource;
  paths?: {
    skill: string;
    storage: string;
  };
  sync?: SyncProfilesResult;
};

function shouldSkipEntry(name: string): boolean {
  return name.startsWith(".autovault-");
}

export async function collectLocalSkillBundle(skillDirInput: string): Promise<LocalSkillBundle> {
  const root = path.resolve(skillDirInput);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to install local bundle through a symlink directory: ${skillDirInput}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Local skill path is not a directory: ${skillDirInput}`);
  }

  const skillMdPath = path.join(root, "SKILL.md");
  const skillMdStat = await fs.lstat(skillMdPath);
  if (!skillMdStat.isFile()) {
    throw new Error(`Local skill directory must contain a regular SKILL.md: ${skillMdPath}`);
  }

  const skillMd = await fs.readFile(skillMdPath, "utf-8");
  const resources: LocalSkillResource[] = [];

  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (shouldSkipEntry(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to install local bundle with symlink resource: ${rel}`);
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
      resources.push({
        path: canonical,
        content: await fs.readFile(absolute, "utf-8")
      });
    }
  }

  await walk(root, "");

  const seen = new Set<string>();
  for (const resource of resources) {
    const canonical = canonicalRelPath(resource.path);
    if (seen.has(canonical)) {
      throw new Error(`Duplicate local resource path after normalization: ${resource.path}`);
    }
    seen.add(canonical);
  }

  return { root, skillMd, resources };
}

export async function addLocalSkill(input: AddLocalSkillInput): Promise<AddLocalSkillResult> {
  const bundle = await collectLocalSkillBundle(input.skillDir);

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
      warnings: []
    };
  }

  const { output: normalizedSkillMd } = attemptRepair(bundle.skillMd);
  const validation = validateSkillInput(bundle.skillMd, bundle.resources);
  if (!validation.valid) {
    return {
      success: false,
      name: "",
      validation,
      warnings: []
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
    identifier: input.source,
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
    paths: {
      skill: skillDir(name),
      storage: config.storagePath
    },
    sync
  };
}
