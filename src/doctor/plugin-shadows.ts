import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_SKILL_MD_BYTES } from "../util/limits.js";
import { parseFrontmatter } from "../validation/frontmatter.js";

export type PluginShadowHost = "claude-code" | "cursor";

export type PluginShadow = {
  category: "plugin-shadowed";
  evidence: "cached_collision";
  advisory: true;
  host: PluginShadowHost;
  plugin: string;
  skill_md_path: string;
};

type PluginRoot = {
  host: PluginShadowHost;
  root: string;
};

export type ScanPluginShadowsInput = {
  home?: string;
  roots?: PluginRoot[];
  limits?: Partial<PluginShadowScanLimits>;
};

export type PluginShadowScanLimits = {
  maxDepth: number;
  maxSkillFiles: number;
  maxSkillBytes: number;
};

export type PluginShadowScan = {
  shadows: Record<string, PluginShadow[]>;
  scanned_skill_files: number;
  incomplete: boolean;
  truncation_reasons: PluginShadowScanTruncationReason[];
};

export type PluginShadowScanTruncationReason =
  | "depth_limit"
  | "skill_file_limit"
  | "skill_file_size_limit"
  | "directory_read_error"
  | "skill_file_read_error";

export const DEFAULT_PLUGIN_SHADOW_SCAN_LIMITS: PluginShadowScanLimits = {
  maxDepth: 16,
  maxSkillFiles: 2_000,
  maxSkillBytes: MAX_SKILL_MD_BYTES
};

type ScanState = {
  limits: PluginShadowScanLimits;
  files: string[];
  truncationReasons: Set<PluginShadowScanTruncationReason>;
  fileLimitReached: boolean;
};

function defaultPluginRoots(home: string): PluginRoot[] {
  return [
    { host: "cursor", root: path.join(home, ".cursor", "plugins", "cache") },
    { host: "claude-code", root: path.join(home, ".claude", "plugins") }
  ];
}

function resolveLimits(limits: Partial<PluginShadowScanLimits> | undefined): PluginShadowScanLimits {
  const numericLimit = (value: number | undefined, fallback: number, minimum: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(minimum, Math.floor(value));
  };
  return {
    maxDepth: numericLimit(limits?.maxDepth, DEFAULT_PLUGIN_SHADOW_SCAN_LIMITS.maxDepth, 0),
    maxSkillFiles: numericLimit(limits?.maxSkillFiles, DEFAULT_PLUGIN_SHADOW_SCAN_LIMITS.maxSkillFiles, 1),
    maxSkillBytes: numericLimit(limits?.maxSkillBytes, DEFAULT_PLUGIN_SHADOW_SCAN_LIMITS.maxSkillBytes, 1)
  };
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function findSkillFiles(root: string, state: ScanState, depth = 0): Promise<void> {
  if (state.fileLimitReached) return;
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if (!isMissingPathError(error)) state.truncationReasons.add("directory_read_error");
    return;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    state.truncationReasons.add("directory_read_error");
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.fileLimitReached) return;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth >= state.limits.maxDepth) {
        state.truncationReasons.add("depth_limit");
        continue;
      }
      await findSkillFiles(entryPath, state, depth + 1);
      continue;
    }
    if (!entry.isFile() || entry.name !== "SKILL.md") continue;
    if (state.files.length >= state.limits.maxSkillFiles) {
      state.fileLimitReached = true;
      state.truncationReasons.add("skill_file_limit");
      return;
    }
    try {
      const stat = await fs.stat(entryPath);
      if (stat.size > state.limits.maxSkillBytes) {
        state.truncationReasons.add("skill_file_size_limit");
        continue;
      }
    } catch {
      state.truncationReasons.add("skill_file_read_error");
      continue;
    }
    state.files.push(entryPath);
  }
}

function pluginIdentifier(root: string, skillPath: string): string {
  const relativeParts = path.relative(root, skillPath).split(path.sep);
  const skillsIndex = relativeParts.lastIndexOf("skills");
  const pluginParts =
    skillsIndex > 0 ? relativeParts.slice(0, skillsIndex) : relativeParts.slice(0, -2);
  return pluginParts.join("/") || "(unknown plugin)";
}

async function frontmatterName(skillPath: string, state: ScanState): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(skillPath, "utf-8");
  } catch {
    state.truncationReasons.add("skill_file_read_error");
    return undefined;
  }
  try {
    const { data } = parseFrontmatter(raw);
    return typeof data.name === "string" && data.name.length > 0 ? data.name : undefined;
  } catch {
    return undefined;
  }
}

export async function scanPluginShadows(
  installedNames: Iterable<string>,
  input: ScanPluginShadowsInput = {}
): Promise<PluginShadowScan> {
  const installed = new Set(installedNames);
  if (installed.size === 0) {
    return { shadows: {}, scanned_skill_files: 0, incomplete: false, truncation_reasons: [] };
  }

  const roots = input.roots ?? defaultPluginRoots(input.home ?? os.homedir());
  const state: ScanState = {
    limits: resolveLimits(input.limits),
    files: [],
    truncationReasons: new Set(),
    fileLimitReached: false
  };
  for (const pluginRoot of roots) {
    await findSkillFiles(pluginRoot.root, state);
  }

  const shadows = Object.create(null) as Record<string, PluginShadow[]>;
  for (const skillPath of state.files) {
    const pluginRoot = roots.find(
      (root) => skillPath === root.root || skillPath.startsWith(`${root.root}${path.sep}`)
    );
    if (!pluginRoot) continue;
    const name = await frontmatterName(skillPath, state);
    if (!name || !installed.has(name)) continue;
    const entries = shadows[name] ?? [];
    entries.push({
      category: "plugin-shadowed",
      evidence: "cached_collision",
      advisory: true,
      host: pluginRoot.host,
      plugin: pluginIdentifier(pluginRoot.root, skillPath),
      skill_md_path: skillPath
    });
    shadows[name] = entries;
  }

  for (const entries of Object.values(shadows)) {
    entries.sort(
      (left, right) =>
        left.host.localeCompare(right.host) ||
        left.plugin.localeCompare(right.plugin) ||
        left.skill_md_path.localeCompare(right.skill_md_path)
    );
  }
  return {
    shadows,
    scanned_skill_files: state.files.length,
    incomplete: state.truncationReasons.size > 0,
    truncation_reasons: [...state.truncationReasons].sort()
  };
}
