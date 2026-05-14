import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../util/log.js";
import type { NamedProfile } from "./config.js";

// Phase 2 of tag-filtered profiles: emit a Claude Code `skillOverrides` block
// alongside the per-project symlink farm. Symlinks under <project>/.claude/skills
// are additive to ~/.claude/skills — Claude Code merges the two. The only knob
// that actually shrinks the merged manifest is the per-skill on/off map in
// .claude/settings.json. This module owns that emission for managed projects.

type SnapshotSkillLike = {
  name: string;
  agents: string[];
};

export type EmitClaudeSkillOverridesArgs = {
  profile: NamedProfile;
  skills: SnapshotSkillLike[];
  includedNames: ReadonlyArray<string>;
};

export type EmitClaudeSkillOverridesResult = {
  path: string;
  entries: number;
} | null;

// Per Claude Code docs (v2.1.129+), values are: "on" | "name-only" |
// "user-invocable-only" | "off". We only ever emit "off" — included skills are
// omitted (default "on"). Other values are reserved for user hand-edits and
// would be overwritten on next sync (see README/CHANGELOG ownership note).
function resolveSettingsPath(profile: NamedProfile): string | null {
  const setting = profile.exportSkillOverrides;
  if (!setting) return null;
  const baseDir = path.dirname(path.resolve(profile.target));
  if (setting === true) {
    return path.join(baseDir, "settings.json");
  }
  if (typeof setting === "string") {
    if (setting.length === 0) return null;
    return path.isAbsolute(setting) ? setting : path.join(baseDir, setting);
  }
  return null;
}

function computeExcludedSlugs(
  profile: NamedProfile,
  skills: SnapshotSkillLike[],
  includedNames: ReadonlyArray<string>
): string[] {
  const included = new Set(includedNames);
  const excluded: string[] = [];
  for (const skill of skills) {
    // Only skills available to this profile's agent are candidates to override.
    if (!skill.agents.includes(profile.agent)) continue;
    // Plugin-namespaced slugs (foo:bar) are out of scope per Claude Code docs —
    // skillOverrides only affects non-plugin skills. AutoVault's SAFE_SLUG_PATTERN
    // already rejects colons at install time, so this is defense-in-depth for
    // hostile/legacy on-disk state.
    if (skill.name.includes(":")) continue;
    if (included.has(skill.name)) continue;
    excluded.push(skill.name);
  }
  excluded.sort();
  return excluded;
}

async function readSettings(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Settings file is not a JSON object: ${filePath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeSettings(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(filePath, serialized, "utf-8");
}

export async function emitClaudeSkillOverrides(
  args: EmitClaudeSkillOverridesArgs
): Promise<EmitClaudeSkillOverridesResult> {
  const { profile, skills, includedNames } = args;
  if (!profile.exportSkillOverrides) return null;
  if (profile.agent !== "claude-code") {
    log.debug("profiles.overrides.skip_non_claude", {
      profile: profile.name,
      agent: profile.agent
    });
    return null;
  }
  const settingsPath = resolveSettingsPath(profile);
  if (!settingsPath) return null;

  const excluded = computeExcludedSlugs(profile, skills, includedNames);
  const existing = await readSettings(settingsPath);
  const overrides: Record<string, "off"> = {};
  for (const name of excluded) overrides[name] = "off";
  existing.skillOverrides = overrides;
  await writeSettings(settingsPath, existing);

  log.info("profiles.overrides.emitted", {
    profile: profile.name,
    path: settingsPath,
    entries: excluded.length
  });
  return { path: settingsPath, entries: excluded.length };
}
