import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { proposeSkill } from "../src/tools/propose-skill.js";
import { readSkill } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

const skillMd = (
  name: string,
  options: { agents?: string[]; resources?: string[]; description?: string } = {}
): string => `---
name: ${name}
description: ${options.description ?? "A description that is intentionally long enough to satisfy schema checks."}
${options.agents ? `agents: [${options.agents.join(", ")}]\n` : ""}metadata:
  version: "1.0.0"
${options.resources && options.resources.length > 0
  ? `resources:\n${options.resources.map((resource) => `  - path: ${resource}\n    type: file`).join("\n")}\n`
  : ""}---

# ${name}
`;

async function writeBundle(
  root: string,
  name: string,
  input: { skillMd: string; resources?: Record<string, string> }
): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), input.skillMd, "utf-8");
  for (const [resourcePath, content] of Object.entries(input.resources ?? {})) {
    const target = path.join(dir, resourcePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  }
}

describe("bulkImport", () => {
  it("imports child skill bundles with synthesis, aggregation, and one final sync", async () => {
    const loaded = await import("../src/tools/bulk-import.js").catch((error) => ({ error }));
    expect("error" in loaded, String((loaded as { error?: unknown }).error)).toBe(false);
    const { bulkImport } = loaded as typeof import("../src/tools/bulk-import.js");

    await proposeSkill({ skill_md: skillMd("already-installed", { agents: ["codex"] }) });

    const sourceDir = path.join(currentStorageRoot(), "bulk-source");
    await writeBundle(sourceDir, "accepted-one", {
      skillMd: skillMd("accepted-one"),
      resources: { "docs/guide.md": "Guide" }
    });
    await writeBundle(sourceDir, "accepted-one-copy", {
      skillMd: skillMd("accepted-one"),
      resources: { "docs/guide.md": "Guide" }
    });
    await writeBundle(sourceDir, "already-installed", {
      skillMd: skillMd("already-installed", { agents: ["codex"] })
    });
    await writeBundle(sourceDir, "invalid-one", {
      skillMd: skillMd("invalid-one", { description: "too short" })
    });
    await fs.mkdir(path.join(sourceDir, "not-a-skill"), { recursive: true });

    const profileRoot = path.join(currentStorageRoot(), "bulk-codex-profile");
    const result = await bulkImport({
      source_dir: sourceDir,
      agents: ["codex"],
      profile_roots: { codex: profileRoot }
    });

    expect(result).toMatchObject({
      success: false,
      summary: {
        accepted: 1,
        duplicate: 2,
        invalid: 1,
        skipped: 1,
        total: 5
      },
      imported: [
        expect.objectContaining({
          name: "accepted-one",
          inferred_agents: ["codex"],
          inferred_resources: [{ path: "docs/guide.md", type: "file" }]
        })
      ],
      duplicates: [
        expect.objectContaining({ name: "accepted-one" }),
        expect.objectContaining({ name: "already-installed" })
      ],
      invalid: [expect.objectContaining({ name: "invalid-one" })],
      skipped: [expect.objectContaining({ directory: "not-a-skill" })],
      sync: {
        profiles: { codex: 2 },
        linkedRoots: { codex: profileRoot },
        warningCount: 0
      }
    });
    expect((result.sync as Record<string, unknown>)).not.toHaveProperty("profileStatus");

    const stored = await readSkill("accepted-one");
    expect(stored?.agents).toEqual(["codex"]);
    expect(stored?.resources).toEqual([{ path: "docs/guide.md", type: "file" }]);
    await expect(fs.readlink(path.join(profileRoot, "accepted-one"))).resolves.toContain(
      path.join("profiles", "codex", "accepted-one")
    );
  });

  it("returns full sync detail when verbose is requested", async () => {
    const loaded = await import("../src/tools/bulk-import.js").catch((error) => ({ error }));
    expect("error" in loaded, String((loaded as { error?: unknown }).error)).toBe(false);
    const { bulkImport } = loaded as typeof import("../src/tools/bulk-import.js");

    const sourceDir = path.join(currentStorageRoot(), "bulk-source-verbose");
    await writeBundle(sourceDir, "verbose-imported", {
      skillMd: skillMd("verbose-imported", { agents: ["codex"] })
    });

    const profileRoot = path.join(currentStorageRoot(), "bulk-codex-profile-verbose");
    const result = await bulkImport({
      source_dir: sourceDir,
      profile_roots: { codex: profileRoot },
      verbose: true
    });

    expect(result).toMatchObject({
      success: true,
      sync: {
        profiles: { codex: ["verbose-imported"] },
        linkedRoots: { codex: profileRoot },
        profileStatus: {
          codex: [expect.objectContaining({ name: "verbose-imported" })]
        }
      }
    });
  });
});
