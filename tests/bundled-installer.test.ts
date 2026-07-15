import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkUpdates } from "../src/tools/check-updates.js";
import {
  readSkillSourceStatus,
  verifyInstalledIntegrity
} from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

type InstallBundledSkill = (
  name: string,
  options?: {
    bundledSkillsDir?: string;
    syncProfiles?: boolean;
  }
) => Promise<Record<string, unknown>>;

const skillMd = `---
name: bundled-test
description: Installs a repository-bundled fixture for provenance regression coverage.
agents: [codex]
metadata:
  version: "1.0.0"
resources:
  - path: references/notes.md
    type: file
---

# Bundled test
`;

async function installerExport(): Promise<InstallBundledSkill | undefined> {
  const library = await import("../src/library.js");
  return (library as unknown as { installBundledSkill?: InstallBundledSkill })
    .installBundledSkill;
}

async function writeBundle(): Promise<string> {
  const bundledSkillsDir = path.join(currentStorageRoot(), "package-skills");
  const root = path.join(bundledSkillsDir, "bundled-test");
  await fs.mkdir(path.join(root, "references"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), skillMd, "utf-8");
  await fs.writeFile(path.join(root, "references", "notes.md"), "# Notes\n", "utf-8");
  return bundledSkillsDir;
}

describe("installBundledSkill", () => {
  it("is exported by the public library API", async () => {
    expect(await installerExport()).toBeTypeOf("function");
  });

  it("installs a signed inline bundle with checkable bundled provenance", async () => {
    const bundledSkillsDir = await writeBundle();
    const installBundledSkill = await installerExport();
    expect(installBundledSkill).toBeTypeOf("function");
    if (!installBundledSkill) throw new Error("installBundledSkill export is missing");

    const result = await installBundledSkill("bundled-test", {
      bundledSkillsDir,
      syncProfiles: false
    });

    expect(result).toMatchObject({
      success: true,
      name: "bundled-test",
      source: {
        source: "inline",
        identifier: "bundled-test",
        bundledSkillName: "bundled-test"
      }
    });
    await expect(readSkillSourceStatus("bundled-test")).resolves.toMatchObject({
      kind: "present",
      source: {
        source: "inline",
        identifier: "bundled-test",
        bundledSkillName: "bundled-test"
      }
    });
    await expect(verifyInstalledIntegrity("bundled-test")).resolves.toMatchObject({
      kind: "ok"
    });

    const updates = await checkUpdates("bundled-test", { bundledSkillsDir });
    expect(updates.up_to_date).toEqual(["bundled-test"]);
    expect(updates.drifted).toHaveLength(0);
    expect(updates.unchecked).toHaveLength(0);
  });

  it("reports bundled drift when a packaged resource changes", async () => {
    const bundledSkillsDir = await writeBundle();
    const installBundledSkill = await installerExport();
    expect(installBundledSkill).toBeTypeOf("function");
    if (!installBundledSkill) throw new Error("installBundledSkill export is missing");

    await installBundledSkill("bundled-test", {
      bundledSkillsDir,
      syncProfiles: false
    });
    await fs.writeFile(
      path.join(bundledSkillsDir, "bundled-test", "references", "notes.md"),
      "# Changed notes\n",
      "utf-8"
    );

    const updates = await checkUpdates("bundled-test", { bundledSkillsDir });
    expect(updates.drifted).toEqual([
      {
        name: "bundled-test",
        source: "inline",
        identifier: "bundled-test",
        reason: "bundled content hash changed"
      }
    ]);
    expect(updates.up_to_date).toHaveLength(0);
    expect(updates.unchecked).toHaveLength(0);
  });

  it("refuses to follow a packaged symlink while checking bundled drift", async () => {
    const bundledSkillsDir = await writeBundle();
    const installBundledSkill = await installerExport();
    expect(installBundledSkill).toBeTypeOf("function");
    if (!installBundledSkill) throw new Error("installBundledSkill export is missing");

    await installBundledSkill("bundled-test", {
      bundledSkillsDir,
      syncProfiles: false
    });
    const resourcePath = path.join(
      bundledSkillsDir,
      "bundled-test",
      "references",
      "notes.md"
    );
    const outside = path.join(bundledSkillsDir, "outside.md");
    await fs.writeFile(outside, "# Outside\n", "utf-8");
    await fs.unlink(resourcePath);
    await fs.symlink(outside, resourcePath);

    const updates = await checkUpdates("bundled-test", { bundledSkillsDir });

    expect(updates.drifted).toHaveLength(0);
    expect(updates.errors).toHaveLength(1);
    expect(updates.errors[0]?.error).toMatch(/symlink resource/i);
  });

  it("ignores packaged AutoVault metadata directories during bundled drift checks", async () => {
    const bundledSkillsDir = await writeBundle();
    const installBundledSkill = await installerExport();
    expect(installBundledSkill).toBeTypeOf("function");
    if (!installBundledSkill) throw new Error("installBundledSkill export is missing");

    await installBundledSkill("bundled-test", {
      bundledSkillsDir,
      syncProfiles: false
    });
    const metadataDir = path.join(
      bundledSkillsDir,
      "bundled-test",
      ".autovault-cache"
    );
    await fs.mkdir(metadataDir);
    await fs.writeFile(path.join(metadataDir, "state.json"), "{}\n", "utf-8");

    const updates = await checkUpdates("bundled-test", { bundledSkillsDir });

    expect(updates.up_to_date).toEqual(["bundled-test"]);
    expect(updates.drifted).toHaveLength(0);
    expect(updates.errors).toHaveLength(0);
  });

  it("applies local bundle size limits during bundled drift checks", async () => {
    const bundledSkillsDir = await writeBundle();
    const installBundledSkill = await installerExport();
    expect(installBundledSkill).toBeTypeOf("function");
    if (!installBundledSkill) throw new Error("installBundledSkill export is missing");

    await installBundledSkill("bundled-test", {
      bundledSkillsDir,
      syncProfiles: false
    });
    await fs.writeFile(
      path.join(bundledSkillsDir, "bundled-test", "references", "notes.md"),
      "x".repeat(1024 * 1024 + 1),
      "utf-8"
    );

    const updates = await checkUpdates("bundled-test", { bundledSkillsDir });

    expect(updates.drifted).toHaveLength(0);
    expect(updates.errors).toHaveLength(1);
    expect(updates.errors[0]?.error).toMatch(/Resource 'references\/notes\.md'.*1048576/i);
  });
});

describe("bundled bootstrap", () => {
  it("uses the bundled installer instead of recording local-source installs", async () => {
    const source = await fs.readFile(
      path.resolve("scripts", "bootstrap-skills.mjs"),
      "utf-8"
    );

    expect(source).toContain("installBundledSkill");
    expect(source).not.toContain('source: "local"');
    expect(source).not.toContain('name: "add_skill"');
  });
});
