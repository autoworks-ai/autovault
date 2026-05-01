import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { syncProfiles } from "../src/profiles/sync.js";
import { ensureStorage, writeSkill } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

const skill = (name: string, agents?: string[]): string => `---
name: ${name}
description: ${name} test skill with enough description text.
${agents ? `agents: [${agents.join(", ")}]\n` : ""}metadata:
  version: "1.0.0"
---

# ${name}
`;

describe("profile sync", () => {
  it("generates per-agent symlinks and preserves unrelated external skills", async () => {
    await ensureStorage();
    await writeSkill("shared-skill", skill("shared-skill", ["claude-code", "codex"]));
    await writeSkill("claude-only", skill("claude-only", ["claude-code"]));
    await writeSkill("hidden-skill", skill("hidden-skill"));

    const externalRoot = path.join(currentStorageRoot(), "external-claude-skills");
    await fs.mkdir(path.join(externalRoot, "system-skill"), { recursive: true });

    const result = await syncProfiles({
      profileRoots: {
        "claude-code": externalRoot
      }
    });

    expect(result.profiles["claude-code"]).toEqual(["claude-only", "shared-skill"]);
    expect(result.profiles.codex).toEqual(["shared-skill"]);
    expect(result.warnings.join("\n")).toContain("hidden-skill");

    const profileLink = await fs.readlink(path.join(currentStorageRoot(), "profiles", "claude-code", "shared-skill"));
    expect(path.basename(profileLink)).toBe("shared-skill");

    const externalLink = await fs.readlink(path.join(externalRoot, "shared-skill"));
    expect(externalLink).toContain(path.join("profiles", "claude-code", "shared-skill"));

    await expect(fs.stat(path.join(externalRoot, "system-skill"))).resolves.toBeTruthy();
  });

  it("refuses to overwrite non-symlink external skill conflicts", async () => {
    await ensureStorage();
    await writeSkill("conflict", skill("conflict", ["claude-code"]));

    const externalRoot = path.join(currentStorageRoot(), "external-conflict");
    await fs.mkdir(path.join(externalRoot, "conflict"), { recursive: true });

    await expect(syncProfiles({ profileRoots: { "claude-code": externalRoot } })).rejects.toThrow(
      /Refusing to replace non-symlink path/
    );
  });
});
