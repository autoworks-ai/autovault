import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_SKILL_MD_BYTES } from "../util/limits.js";
import { parseFrontmatter } from "../validation/frontmatter.js";

export type PluginShadowHost = "claude-code" | "cursor";

export type PluginShadow = {
  category: "plugin-shadowed";
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
};

function defaultPluginRoots(home: string): PluginRoot[] {
  return [
    {
      host: "cursor",
      root: path.join(home, ".cursor", "plugins", "cache")
    },
    {
      host: "claude-code",
      root: path.join(home, ".claude", "plugins")
    }
  ];
}

async function findSkillFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findSkillFiles(entryPath));
      continue;
    }
    // Plugin caches are untrusted host state. Ignore symlinks so a cache entry
    // cannot make doctor escape the known roots or recurse through a loop.
    if (entry.isFile() && entry.name === "SKILL.md") files.push(entryPath);
  }
  return files;
}

function pluginIdentifier(root: string, skillPath: string): string {
  const relativeParts = path.relative(root, skillPath).split(path.sep);
  const skillsIndex = relativeParts.lastIndexOf("skills");
  const pluginParts =
    skillsIndex > 0 ? relativeParts.slice(0, skillsIndex) : relativeParts.slice(0, -2);
  return pluginParts.join("/") || "(unknown plugin)";
}

async function frontmatterName(skillPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(skillPath);
    if (stat.size > MAX_SKILL_MD_BYTES) return undefined;
    const raw = await fs.readFile(skillPath, "utf-8");
    const { data } = parseFrontmatter(raw);
    return typeof data.name === "string" && data.name.length > 0 ? data.name : undefined;
  } catch {
    // A malformed or unreadable third-party cache entry is not a vault-health
    // failure and cannot be matched reliably, so leave it out of the report.
    return undefined;
  }
}

export async function scanPluginShadows(
  installedNames: Iterable<string>,
  input: ScanPluginShadowsInput = {}
): Promise<Record<string, PluginShadow[]>> {
  const installed = new Set(installedNames);
  if (installed.size === 0) return {};

  const roots = input.roots ?? defaultPluginRoots(input.home ?? os.homedir());
  // Skill names may legally be Object.prototype keys (for example
  // "constructor"). Keep the grouping map prototype-free so those names
  // cannot be mistaken for inherited properties.
  const shadows: Record<string, PluginShadow[]> = Object.create(null) as Record<
    string,
    PluginShadow[]
  >;
  for (const pluginRoot of roots) {
    for (const skillPath of await findSkillFiles(pluginRoot.root)) {
      const name = await frontmatterName(skillPath);
      if (!name || !installed.has(name)) continue;
      const entries = shadows[name] ?? [];
      entries.push({
        category: "plugin-shadowed",
        host: pluginRoot.host,
        plugin: pluginIdentifier(pluginRoot.root, skillPath),
        skill_md_path: skillPath
      });
      shadows[name] = entries;
    }
  }

  for (const entries of Object.values(shadows)) {
    entries.sort((left, right) => {
      return (
        left.host.localeCompare(right.host) ||
        left.plugin.localeCompare(right.plugin) ||
        left.skill_md_path.localeCompare(right.skill_md_path)
      );
    });
  }
  return shadows;
}
