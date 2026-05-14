import fs from "node:fs/promises";
import path from "node:path";
import { addLocalSkill } from "../../installer/local.js";
import { syncProfiles } from "../../profiles/sync.js";
import type { SkillView } from "./scan.js";

export type AdoptionMode = "augment" | "backup" | "in-place";

export type CollisionAction = "use-bundled" | "keep-native" | "skip";

export type CollisionDecision = {
  name: string;
  action: CollisionAction;
};

export type ApplyInput = {
  mode: AdoptionMode;
  candidates: SkillView[];
  collisions: CollisionDecision[];
  profileRoots: Record<string, string>;
  discover?: boolean;
};

export type ApplyOutcome = {
  name: string;
  action: string;
  ok: boolean;
  detail?: string;
};

function backupRootFor(nativeRoot: string): string {
  // ~/.claude/skills → ~/.claude/skills.bak
  return `${nativeRoot}.bak`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function backupNative(nativeRoot: string, name: string): Promise<string> {
  const source = path.join(nativeRoot, name);
  const backupRoot = backupRootFor(nativeRoot);
  const target = path.join(backupRoot, name);
  if (await pathExists(target)) {
    throw new Error(
      `backup target already exists at ${target} (refuse to overwrite — move or delete it first)`
    );
  }
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.rename(source, target);
  return target;
}

async function removeNative(nativeRoot: string, name: string): Promise<void> {
  const source = path.join(nativeRoot, name);
  if (!(await pathExists(source))) return;
  await fs.rm(source, { recursive: true, force: true });
}

async function adoptOne(
  skill: SkillView,
  mode: "backup" | "in-place"
): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  // Choose the first native source for the bundle bytes. cross-host-drift is
  // surfaced in the report; we adopt the first source and the user can
  // re-run setup pointing at the others.
  const native = skill.native[0];
  if (!native) {
    return [
      { name: skill.name, action: "adopt", ok: false, detail: "no native source available" }
    ];
  }
  let bundleSource = native.skillDir;
  if (mode === "backup") {
    try {
      bundleSource = await backupNative(native.rootDir, skill.name);
      outcomes.push({
        name: skill.name,
        action: "backup",
        ok: true,
        detail: bundleSource
      });
    } catch (error) {
      outcomes.push({
        name: skill.name,
        action: "backup",
        ok: false,
        detail: String(error)
      });
      return outcomes;
    }
  }

  const result = await addLocalSkill({
    skillDir: bundleSource,
    source: `native:${native.agent ?? "unknown"}`,
    inferredAgents: native.inferredAgents
  });
  if (!result.success) {
    const reason =
      result.validation.errors[0] ??
      result.validation.securityFlags[0] ??
      "unknown validation error";
    outcomes.push({
      name: skill.name,
      action: "adopt",
      ok: false,
      detail: reason
    });
    return outcomes;
  }
  outcomes.push({ name: skill.name, action: "adopt", ok: true });

  if (mode === "in-place") {
    try {
      await removeNative(native.rootDir, skill.name);
      outcomes.push({ name: skill.name, action: "replace-native", ok: true });
    } catch (error) {
      outcomes.push({
        name: skill.name,
        action: "replace-native",
        ok: false,
        detail: String(error)
      });
    }
  }

  return outcomes;
}

async function applyCollision(
  skill: SkillView,
  decision: CollisionAction
): Promise<ApplyOutcome[]> {
  if (decision === "skip") {
    return [{ name: skill.name, action: "skip-collision", ok: true }];
  }
  if (decision === "use-bundled") {
    const native = skill.native[0];
    if (!native) {
      return [
        {
          name: skill.name,
          action: "use-bundled",
          ok: false,
          detail: "no native version found to back up"
        }
      ];
    }
    const outcomes: ApplyOutcome[] = [];
    try {
      const target = await backupNative(native.rootDir, skill.name);
      outcomes.push({
        name: skill.name,
        action: "backup-native",
        ok: true,
        detail: target
      });
    } catch (error) {
      outcomes.push({
        name: skill.name,
        action: "backup-native",
        ok: false,
        detail: String(error)
      });
      return outcomes;
    }
    // Bundled install is handled by bootstrap-skills; we just got the native
    // out of the way. Caller will rerun bootstrap or sync after this.
    outcomes.push({
      name: skill.name,
      action: "use-bundled",
      ok: true,
      detail: "native moved aside; bundled version will be installed by bootstrap"
    });
    return outcomes;
  }
  // keep-native: adopt the user's native bytes into the vault so they shadow
  // the bundled version on the next bootstrap pass.
  return adoptOne(skill, "in-place");
}

export async function applyDecisions(input: ApplyInput): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  const collisionsByName = new Map<string, CollisionAction>();
  for (const decision of input.collisions) {
    collisionsByName.set(decision.name, decision.action);
  }

  if (input.mode === "augment") {
    // No adoption; only collision decisions apply.
    for (const skill of input.candidates) {
      const decision = collisionsByName.get(skill.name);
      if (!decision) continue;
      outcomes.push(...(await applyCollision(skill, decision)));
    }
  } else {
    for (const skill of input.candidates) {
      if (collisionsByName.has(skill.name)) {
        outcomes.push(...(await applyCollision(skill, collisionsByName.get(skill.name)!)));
        continue;
      }
      outcomes.push(...(await adoptOne(skill, input.mode)));
    }
  }

  // Final sync so newly adopted skills surface as managed symlinks under the
  // selected native roots. addLocalSkill only syncs when sync_profiles is
  // explicitly requested; we bundle one sync at the end to avoid N redundant
  // walks.
  try {
    const sync = await syncProfiles({
      profileRoots: input.profileRoots,
      discover: input.discover ?? false
    });
    for (const warning of sync.warnings) {
      outcomes.push({ name: "—", action: "sync-warning", ok: false, detail: warning });
    }
    outcomes.push({
      name: "—",
      action: "sync-profiles",
      ok: true,
      detail: Object.keys(sync.linkedRoots).join(", ") || "no external roots"
    });
  } catch (error) {
    outcomes.push({
      name: "—",
      action: "sync-profiles",
      ok: false,
      detail: String(error)
    });
  }

  return outcomes;
}
