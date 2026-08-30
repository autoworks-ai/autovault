import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanPluginShadows } from "../src/doctor/plugin-shadows.js";
import { currentStorageRoot } from "./setup.js";

const skillMd = (name: string) => `---
name: ${name}
description: A plugin cache skill used to exercise bounded doctor scans.
metadata:
  version: "1.0.0"
---

# ${name}
`;

async function writePluginSkill(root: string, plugin: string, name: string): Promise<string> {
  const dir = path.join(root, plugin, "skills", name);
  await fs.mkdir(dir, { recursive: true });
  const skillPath = path.join(dir, "SKILL.md");
  await fs.writeFile(skillPath, skillMd(name), "utf-8");
  return skillPath;
}

describe("plugin shadow scan", () => {
  it("marks cached collisions as advisory evidence and reports a file-limit truncation", async () => {
    const root = path.join(currentStorageRoot(), "cursor-cache");
    const first = await writePluginSkill(root, "plugin-a/1", "first-collision");
    await writePluginSkill(root, "plugin-b/1", "second-collision");

    const scan = await scanPluginShadows(["first-collision", "second-collision"], {
      roots: [{ host: "cursor", root }],
      limits: { maxSkillFiles: 1 }
    });

    expect(scan).toMatchObject({
      scanned_skill_files: 1,
      incomplete: true,
      truncation_reasons: ["skill_file_limit"],
      shadows: {
        "first-collision": [
          {
            category: "plugin-shadowed",
            evidence: "cached_collision",
            advisory: true,
            host: "cursor",
            skill_md_path: first
          }
        ]
      }
    });
    expect(scan.shadows["second-collision"]).toBeUndefined();
  });

  it("reports depth and size caps without reading unsafe cache entries", async () => {
    const root = path.join(currentStorageRoot(), "bounded-cache");
    await writePluginSkill(root, "deep-plugin/1", "deep-collision");
    const oversized = await writePluginSkill(root, "large-plugin/1", "large-collision");
    await fs.appendFile(oversized, "x".repeat(1_024), "utf-8");

    const depthLimited = await scanPluginShadows(["deep-collision"], {
      roots: [{ host: "cursor", root }],
      limits: { maxDepth: 0 }
    });
    expect(depthLimited).toMatchObject({
      incomplete: true,
      truncation_reasons: ["depth_limit"],
      shadows: {}
    });

    const sizeLimited = await scanPluginShadows(["large-collision"], {
      roots: [{ host: "cursor", root }],
      limits: { maxSkillBytes: 32 }
    });
    expect(sizeLimited).toMatchObject({
      incomplete: true,
      truncation_reasons: ["skill_file_size_limit"],
      shadows: {}
    });
  });

  it("does not follow a plugin-cache root symlink", async () => {
    const externalRoot = path.join(currentStorageRoot(), "external-cache");
    await writePluginSkill(externalRoot, "external-plugin/1", "external-collision");
    const cacheAlias = path.join(currentStorageRoot(), "cache-alias");
    await fs.symlink(externalRoot, cacheAlias, "dir");

    const scan = await scanPluginShadows(["external-collision"], {
      roots: [{ host: "cursor", root: cacheAlias }]
    });

    expect(scan).toMatchObject({
      shadows: {},
      scanned_skill_files: 0,
      incomplete: false
    });
  });

  it("reports inaccessible existing directories while ignoring missing cache roots", async () => {
    const root = path.join(currentStorageRoot(), "read-error-cache");
    const inaccessible = path.join(root, "inaccessible");
    await fs.mkdir(inaccessible, { recursive: true });
    const originalReaddir = fs.readdir.bind(fs);
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(
      ((directory: string, options: { withFileTypes: true }) => {
        if (directory === inaccessible) {
          const error = new Error("permission denied");
          Object.assign(error, { code: "EACCES" });
          return Promise.reject(error);
        }
        return originalReaddir(directory, options);
      }) as unknown as typeof fs.readdir
    );

    try {
      const inaccessibleScan = await scanPluginShadows(["unreachable-skill"], {
        roots: [{ host: "cursor", root }]
      });
      expect(inaccessibleScan).toMatchObject({
        incomplete: true,
        truncation_reasons: ["directory_read_error"],
        shadows: {}
      });

      const missingScan = await scanPluginShadows(["unreachable-skill"], {
        roots: [{ host: "cursor", root: path.join(currentStorageRoot(), "missing-cache") }]
      });
      expect(missingScan).toMatchObject({
        incomplete: false,
        truncation_reasons: [],
        shadows: {}
      });
    } finally {
      readdirSpy.mockRestore();
    }
  });
});
