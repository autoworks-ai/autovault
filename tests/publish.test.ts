import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPublishSync,
  inspectPublishTarget,
  planPublishSync,
  type PublishRegistry
} from "../src/publish/index.js";
import { bundleHash } from "../src/util/hash.js";
import { writeSkill, type SkillSource } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

function skillMd(
  name: string,
  options: { license?: string; version?: string; resources?: string[] } = {}
): string {
  const resources = options.resources ?? [];
  const binResource = resources.find((resource) => resource.startsWith("bin/"));
  return `---
name: ${name}
description: Use when testing the AutoVault publication workflow for a local catalog target.
license: ${options.license ?? "MIT"}
agents: [codex]
metadata:
  version: "${options.version ?? "1.0.0"}"
${
  resources.length > 0
    ? `resources:\n${resources.map((resource) => `  - path: ${resource}\n    type: file`).join("\n")}\n`
    : ""
}${binResource ? `bin:\n  run:\n    command: ${binResource}\n` : ""}---

# ${name}
`;
}

function source(name: string, md: string, resources: Array<{ path: string; content: string }> = []): SkillSource {
  return {
    source: "local",
    identifier: `fixture:${name}`,
    fetchedAt: "2026-08-20T00:00:00.000Z",
    contentHash: bundleHash(md, resources)
  };
}

async function install(
  name: string,
  options: { license?: string; version?: string; resources?: Array<{ path: string; content: string }> } = {}
): Promise<void> {
  const resources = options.resources ?? [];
  const md = skillMd(name, {
    license: options.license,
    version: options.version,
    resources: resources.map((resource) => resource.path)
  });
  await writeSkill(name, md, resources, source(name, md, resources));
}

async function makeTarget(registry: PublishRegistry): Promise<string> {
  const target = path.join(currentStorageRoot(), "target");
  await fs.mkdir(path.join(target, "catalog"), { recursive: true });
  await fs.mkdir(path.join(target, "skills"), { recursive: true });
  await fs.writeFile(
    path.join(target, "catalog", "autovault-publication.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8"
  );
  return target;
}

const registry: PublishRegistry = {
  schemaVersion: 1,
  target: "skillissue",
  skills: {
    alpha: { visibility: "public" },
    legacy: { visibility: "hidden", replacement: "alpha" }
  }
};

describe("AutoVault publication targets", () => {
  it("computes eligibility from intent, integrity, license, version, and story", async () => {
    await install("alpha");
    await install("unlicensed", { license: "" });
    await install("proprietary", { license: "proprietary" });
    await install("unlicensed-marker", { license: "UNLICENSED" });
    await install("all-rights-reserved", { license: "All Rights Reserved" });
    await install("custom-license", { license: "MIT OR LicenseRef-Internal" });
    await install("agpl", { license: "AGPL-3.0-only" });
    await install("epl", { license: "EPL-2.0" });
    await install("cc-by", { license: "CC-BY-4.0" });
    await install("classpath", { license: "GPL-2.0-only WITH Classpath-exception-2.0" });
    await install("unversioned", { version: "0.0.0" });
    await install("whitespace-version", { version: "   " });
    await install("tampered");
    await fs.appendFile(
      path.join(currentStorageRoot(), "skills", "tampered", "SKILL.md"),
      "\nmodified after signing\n"
    );

    const target = await makeTarget({
      schemaVersion: 1,
      target: "skillissue",
      skills: {
        alpha: { visibility: "public" },
        unlicensed: { visibility: "public" },
        proprietary: { visibility: "public" },
        "unlicensed-marker": { visibility: "public" },
        "all-rights-reserved": { visibility: "public" },
        "custom-license": { visibility: "public" },
        agpl: { visibility: "public" },
        epl: { visibility: "public" },
        "cc-by": { visibility: "public" },
        classpath: { visibility: "public" },
        unversioned: { visibility: "public" },
        "whitespace-version": { visibility: "public" },
        tampered: { visibility: "public" },
        missing: { visibility: "public" },
        legacy: { visibility: "hidden", replacement: "alpha" }
      }
    });
    await fs.mkdir(path.join(target, "skills", "alpha"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "alpha", "story.md"), "# Alpha story\n");
    for (const name of ["agpl", "epl", "cc-by", "classpath"]) {
      await fs.mkdir(path.join(target, "skills", name), { recursive: true });
      await fs.writeFile(path.join(target, "skills", name, "story.md"), `# ${name} story\n`);
    }

    const status = await inspectPublishTarget(target);

    expect(status.eligible.map((entry) => entry.name)).toEqual([
      "agpl",
      "alpha",
      "cc-by",
      "classpath",
      "epl"
    ]);
    expect(status.hidden).toEqual([
      expect.objectContaining({ name: "legacy", replacement: "alpha" })
    ]);
    expect(status.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "missing", reasons: ["not_installed"] }),
        expect.objectContaining({ name: "tampered", reasons: ["integrity_failed"] }),
        expect.objectContaining({ name: "unlicensed", reasons: ["license_missing"] }),
        expect.objectContaining({
          name: "proprietary",
          reasons: ["license_not_redistributable"]
        }),
        expect.objectContaining({
          name: "unlicensed-marker",
          reasons: ["license_not_redistributable"]
        }),
        expect.objectContaining({
          name: "all-rights-reserved",
          reasons: ["license_not_redistributable"]
        }),
        expect.objectContaining({ name: "unversioned", reasons: ["version_missing"] }),
        expect.objectContaining({ name: "whitespace-version", reasons: ["version_missing"] })
        ,expect.objectContaining({
          name: "custom-license",
          reasons: ["license_not_redistributable"]
        })
      ])
    );
  });

  it("plans seven removals without mutating the target", async () => {
    await install("alpha");
    const target = await makeTarget(registry);
    await fs.mkdir(path.join(target, "skills", "alpha"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "alpha", "story.md"), "# Alpha story\n");
    for (const name of [
      "legacy",
      "dev-browser",
      "voiceink-2-upgrade",
      "release-readiness",
      "autojack-delegate",
      "inbox-triage",
      "session-consolidate"
    ]) {
      await fs.mkdir(path.join(target, "skills", name), { recursive: true });
      await fs.writeFile(path.join(target, "skills", name, "SKILL.md"), `# ${name}\n`);
      await fs.writeFile(path.join(target, "skills", name, "story.md"), `# ${name} story\n`);
    }

    const plan = await planPublishSync(target);

    expect(plan.blocked).toEqual([]);
    expect(plan.remove).toHaveLength(7);
    expect(plan.remove).toEqual(
      expect.arrayContaining([
        "legacy",
        "dev-browser",
        "voiceink-2-upgrade",
        "release-readiness",
        "autojack-delegate",
        "inbox-triage",
        "session-consolidate"
      ])
    );
    await expect(fs.readFile(path.join(target, "skills", "dev-browser", "SKILL.md"), "utf-8")).resolves.toContain("dev-browser");
    await expect(fs.stat(path.join(target, "catalog", "autovault-sync.json"))).rejects.toThrow();
  });

  it("applies a verified bundle, preserves story.md, excludes vault metadata, and writes a receipt", async () => {
    await install("alpha", {
      resources: [
        { path: "references/example.md", content: "verified resource\n" },
        { path: "bin/run", content: "#!/bin/sh\necho published\n" }
      ]
    });
    const target = await makeTarget(registry);
    await fs.mkdir(path.join(target, "skills", "alpha"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "alpha", "story.md"), "# Site-owned story\n");
    await fs.writeFile(path.join(target, "skills", "alpha", "stale.txt"), "remove me\n");
    await fs.mkdir(path.join(target, "skills", "legacy"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "legacy", "SKILL.md"), "legacy\n");

    const plan = await planPublishSync(target);
    const result = await applyPublishSync(plan);

    expect(result.applied).toBe(true);
    await expect(fs.readFile(path.join(target, "skills", "alpha", "story.md"), "utf-8")).resolves.toBe("# Site-owned story\n");
    await expect(fs.readFile(path.join(target, "skills", "alpha", "references", "example.md"), "utf-8")).resolves.toBe("verified resource\n");
    expect((await fs.stat(path.join(target, "skills", "alpha", "bin", "run"))).mode & 0o777).toBe(0o755);
    await expect(fs.stat(path.join(target, "skills", "alpha", "stale.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(target, "skills", "alpha", ".autovault-manifest"))).rejects.toThrow();
    await expect(fs.stat(path.join(target, "skills", "alpha", ".autovault-source.json"))).rejects.toThrow();
    await expect(fs.stat(path.join(target, "skills", "legacy"))).rejects.toThrow();

    const receipt = JSON.parse(
      await fs.readFile(path.join(target, "catalog", "autovault-sync.json"), "utf-8")
    ) as { schemaVersion: number; target: string; skills: Array<{ name: string; version: string }> };
    expect(receipt).toEqual({
      schemaVersion: 1,
      target: "skillissue",
      skills: [expect.objectContaining({ name: "alpha", version: "1.0.0" })]
    });
  });

  it("does not replace packages when the receipt target fails preflight", async () => {
    await install("alpha");
    const target = await makeTarget(registry);
    const outside = path.join(currentStorageRoot(), "receipt-outside.json");
    await fs.mkdir(path.join(target, "skills", "alpha"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "alpha", "SKILL.md"), "# Original package\n");
    await fs.writeFile(path.join(target, "skills", "alpha", "story.md"), "# Alpha story\n");
    const plan = await planPublishSync(target);
    await fs.writeFile(outside, "outside\n");
    await fs.symlink(outside, path.join(target, "catalog", "autovault-sync.json"));

    await expect(applyPublishSync(plan)).rejects.toThrow(/symlink/i);
    await expect(fs.readFile(path.join(target, "skills", "alpha", "SKILL.md"), "utf-8")).resolves.toBe(
      "# Original package\n"
    );
  });

  it("refuses apply when a public skill is blocked or lacks a site narrative", async () => {
    await install("alpha");
    const target = await makeTarget(registry);
    const plan = await planPublishSync(target);

    expect(plan.blocked).toEqual([
      expect.objectContaining({ name: "alpha", reasons: ["story_missing"] })
    ]);
    await expect(applyPublishSync(plan)).rejects.toThrow(/blocked/i);
  });

  it("rejects symlinked target paths and case-colliding package directories", async () => {
    await install("alpha");
    const target = await makeTarget(registry);
    const outside = path.join(currentStorageRoot(), "outside");
    await fs.mkdir(path.join(outside, "skills"), { recursive: true });
    await fs.rm(path.join(target, "skills"), { recursive: true, force: true });
    await fs.symlink(path.join(outside, "skills"), path.join(target, "skills"));

    await expect(planPublishSync(target)).rejects.toThrow(/symlink/i);

    await fs.rm(path.join(target, "skills"), { force: true });
    await fs.mkdir(path.join(target, "skills", "Alpha"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "Alpha", "story.md"), "# Alpha\n");

    await expect(planPublishSync(target)).rejects.toThrow(/case/i);
  });

  it("does not let a signed resource overwrite a target-owned story", async () => {
    await install("alpha", {
      resources: [{ path: "story.md", content: "signed bundle content\n" }]
    });
    const target = await makeTarget(registry);
    await fs.mkdir(path.join(target, "skills", "alpha"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "alpha", "story.md"), "# Site story\n");

    const plan = await planPublishSync(target);

    expect(plan.blocked).toEqual([
      expect.objectContaining({ name: "alpha", reasons: ["integrity_failed"] })
    ]);
  });

  it("plans and applies a fresh target with no skills directory", async () => {
    const target = path.join(currentStorageRoot(), "fresh-target");
    await fs.mkdir(path.join(target, "catalog"), { recursive: true });
    await fs.writeFile(
      path.join(target, "catalog", "autovault-publication.json"),
      `${JSON.stringify({ schemaVersion: 1, target: "fresh", skills: {} }, null, 2)}\n`,
      "utf-8"
    );

    const plan = await planPublishSync(target);
    expect(plan.copy).toEqual([]);
    expect(plan.remove).toEqual([]);

    await applyPublishSync(plan);
    await expect(fs.stat(path.join(target, "skills"))).resolves.toBeDefined();
    await expect(fs.readFile(path.join(target, "catalog", "autovault-sync.json"), "utf-8")).resolves.toContain(
      '"skills": []'
    );
  });

  it("fails instead of treating an unreadable published-skill directory as empty", async () => {
    await install("alpha");
    const target = await makeTarget(registry);
    const skillsRoot = path.join(target, "skills");
    await fs.mkdir(path.join(skillsRoot, "alpha"), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, "alpha", "story.md"), "# Alpha story\n");
    await fs.chmod(skillsRoot, 0o300);

    try {
      await expect(planPublishSync(target)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await fs.chmod(skillsRoot, 0o755);
    }
  });
});
