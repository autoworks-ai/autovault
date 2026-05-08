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
import {
  MAX_RESOURCE_BYTES,
  MAX_RESOURCES,
  MAX_SKILL_MD_BYTES,
  MAX_TOTAL_BYTES,
  checkBundleLimits
} from "../util/limits.js";
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

const OS_METADATA_ENTRIES = new Set([".DS_Store", "Thumbs.db"]);

function shouldSkipEntry(name: string): boolean {
  return name.startsWith(".autovault-") || OS_METADATA_ENTRIES.has(name);
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

export async function collectLocalSkillBundle(
  skillDirInput: string,
  options: { followRootSymlink?: boolean } = {}
): Promise<LocalSkillBundle> {
  let root = path.resolve(skillDirInput);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    if (!options.followRootSymlink) {
      throw new Error(
        await formatSymlinkRejection(
          "Refusing to install local bundle through a symlink directory",
          skillDirInput,
          root,
          ". Use the canonical target path instead."
        )
      );
    }
    root = await fs.realpath(root);
  }
  const resolvedRootStat = rootStat.isSymbolicLink() ? await fs.stat(root) : rootStat;
  if (!resolvedRootStat.isDirectory()) {
    throw new Error(`Local skill path is not a directory: ${skillDirInput}`);
  }

  const skillMdPath = path.join(root, "SKILL.md");
  const skillMdStat = await fs.lstat(skillMdPath);
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
