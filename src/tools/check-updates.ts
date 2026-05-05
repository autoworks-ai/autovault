import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listInstalledSkillNames,
  readSkill,
  readSkillSource,
  type SkillSource
} from "../storage/index.js";
import { fetchSkillFromAgentSkills } from "../sources/agentskills.js";
import { fetchSkillFromGitHub } from "../sources/github.js";
import { fetchSkillFromUrl } from "../sources/url.js";
import type { FetchedSkill } from "../sources/types.js";
import { bundleHash, type HashedResource } from "../util/hash.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { attemptRepair } from "../validation/frontmatter.js";

type DriftEntry = {
  name: string;
  source: SkillSource["source"];
  identifier: string;
  reason: string;
  upstreamSha?: string;
};

type UncheckedEntry = {
  name: string;
  source: SkillSource["source"];
  identifier: string;
  reason: string;
};

export type CheckUpdatesDeps = {
  fetchers?: {
    github?: typeof fetchSkillFromGitHub;
    agentskills?: typeof fetchSkillFromAgentSkills;
    url?: typeof fetchSkillFromUrl;
  };
  bundledSkillsDir?: string;
};

function defaultBundledSkillsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "skills");
}

async function readBundledInlineBundle(
  source: SkillSource,
  deps: CheckUpdatesDeps
): Promise<{ skillMd: string; resources: HashedResource[] } | null> {
  if (!source.bundledSkillName) return null;
  const bundledName = source.bundledSkillName;
  assertSafeSkillName(bundledName);
  const bundledRoot = deps.bundledSkillsDir ?? defaultBundledSkillsDir();
  const skillRoot = path.join(bundledRoot, bundledName);
  const raw = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf-8");
  const { output } = attemptRepair(raw);

  const resources: HashedResource[] = [];
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.name !== "SKILL.md") {
        const content = await fs.readFile(abs, "utf-8");
        resources.push({ path: rel, content });
      }
    }
  }
  await walk(skillRoot, "");
  return { skillMd: output, resources };
}

async function fetchForSource(
  source: SkillSource,
  deps: CheckUpdatesDeps
): Promise<FetchedSkill | null> {
  switch (source.source) {
    case "github":
      return (deps.fetchers?.github ?? fetchSkillFromGitHub)(source.identifier);
    case "agentskills":
      return (deps.fetchers?.agentskills ?? fetchSkillFromAgentSkills)(source.identifier);
    case "url":
      return (deps.fetchers?.url ?? fetchSkillFromUrl)(source.identifier);
    case "inline":
      return null;
  }
}

export async function checkUpdates(
  skill?: string,
  deps: CheckUpdatesDeps = {}
): Promise<{
  drifted: DriftEntry[];
  up_to_date: string[];
  unchecked: UncheckedEntry[];
  errors: Array<{ name: string; error: string }>;
}> {
  if (skill !== undefined) assertSafeSkillName(skill);
  const names = skill ? [skill] : await listInstalledSkillNames();
  const drifted: DriftEntry[] = [];
  const upToDate: string[] = [];
  const unchecked: UncheckedEntry[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const name of names) {
    const installed = await readSkill(name);
    if (!installed) {
      errors.push({ name, error: "Skill not installed" });
      continue;
    }
    const source = await readSkillSource(name);
    if (!source) {
      errors.push({ name, error: "No source metadata recorded" });
      continue;
    }
    try {
      if (source.source === "inline") {
        const bundle = await readBundledInlineBundle(source, deps);
        if (!bundle) {
          unchecked.push({
            name,
            source: source.source,
            identifier: source.identifier,
            reason: "inline skill has no checkable upstream"
          });
          continue;
        }
        const bundledHash = bundleHash(bundle.skillMd, bundle.resources);
        if (bundledHash !== source.contentHash) {
          drifted.push({
            name,
            source: source.source,
            identifier: source.identifier,
            reason: "bundled content hash changed"
          });
        } else {
          upToDate.push(name);
        }
        continue;
      }

      const fetched = await fetchForSource(source, deps);
      if (!fetched) {
        unchecked.push({
          name,
          source: source.source,
          identifier: source.identifier,
          reason: "source has no checkable upstream"
        });
        continue;
      }
      const upstreamHash = bundleHash(fetched.skillMd, fetched.resources ?? []);
      if (
        upstreamHash !== source.contentHash ||
        (fetched.upstreamSha && source.upstreamSha && fetched.upstreamSha !== source.upstreamSha)
      ) {
        drifted.push({
          name,
          source: source.source,
          identifier: source.identifier,
          reason: upstreamHash !== source.contentHash ? "content hash changed" : "upstream sha changed",
          upstreamSha: fetched.upstreamSha
        });
      } else {
        upToDate.push(name);
      }
    } catch (error) {
      errors.push({ name, error: String(error) });
    }
  }

  return { drifted, up_to_date: upToDate, unchecked, errors };
}
