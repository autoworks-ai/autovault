import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../config.js";
import { listInstalledSkillNames, readSkill, skillDir } from "../storage/index.js";
import { log } from "../util/log.js";

export type SyncProfilesInput = {
  profileRoots?: Record<string, string>;
};

export type SyncProfilesResult = {
  profiles: Record<string, string[]>;
  linkedRoots: Record<string, string>;
  warnings: string[];
};

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function removeManagedLinks(root: string, managedPrefix: string, keep: Set<string>): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || keep.has(entry.name)) continue;
    const target = path.join(root, entry.name);
    try {
      const link = await fs.readlink(target);
      const resolved = path.resolve(root, link);
      if (resolved === managedPrefix || resolved.startsWith(managedPrefix + path.sep)) {
        await fs.unlink(target);
      }
    } catch {
      // Ignore links that disappear mid-sync.
    }
  }
}

async function replaceSymlink(linkPath: string, targetPath: string): Promise<void> {
  try {
    const current = await fs.readlink(linkPath);
    if (path.resolve(path.dirname(linkPath), current) === targetPath) return;
    await fs.unlink(linkPath);
  } catch (error) {
    if (await pathExists(linkPath)) {
      throw new Error(`Refusing to replace non-symlink path: ${linkPath}`);
    }
  }
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(targetPath, linkPath, symlinkType);
}

async function existingDirectoryNames(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function syncProfiles(input: SyncProfilesInput = {}): Promise<SyncProfilesResult> {
  const config = loadConfig();
  const profileRoot = path.join(config.storagePath, "profiles");
  await fs.mkdir(profileRoot, { recursive: true });

  const profiles = new Map<string, string[]>();
  const warnings: string[] = [];

  for (const name of await listInstalledSkillNames()) {
    const record = await readSkill(name);
    if (!record) continue;
    if (record.agents.length === 0) {
      warnings.push(`Skill "${name}" has no agents frontmatter and is hidden from generated profiles.`);
      continue;
    }
    for (const agent of record.agents) {
      const list = profiles.get(agent) ?? [];
      list.push(name);
      profiles.set(agent, list);
    }
  }

  const resultProfiles: Record<string, string[]> = {};
  const agents = new Set([...await existingDirectoryNames(profileRoot), ...profiles.keys()]);
  for (const agent of agents) {
    const names = profiles.get(agent) ?? [];
    const agentRoot = path.join(profileRoot, agent);
    const keep = new Set(names);
    await removeManagedLinks(agentRoot, path.resolve(config.storagePath, "skills"), keep);
    for (const name of names.sort()) {
      await replaceSymlink(path.join(agentRoot, name), path.resolve(skillDir(name)));
    }
    if (names.length > 0) resultProfiles[agent] = names.sort();
  }

  const linkedRoots: Record<string, string> = {};
  for (const [agent, targetRoot] of Object.entries(input.profileRoots ?? {})) {
    const agentRoot = path.join(profileRoot, agent);
    const externalRoot = expandHome(targetRoot);
    const names = resultProfiles[agent] ?? [];
    const keep = new Set(names);
    await removeManagedLinks(externalRoot, path.resolve(agentRoot), keep);
    for (const name of names) {
      await replaceSymlink(path.join(externalRoot, name), path.resolve(agentRoot, name));
    }
    linkedRoots[agent] = externalRoot;
  }

  for (const warning of warnings) log.warn("profiles.sync.warning", { warning });
  log.info("profiles.synced", { profiles: Object.keys(resultProfiles), linkedRoots });
  return { profiles: resultProfiles, linkedRoots, warnings };
}
