import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { applyDecisions } from "../src/cli/setup/apply.js";
import { renderFinalSummary } from "../src/cli/setup/render.js";
import { buildReviewPlan } from "../src/cli/setup/review.js";
import { scanDrift } from "../src/cli/setup/scan.js";
import * as profileSync from "../src/profiles/sync.js";
import { ensureStorage, readSkill, skillDir, writeSkill } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

const skillMd = (name: string, body: string, opts?: { agents?: string[] }): string => `---
name: ${name}
description: ${name} ${body} description text long enough to satisfy schema constraints.
${opts?.agents ? `agents: [${opts.agents.join(", ")}]\n` : ""}metadata:
  version: "1.0.0"
---

# ${name}

${body}
`;

async function writeNative(rootDir: string, name: string, contents: string): Promise<void> {
  const dir = path.join(rootDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), contents, "utf-8");
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return stdout;
}

async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return stderr;
}

describe("setup apply", () => {
  it("syncs once after batch adoption", async () => {
    await ensureStorage();
    const nativeRoot = path.join(currentStorageRoot(), "batch-adoption-root");
    await writeNative(nativeRoot, "batch-one", skillMd("batch-one", "first", { agents: ["codex"] }));
    await writeNative(nativeRoot, "batch-two", skillMd("batch-two", "second", { agents: ["codex"] }));
    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { codex: nativeRoot }
    });
    const syncSpy = vi.spyOn(profileSync, "syncProfiles");
    try {
      const outcomes = await applyDecisions({
        mode: "backup",
        candidates: report.skills.filter((skill) => skill.name.startsWith("batch-")),
        collisions: [],
        profileRoots: { codex: nativeRoot }
      });

      expect(outcomes.filter((outcome) => outcome.action === "adopt" && outcome.ok)).toHaveLength(2);
      expect(syncSpy).toHaveBeenCalledTimes(1);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it("backup mode adopts native skill into vault and renames original to <root>.bak/<name>", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-claude");
    await fs.mkdir(nativeRoot, { recursive: true });
    await writeNative(
      nativeRoot,
      "user-skill",
      skillMd("user-skill", "user version", { agents: ["claude-code"] })
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": nativeRoot }
    });

    const candidates = report.skills.filter((s) => s.name === "user-skill");
    const outcomes = await applyDecisions({
      mode: "backup",
      candidates,
      collisions: [],
      profileRoots: { "claude-code": nativeRoot }
    });

    const adopt = outcomes.find((o) => o.name === "user-skill" && o.action === "adopt");
    expect(adopt?.ok).toBe(true);

    const backup = outcomes.find((o) => o.name === "user-skill" && o.action === "backup");
    expect(backup?.ok).toBe(true);

    const backupPath = path.join(`${nativeRoot}.bak`, "user-skill", "SKILL.md");
    expect(await exists(backupPath)).toBe(true);

    // After sync, the externally-visible path is a managed symlink (not a
    // regular dir) pointing back at the vault.
    const externalEntry = path.join(nativeRoot, "user-skill");
    const externalStat = await fs.lstat(externalEntry);
    expect(externalStat.isSymbolicLink()).toBe(true);

    // Vault now has the skill.
    const installed = await readSkill("user-skill");
    expect(installed).not.toBeNull();
    expect(await exists(path.join(skillDir("user-skill"), "SKILL.md"))).toBe(true);
  });

  it("backup mode adopts a native skill missing agents by inferring the source root agent", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-claude-infer");
    await fs.mkdir(nativeRoot, { recursive: true });
    await writeNative(
      nativeRoot,
      "agentless-skill",
      skillMd("agentless-skill", "agentless native body")
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": nativeRoot }
    });

    const skill = report.skills.find((s) => s.name === "agentless-skill");
    expect(skill?.native[0]?.validation?.valid).toBe(true);
    expect((skill?.native[0] as { inferredAgents?: string[] } | undefined)?.inferredAgents).toEqual([
      "claude-code"
    ]);

    const outcomes = await applyDecisions({
      mode: "backup",
      candidates: skill ? [skill] : [],
      collisions: [],
      profileRoots: { "claude-code": nativeRoot }
    });

    expect(outcomes.find((o) => o.name === "agentless-skill" && o.action === "adopt")?.ok).toBe(true);

    const installed = await readSkill("agentless-skill");
    expect(installed?.agents).toEqual(["claude-code"]);
  });

  it("backup mode refuses to overwrite a pre-existing backup", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-claude-2");
    const backupRoot = `${nativeRoot}.bak`;
    await fs.mkdir(nativeRoot, { recursive: true });
    await fs.mkdir(path.join(backupRoot, "user-skill"), { recursive: true });
    await fs.writeFile(
      path.join(backupRoot, "user-skill", "previous"),
      "do not clobber me",
      "utf-8"
    );

    await writeNative(
      nativeRoot,
      "user-skill",
      skillMd("user-skill", "fresh", { agents: ["claude-code"] })
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": nativeRoot }
    });

    const candidates = report.skills.filter((s) => s.name === "user-skill");
    const outcomes = await applyDecisions({
      mode: "backup",
      candidates,
      collisions: [],
      profileRoots: { "claude-code": nativeRoot }
    });

    const backup = outcomes.find((o) => o.name === "user-skill" && o.action === "backup");
    expect(backup?.ok).toBe(false);
    expect(backup?.detail ?? "").toMatch(/already exists/);

    // Original is still in place — we refused to clobber.
    expect(await exists(path.join(nativeRoot, "user-skill", "SKILL.md"))).toBe(true);
  });

  it("in-place mode adopts and removes the original native dir", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-claude-3");
    await fs.mkdir(nativeRoot, { recursive: true });
    await writeNative(
      nativeRoot,
      "user-skill",
      skillMd("user-skill", "in-place test", { agents: ["claude-code"] })
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": nativeRoot }
    });

    const candidates = report.skills.filter((s) => s.name === "user-skill");
    const outcomes = await applyDecisions({
      mode: "in-place",
      candidates,
      collisions: [],
      profileRoots: { "claude-code": nativeRoot }
    });

    const replace = outcomes.find(
      (o) => o.name === "user-skill" && o.action === "replace-native"
    );
    expect(replace?.ok).toBe(true);

    // Vault has it.
    const installed = await readSkill("user-skill");
    expect(installed).not.toBeNull();

    // Native dir removed; symlink restoration depends on syncProfiles, which
    // creates the link under <storage>/profiles/<agent>/ and reflects it back
    // to the external root. After applyDecisions, the externally-visible path
    // should either be a managed symlink or absent — never a regular dir.
    const externalEntry = path.join(nativeRoot, "user-skill");
    if (await exists(externalEntry)) {
      const lstat = await fs.lstat(externalEntry);
      expect(lstat.isSymbolicLink()).toBe(true);
    }
  });

  it("collision use-bundled backs up native and reports the action", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-claude-4");
    const bundledRoot = path.join(currentStorageRoot(), "fake-bundled-4");
    await fs.mkdir(nativeRoot, { recursive: true });
    await fs.mkdir(bundledRoot, { recursive: true });

    await writeSkill("collide", skillMd("collide", "vault body", { agents: ["claude-code"] }));
    await writeNative(
      nativeRoot,
      "collide",
      skillMd("collide", "user variant", { agents: ["claude-code"] })
    );
    await writeNative(
      bundledRoot,
      "collide",
      skillMd("collide", "bundled body", { agents: ["claude-code"] })
    );

    const report = await scanDrift({
      bundledRoot,
      profileRoots: { "claude-code": nativeRoot }
    });

    const candidates = report.skills.filter((s) => s.name === "collide");

    const outcomes = await applyDecisions({
      mode: "backup",
      candidates,
      collisions: [{ name: "collide", action: "use-bundled" }],
      profileRoots: { "claude-code": nativeRoot }
    });

    const backup = outcomes.find(
      (o) => o.name === "collide" && o.action === "backup-native"
    );
    expect(backup?.ok).toBe(true);

    const backupPath = path.join(`${nativeRoot}.bak`, "collide", "SKILL.md");
    expect(await exists(backupPath)).toBe(true);
  });

  it("repair adoption installs synthesized resources without editing the native original", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-repair-adopt");
    const nativeDir = path.join(nativeRoot, "repairable");
    await writeNative(
      nativeRoot,
      "repairable",
      skillMd("repairable", "repair body", { agents: ["codex"] })
    );
    await fs.mkdir(path.join(nativeDir, "references"), { recursive: true });
    await fs.writeFile(path.join(nativeDir, "references", "guide.md"), "# Guide\n", "utf-8");

    const originalSkillMd = await fs.readFile(path.join(nativeDir, "SKILL.md"), "utf-8");
    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { codex: nativeRoot }
    });
    const skill = report.skills.find((entry) => entry.name === "repairable");
    expect(skill).toBeDefined();
    const plan = await buildReviewPlan(skill!);
    expect(plan.repair).toBeDefined();

    const outcomes = await applyDecisions({
      mode: "backup",
      candidates: [skill!],
      collisions: [],
      repairs: [{ name: "repairable", repair: plan.repair! }],
      profileRoots: { codex: nativeRoot }
    });

    expect(outcomes.find((outcome) => outcome.name === "repairable" && outcome.action === "repair-adopt")?.ok).toBe(true);
    const backupPath = path.join(`${nativeRoot}.bak`, "repairable", "SKILL.md");
    expect(await fs.readFile(backupPath, "utf-8")).toBe(originalSkillMd);

    const installed = await readSkill("repairable");
    expect(installed?.resources.map((resource) => resource.path)).toEqual(["references/guide.md"]);
    expect(installed?.skillMd).toContain("references/guide.md");
    expect(installed?.skillMd).not.toBe(originalSkillMd);

    const visible = await fs.lstat(path.join(nativeRoot, "repairable"));
    expect(visible.isSymbolicLink()).toBe(true);
    const backup = outcomes.find((outcome) => outcome.action === "backup");
    expect(backup?.restoreCommand).toContain("autovault sync-profiles");

    const stdout = await captureStdout(() => renderFinalSummary(report, outcomes));
    expect(stdout).toContain("restore");
    expect(stdout).toContain("autovault sync-profiles");
  });

  it("suppresses structured integrity logs during setup profile refresh", async () => {
    const previousLogLevel = process.env.AUTOVAULT_LOG_LEVEL;
    await ensureStorage();
    await writeSkill(
      "legacy-installed",
      skillMd("legacy-installed", "legacy vault body", { agents: ["codex"] })
    );
    await fs.rm(path.join(skillDir("legacy-installed"), ".autovault-manifest"), {
      force: true
    });

    process.env.AUTOVAULT_LOG_LEVEL = "warn";
    resetConfigCache();

    const nativeRoot = path.join(currentStorageRoot(), "fake-codex-log-noise");
    try {
      const stderr = await captureStderr(async () => {
        const outcomes = await applyDecisions({
          mode: "augment",
          candidates: [],
          collisions: [],
          profileRoots: { codex: nativeRoot },
          discover: false
        });
        expect(outcomes.find((outcome) => outcome.action === "sync-profiles")?.ok).toBe(true);
      });

      expect(stderr).toBe("");
    } finally {
      if (previousLogLevel === undefined) {
        delete process.env.AUTOVAULT_LOG_LEVEL;
      } else {
        process.env.AUTOVAULT_LOG_LEVEL = previousLogLevel;
      }
      resetConfigCache();
    }
  });

  it("summarizes setup profile sync warnings without dumping internal text", async () => {
    const stdout = await captureStdout(() =>
      renderFinalSummary(
        {
          storagePath: "",
          bundledRoot: "",
          discovered: {},
          skills: [],
          totals: {
            identical: 0,
            "vault-drift": 0,
            "bundled-drift": 0,
            "cross-host-drift": 0,
            "vault-only": 0,
            "native-only": 0,
            "bundled-only": 0,
            invalid: 0
          },
          hasFailingValidation: false
        },
        [
          {
            name: "—",
            action: "sync-warning",
            ok: false,
            detail:
              'Skipping external profile link for "claude-code/copilot-review" — a user-managed path already exists at "/Users/example/.claude/skills/copilot-review" (/Users/example/.claude/skills/copilot-review). Remove it manually if you want AutoVault to manage this name.'
          },
          {
            name: "—",
            action: "sync-warning",
            ok: false,
            detail:
              'Skipping external profile link for "claude-code/launch-strategist" — a user-managed path already exists at "/Users/example/.claude/skills/launch-strategist" (/Users/example/.claude/skills/launch-strategist). Remove it manually if you want AutoVault to manage this name.'
          },
          { name: "—", action: "sync-profiles", ok: true, detail: "claude-code, codex" }
        ]
      )
    );

    expect(stdout).toContain("2 profile link warnings");
    expect(stdout).toContain("claude-code/copilot-review");
    expect(stdout).toContain("claude-code/launch-strategist");
    expect(stdout).toContain("remove those paths, then run autovault sync-profiles");
    expect(stdout).not.toContain("Skipping external profile link");
  });
});
