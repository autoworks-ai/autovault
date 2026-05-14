import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyDecisions } from "../src/cli/setup/apply.js";
import { scanDrift } from "../src/cli/setup/scan.js";
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

describe("setup apply", () => {
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
});
