import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adoptionCandidates,
  bundledNativeCollisions,
  failingNativeSkills,
  scanDrift
} from "../src/cli/setup/scan.js";
import { ensureStorage, writeSkill } from "../src/storage/index.js";
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

async function writeNativeSkill(
  rootDir: string,
  name: string,
  contents: string
): Promise<void> {
  const dir = path.join(rootDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), contents, "utf-8");
}

async function writeBundledSkill(
  bundledRoot: string,
  name: string,
  contents: string
): Promise<void> {
  await writeNativeSkill(bundledRoot, name, contents);
}

describe("setup scan", () => {
  it("categorizes identical / drift / native-only / vault-only correctly", async () => {
    await ensureStorage();

    const bundledRoot = path.join(currentStorageRoot(), "fake-bundled");
    const nativeRoot = path.join(currentStorageRoot(), "fake-native");
    await fs.mkdir(bundledRoot, { recursive: true });
    await fs.mkdir(nativeRoot, { recursive: true });

    const sharedBytes = skillMd("identical-skill", "shared body", { agents: ["claude-code"] });
    await writeSkill("identical-skill", sharedBytes);
    await writeBundledSkill(bundledRoot, "identical-skill", sharedBytes);
    await writeNativeSkill(nativeRoot, "identical-skill", sharedBytes);

    await writeSkill("vault-only-skill", skillMd("vault-only-skill", "vault only", { agents: ["claude-code"] }));

    await writeNativeSkill(nativeRoot, "native-only-skill", skillMd("native-only-skill", "native only", { agents: ["claude-code"] }));

    const vaultBytes = skillMd("drifted", "vault version", { agents: ["claude-code"] });
    const nativeBytes = skillMd("drifted", "native version (different)", { agents: ["claude-code"] });
    await writeSkill("drifted", vaultBytes);
    await writeNativeSkill(nativeRoot, "drifted", nativeBytes);

    const report = await scanDrift({
      bundledRoot,
      profileRoots: { "claude-code": nativeRoot }
    });

    const byName = new Map(report.skills.map((s) => [s.name, s]));
    expect(byName.get("identical-skill")?.category).toBe("identical");
    expect(byName.get("vault-only-skill")?.category).toBe("vault-only");
    expect(byName.get("native-only-skill")?.category).toBe("native-only");
    expect(byName.get("drifted")?.category).toBe("vault-drift");

    expect(adoptionCandidates(report).map((s) => s.name).sort()).toEqual([
      "drifted",
      "native-only-skill"
    ]);
  });

  it("detects cross-host drift when the same name exists in two native roots with different bytes", async () => {
    await ensureStorage();

    const claudeRoot = path.join(currentStorageRoot(), "fake-claude");
    const codexRoot = path.join(currentStorageRoot(), "fake-codex");
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.mkdir(codexRoot, { recursive: true });

    await writeNativeSkill(claudeRoot, "copilot-review", skillMd("copilot-review", "claude variant", { agents: ["claude-code"] }));
    await writeNativeSkill(codexRoot, "copilot-review", skillMd("copilot-review", "codex variant — different body", { agents: ["codex"] }));

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": claudeRoot, codex: codexRoot }
    });

    const view = report.skills.find((s) => s.name === "copilot-review");
    expect(view?.category).toBe("cross-host-drift");
    expect(view?.native).toHaveLength(2);
  });

  it("detects drift when only bundle resources changed", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-native-resource");
    await fs.mkdir(nativeRoot, { recursive: true });

    const sameSkillMd = skillMd("resource-drift", "same skill md", { agents: ["claude-code"] });
    await writeSkill(
      "resource-drift",
      sameSkillMd,
      [{ path: "bin/setup", content: "#!/usr/bin/env bash\necho vault\n" }]
    );

    const nativeDir = path.join(nativeRoot, "resource-drift");
    await fs.mkdir(path.join(nativeDir, "bin"), { recursive: true });
    await fs.writeFile(path.join(nativeDir, "SKILL.md"), sameSkillMd, "utf-8");
    await fs.writeFile(
      path.join(nativeDir, "bin", "setup"),
      "#!/usr/bin/env bash\necho native\n",
      "utf-8"
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": nativeRoot }
    });

    expect(report.skills.find((s) => s.name === "resource-drift")?.category).toBe(
      "vault-drift"
    );
  });

  it("includes native skill directory symlinks in scan results", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-native-symlink");
    const targetRoot = path.join(currentStorageRoot(), "fake-native-symlink-targets");
    await fs.mkdir(nativeRoot, { recursive: true });
    await fs.mkdir(targetRoot, { recursive: true });

    await writeNativeSkill(
      targetRoot,
      "linked-skill",
      skillMd("linked-skill", "symlinked native", { agents: ["claude-code"] })
    );
    await fs.symlink(
      path.join(targetRoot, "linked-skill"),
      path.join(nativeRoot, "linked-skill"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": nativeRoot }
    });

    const linked = report.skills.find((s) => s.name === "linked-skill");
    expect(linked?.category).toBe("native-only");
    expect(linked?.native[0]?.skillDir).toBe(path.join(nativeRoot, "linked-skill"));
  });

  it("flags native skills that would fail vault validation", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "fake-native-bad");
    await fs.mkdir(nativeRoot, { recursive: true });

    // Description shorter than minimum → schema fails.
    const dir = path.join(nativeRoot, "tiny");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---
name: tiny
description: too short
---

# tiny
`,
      "utf-8"
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": nativeRoot }
    });

    const failing = failingNativeSkills(report);
    expect(failing.map((s) => s.name)).toContain("tiny");
    expect(report.hasFailingValidation).toBe(true);
  });

  it("collects bundled-vs-native collisions only when there is drift", async () => {
    await ensureStorage();

    const bundledRoot = path.join(currentStorageRoot(), "fake-bundled-2");
    const nativeRoot = path.join(currentStorageRoot(), "fake-native-2");
    await fs.mkdir(bundledRoot, { recursive: true });
    await fs.mkdir(nativeRoot, { recursive: true });

    const same = skillMd("aligned", "same bytes", { agents: ["claude-code"] });
    await writeSkill("aligned", same);
    await writeBundledSkill(bundledRoot, "aligned", same);
    await writeNativeSkill(nativeRoot, "aligned", same);

    await writeSkill("collide", skillMd("collide", "vault body", { agents: ["claude-code"] }));
    await writeBundledSkill(bundledRoot, "collide", skillMd("collide", "vault body", { agents: ["claude-code"] }));
    await writeNativeSkill(nativeRoot, "collide", skillMd("collide", "user-edited body — different", { agents: ["claude-code"] }));

    const report = await scanDrift({
      bundledRoot,
      profileRoots: { "claude-code": nativeRoot }
    });

    const collisions = bundledNativeCollisions(report);
    expect(collisions.map((s) => s.name)).toEqual(["collide"]);
  });
});
