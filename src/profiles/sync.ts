import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../config.js";
import { discoverProfileRoots } from "./discovery.js";
import {
  loadNamedProfileConfig,
  normalizeProfileTarget,
  type NamedProfile
} from "./config.js";
import {
  listInstalledSkillNamesUnlocked,
  readSkillUnlocked,
  recoverOrphanBackups,
  skillDir
} from "../storage/index.js";
import { withProfileSyncLock, withStorageLock } from "../storage/lock.js";
import { materializeRenderedSkillForAgent, pruneRenderedSkills } from "../transforms/index.js";
import { log } from "../util/log.js";
import { emitClaudeSkillOverrides } from "./skill-overrides.js";

export type SyncProfilesInput = {
  profileRoots?: Record<string, string>;
  discover?: boolean;
};

export type SyncProfilesResult = {
  profiles: Record<string, string[]>;
  linkedRoots: Record<string, string>;
  profileStatus: Record<string, SyncSkillStatus[]>;
  warnings: string[];
};

export type NamedProfileMembership = {
  name: string;
  agent: string;
  target: string;
  include_tags: "*" | string[];
  exclude_tags: string[];
  skills: string[];
};

export type ListConfiguredProfilesResult = {
  configPath: string;
  profiles: NamedProfileMembership[];
};

export type SyncSkillStatus = {
  name: string;
  status: "installed" | "updated" | "unchanged" | "failed";
  linked_root: string;
  visible_to_profile: boolean;
  restart_required: boolean;
  loaded_in_current_session: "unknown";
  message?: string;
};

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0)
    )
  ];
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

type ReplaceSymlinkResult =
  | { replaced: true; action: "created" | "updated" }
  | { replaced: false; reason: "noop" }
  | { replaced: false; reason: "user-managed"; current: string };

// `managedPrefix`, when supplied, narrows the replacement policy to symlinks
// that already point under AutoVault's managed tree. External profile roots
// (~/.claude/skills, ~/.codex/skills) are user-controlled directories where a
// human may have placed their own symlinks — round-41 finding was that we
// blindly unlinked anything not pointing at our target, including a manually
// installed native skill that happened to share a name. With managedPrefix
// set, an existing symlink that resolves outside the prefix is left alone and
// the caller surfaces a warning so the user can investigate.
async function replaceSymlink(
  linkPath: string,
  targetPath: string,
  managedPrefix?: string
): Promise<ReplaceSymlinkResult> {
  let action: "created" | "updated" = "created";
  try {
    const current = await fs.readlink(linkPath);
    const resolvedCurrent = path.resolve(path.dirname(linkPath), current);
    if (resolvedCurrent === targetPath) return { replaced: false, reason: "noop" };
    if (managedPrefix !== undefined) {
      const isManaged =
        resolvedCurrent === managedPrefix ||
        resolvedCurrent.startsWith(managedPrefix + path.sep);
      if (!isManaged) {
        return { replaced: false, reason: "user-managed", current: resolvedCurrent };
      }
    }
    await fs.unlink(linkPath);
    action = "updated";
  } catch (error) {
    if (await pathExists(linkPath)) {
      if (managedPrefix !== undefined) {
        return { replaced: false, reason: "user-managed", current: linkPath };
      }
      throw new Error(`Refusing to replace non-symlink path: ${linkPath}`);
    }
  }
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(targetPath, linkPath, symlinkType);
  return { replaced: true, action };
}

async function existingDirectoryNames(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Defense-in-depth: every agent name flowing into path.join(profileRoot, agent)
// must resolve to a direct child of profileRoot. The schema gate already
// rejects ../, /, \, but config-supplied profileRoots keys and filesystem
// scrapes via existingDirectoryNames are not bound by it. A single absolute
// or traversal value here would otherwise let syncProfiles mkdir/symlink
// outside the storage root.
function ensureAgentUnderRoot(profileRoot: string, agent: string): boolean {
  if (typeof agent !== "string" || agent.length === 0) return false;
  if (agent.includes("/") || agent.includes("\\") || agent === "." || agent === "..") {
    return false;
  }
  const resolved = path.resolve(profileRoot, agent);
  const expectedParent = path.resolve(profileRoot);
  // Direct child only — no subdirectory walks.
  return path.dirname(resolved) === expectedParent;
}

type SnapshotSkill = {
  name: string;
  agents: string[];
  tags: string[];
};

type ProfileSnapshot = {
  profiles: Map<string, string[]>;
  skills: SnapshotSkill[];
  warnings: string[];
};

async function buildProfileSnapshot(profileRoot: string): Promise<ProfileSnapshot> {
  const profiles = new Map<string, string[]>();
  const warnings: string[] = [];
  const skills: SnapshotSkill[] = [];
  let installedNames: string[];
  try {
    installedNames = await listInstalledSkillNamesUnlocked();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { profiles, skills, warnings };
    }
    throw error;
  }
  for (const name of installedNames) {
    const record = await readSkillUnlocked(name);
    if (!record) continue;
    if (record.agents.length === 0) {
      warnings.push(`Skill "${name}" has no agents frontmatter and is hidden from generated profiles.`);
      continue;
    }
    const safeAgents: string[] = [];
    for (const agent of record.agents) {
      if (!ensureAgentUnderRoot(profileRoot, agent)) {
        warnings.push(
          `Skill "${name}" declares unsafe agent name "${agent}"; refusing to sync.`
        );
        continue;
      }
      safeAgents.push(agent);
      const list = profiles.get(agent) ?? [];
      list.push(name);
      profiles.set(agent, list);
    }
    if (safeAgents.length > 0) {
      skills.push({
        name,
        agents: [...new Set(safeAgents)],
        tags: normalizeTags(record.tags)
      });
    }
  }
  return { profiles, skills, warnings };
}

function skillMatchesNamedProfile(skill: SnapshotSkill, profile: NamedProfile): boolean {
  if (!skill.agents.includes(profile.agent)) return false;
  const excluded = profile.excludeTags.some((tag) => skill.tags.includes(tag));
  if (excluded) return false;
  if (profile.includeTags === "*") return true;
  return profile.includeTags.some((tag) => skill.tags.includes(tag));
}

function namedProfileSkillNames(profile: NamedProfile, skills: SnapshotSkill[]): string[] {
  return skills
    .filter((skill) => skillMatchesNamedProfile(skill, profile))
    .map((skill) => skill.name)
    .sort();
}

function namedProfileMembership(
  profiles: NamedProfile[],
  snapshot: ProfileSnapshot
): NamedProfileMembership[] {
  return profiles.map((profile) => ({
    name: profile.name,
    agent: profile.agent,
    target: profile.target,
    include_tags: profile.includeTags,
    exclude_tags: profile.excludeTags,
    skills: namedProfileSkillNames(profile, snapshot.skills)
  }));
}

function assertNoDuplicateProfileTargets(
  profileRoots: Record<string, string>,
  namedProfiles: NamedProfile[]
): void {
  if (namedProfiles.length === 0) return;
  const legacyNames = new Set(Object.keys(profileRoots));
  for (const profile of namedProfiles) {
    if (legacyNames.has(profile.name)) {
      throw new Error(
        `Duplicate profile name "${profile.name}" between generated agent profiles and named profiles. Choose a distinct named profile name.`
      );
    }
  }

  const seen = new Map<string, string>();
  const add = (name: string, target: string): void => {
    const normalized = normalizeProfileTarget(expandHome(target));
    const previous = seen.get(normalized);
    if (previous) {
      throw new Error(
        `Duplicate profile target "${normalized}" for "${previous}" and "${name}". Each profile must target a distinct directory.`
      );
    }
    seen.set(normalized, name);
  };

  for (const [agent, target] of Object.entries(profileRoots)) add(agent, target);
  for (const profile of namedProfiles) add(profile.name, profile.target);
}

export async function listConfiguredProfiles(): Promise<ListConfiguredProfilesResult> {
  const config = loadConfig();
  const profileRoot = path.join(config.storagePath, "profiles");
  const namedConfig = await loadNamedProfileConfig(config.profileConfigPath);
  const snapshot = await withStorageLock(async () => buildProfileSnapshot(profileRoot));
  return {
    configPath: namedConfig.path,
    profiles: namedProfileMembership(namedConfig.profiles, snapshot)
  };
}

export async function syncProfiles(input: SyncProfilesInput = {}): Promise<SyncProfilesResult> {
  // Round-50 fix A: the entire body (recovery + snapshot + apply) runs under
  // the dedicated profile-sync lock so two overlapping syncs cannot race
  // their stale keep-sets. Without this serialization, sync A could snapshot
  // before skill X is installed, sync B could install X and create the
  // managed symlink, then sync A's apply would treat X as not-in-keep and
  // unlink the freshly-placed link — the vault install succeeds but the
  // host-visible profile silently loses the skill until a later sync repairs
  // it. The profile-sync lock is a separate domain from the storage lock so
  // writeSkill (which holds the storage lock) is never blocked by sync.
  //
  // Round-47 fix + round-48 lock-scope narrow: take the storage lock JUST long
  // enough to snapshot installed-skill names + their agent declarations, then
  // release. writeSkill renames liveDir → <name>.bak.<ts>.<rand> before
  // renaming the staged tmp into liveDir; without serialization an unlocked
  // listInstalledSkillNames would see the in-flight skill as missing during
  // that window and downstream removeManagedLinks would prune its profile
  // symlink. The keep-set computed under the lock is the only race-sensitive
  // observation against writeSkill — once we have it, the apply phase
  // operates on already-snapshotted data and doesn't need to serialize
  // against writeSkill.
  //
  // Round-48 fix: the apply phase touches caller-provided external profile
  // roots (~/.claude/skills, ~/.cursor/skills, …). Those paths can be slow,
  // huge, on flaky mounts, or permission-degraded. Holding the storage lock
  // through that work let one slow profile root starve unrelated install/
  // propose calls (the lock has a 10s ceiling). We therefore release the
  // STORAGE lock after the snapshot and run the apply phase outside it
  // (still inside the profile-sync lock per round-50).
  //
  // Callers (cli.ts, install-skill.ts, propose-skill.ts) all run AFTER
  // writeSkill returns, so there is no nested-lock path against the storage
  // lock. The profile-sync lock is acquired only here, so re-entry is also
  // not a concern (no caller wraps another sync inside it).
  //
  // Round-49 fix: roll forward orphan `<name>.bak.<...>` directories (left by a
  // writer that crashed between the live→bak rename and the tmp→live rename)
  // BEFORE the snapshot. Without this, the CLI `sync-profiles` path (and any
  // first sync after a crashed writer) would see no live dir for the skill,
  // build an empty keep-set, and removeManagedLinks would delete the skill's
  // managed profile symlinks even though the data is still recoverable from
  // the bak. recoverOrphanBackups uses tryWithStorageLock (non-blocking): if
  // another writer currently holds the storage lock, recovery skips and our
  // snapshot queues on withStorageLock; once the writer commits there is by
  // definition no orphan bak to recover, so skipping is safe.
  return withProfileSyncLock(async () => {
    const config = loadConfig();
    const profileRoot = path.join(config.storagePath, "profiles");
    const namedConfig = await loadNamedProfileConfig(config.profileConfigPath);
    const discoveredProfileRoots = input.discover ? await discoverProfileRoots() : {};
    const profileRoots = {
      ...discoveredProfileRoots,
      ...config.profileRoots,
      ...(input.profileRoots ?? {})
    };
    assertNoDuplicateProfileTargets(profileRoots, namedConfig.profiles);

    await recoverOrphanBackups();
    await fs.mkdir(profileRoot, { recursive: true });

    const snapshot = await withStorageLock(async () => buildProfileSnapshot(profileRoot));

    return syncProfilesApply(input, config, profileRoot, profileRoots, namedConfig.profiles, snapshot);
  });
}

async function syncProfilesApply(
  _input: SyncProfilesInput,
  config: ReturnType<typeof loadConfig>,
  profileRoot: string,
  profileRoots: Record<string, string>,
  namedProfiles: NamedProfile[],
  snapshot: ProfileSnapshot
): Promise<SyncProfilesResult> {
  const { profiles } = snapshot;
  const warnings = [...snapshot.warnings];

  const resultProfiles: Record<string, string[]> = {};
  const statusByAgent = new Map<string, Map<string, SyncSkillStatus>>();
  const setStatus = (agent: string, status: SyncSkillStatus): void => {
    const agentStatuses = statusByAgent.get(agent) ?? new Map<string, SyncSkillStatus>();
    agentStatuses.set(status.name, status);
    statusByAgent.set(agent, agentStatuses);
  };
  const renderedKeep = new Set<string>();
  const managedProfiles = new Map<string, { names: string[]; renderAgent: string }>();
  for (const [agent, names] of profiles.entries()) {
    managedProfiles.set(agent, { names, renderAgent: agent });
  }
  for (const profile of namedProfiles) {
    if (profiles.has(profile.name)) {
      throw new Error(
        `Named profile "${profile.name}" conflicts with generated agent profile "${profile.name}". Choose a distinct profile name.`
      );
    }
    managedProfiles.set(profile.name, {
      names: namedProfileSkillNames(profile, snapshot.skills),
      renderAgent: profile.agent
    });
  }

  const profileNames = new Set([
    ...await existingDirectoryNames(profileRoot),
    ...managedProfiles.keys()
  ]);
  for (const profileName of profileNames) {
    if (!ensureAgentUnderRoot(profileRoot, profileName)) {
      // Should not happen for entries that came through the validated frontmatter
      // path, but existingDirectoryNames also surfaces names already on disk —
      // a hostile filesystem state could re-introduce a traversal name. Skip.
      warnings.push(`Skipping sync for unsafe profile name "${profileName}".`);
      continue;
    }
    const plan = managedProfiles.get(profileName) ?? { names: [], renderAgent: profileName };
    const names = [...plan.names].sort();
    const agentRoot = path.join(profileRoot, profileName);
    const keep = new Set(names);
    await removeManagedLinks(agentRoot, path.resolve(config.storagePath), keep);
    for (const name of names) {
      let targetPath = path.resolve(skillDir(name));
      try {
        const rendered = await materializeRenderedSkillForAgent(name, plan.renderAgent);
        targetPath = path.resolve(rendered.path);
        if (rendered.applied_transforms.length > 0) {
          renderedKeep.add(`${plan.renderAgent}/${name}`);
        }
        for (const warning of rendered.warnings) warnings.push(warning);
      } catch (error) {
        warnings.push(
          `Skipping transforms for "${plan.renderAgent}/${name}" — ${String(error)}`
        );
      }
      const linkResult = await replaceSymlink(path.join(agentRoot, name), targetPath);
      setStatus(profileName, syncStatusFromLinkResult(name, agentRoot, linkResult));
    }
    if (names.length > 0) resultProfiles[profileName] = names;
  }
  try {
    await pruneRenderedSkills(renderedKeep);
  } catch (error) {
    warnings.push(`Skipping rendered skill cleanup — ${String(error)}`);
  }

  const linkedRoots: Record<string, string> = {};
  const externalTargets = new Map<string, string>(Object.entries(profileRoots));
  for (const profile of namedProfiles) externalTargets.set(profile.name, profile.target);
  for (const [profileName, targetRoot] of externalTargets.entries()) {
    if (!ensureAgentUnderRoot(profileRoot, profileName)) {
      warnings.push(
        `Skipping external profile link for unsafe profile name "${profileName}".`
      );
      continue;
    }
    const agentRoot = path.join(profileRoot, profileName);
    const externalRoot = expandHome(targetRoot);
    const names = resultProfiles[profileName] ?? [];
    const keep = new Set(names);
    const managedAgentRoot = path.resolve(agentRoot);
    await removeManagedLinks(externalRoot, managedAgentRoot, keep);
    for (const name of names) {
      const result = await replaceSymlink(
        path.join(externalRoot, name),
        path.resolve(agentRoot, name),
        managedAgentRoot
      );
      if (result.replaced === false && result.reason === "user-managed") {
        const message =
          `Skipping external profile link for "${profileName}/${name}" — a user-managed path already exists at "${path.join(externalRoot, name)}" (${result.current}). Remove it manually if you want AutoVault to manage this name.`
        warnings.push(message);
        setStatus(profileName, {
          name,
          status: "failed",
          linked_root: externalRoot,
          visible_to_profile: false,
          restart_required: false,
          loaded_in_current_session: "unknown",
          message
        });
      } else {
        setStatus(profileName, syncStatusFromLinkResult(name, externalRoot, result));
      }
    }
    linkedRoots[profileName] = externalRoot;
  }

  // Phase-2 emission: claude-code profiles can opt in to a Claude Code
  // `skillOverrides` block alongside the symlink farm. The block writes
  // <slug>: "off" for every claude-code skill the profile's tag filter
  // excluded, which is the only mechanism that actually shrinks the
  // additively-merged Claude Code skill manifest. Failures are surfaced as
  // warnings rather than aborting the sync — the symlinks have already
  // landed and a stale settings.json is recoverable on the next run.
  for (const profile of namedProfiles) {
    if (!profile.exportSkillOverrides) continue;
    const included = managedProfiles.get(profile.name)?.names ?? [];
    try {
      await emitClaudeSkillOverrides({
        profile,
        skills: snapshot.skills,
        includedNames: included
      });
    } catch (error) {
      warnings.push(
        `Failed to emit skillOverrides for "${profile.name}" — ${String(error)}`
      );
    }
  }

  const profileStatus = Object.fromEntries(
    [...statusByAgent.entries()].map(([agent, statuses]) => [
      agent,
      [...statuses.values()].sort((a, b) => a.name.localeCompare(b.name))
    ])
  );

  for (const warning of warnings) log.warn("profiles.sync.warning", { warning });
  log.info("profiles.synced", { profiles: Object.keys(resultProfiles), linkedRoots });
  return { profiles: resultProfiles, linkedRoots, profileStatus, warnings };
}

function syncStatusFromLinkResult(
  name: string,
  linkedRoot: string,
  result: ReplaceSymlinkResult
): SyncSkillStatus {
  const status = result.replaced
    ? result.action === "created"
      ? "installed"
      : "updated"
    : "unchanged";
  return {
    name,
    status,
    linked_root: linkedRoot,
    visible_to_profile: true,
    restart_required: status !== "unchanged",
    loaded_in_current_session: "unknown"
  };
}
