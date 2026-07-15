import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeSkillName } from "../util/skill-name.js";
import { installSkill } from "../tools/install-skill.js";
import { collectLocalSkillBundle } from "./local.js";

export type InstallBundledSkillOptions = {
  bundledSkillsDir?: string;
  syncProfiles?: boolean;
  profileRoots?: Record<string, string>;
  discoverProfileRoots?: boolean;
};

function defaultBundledSkillsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "skills");
}

/**
 * Install one skill shipped in this package's skills/ directory.
 *
 * Bundled bytes are collected with the same path, symlink, artifact, and size
 * checks as any local bundle. They are then written through the inline install
 * path so source metadata records the stable bundle name instead of an
 * installation-specific filesystem path. check_updates can consequently
 * compare the signed install with the currently packaged bundle.
 */
export async function installBundledSkill(
  name: string,
  options: InstallBundledSkillOptions = {}
): Promise<Record<string, unknown>> {
  assertSafeSkillName(name);
  const bundledSkillsDir = path.resolve(
    options.bundledSkillsDir ?? defaultBundledSkillsDir()
  );
  const bundle = await collectLocalSkillBundle(path.join(bundledSkillsDir, name));

  return installSkill({
    // skill_md makes this an inline install. A concrete adapter value remains
    // required by InstallSkillInput, but no URL fetch is attempted.
    source: "url",
    identifier: name,
    expected_name: name,
    skill_md: bundle.skillMd,
    resources: bundle.resources,
    bundled_skill_name: name,
    sync_profiles: options.syncProfiles,
    profile_roots: options.profileRoots,
    discover_profile_roots: options.discoverProfileRoots
  });
}
