import { describe, expect, it } from "vitest";
import {
  ensureStorage,
  listInstalledSkillNames,
  readSkill,
  readSkillSource,
  writeSkill,
  writeSkillResources,
  writeSkillSource
} from "../src/storage/index.js";

const skillMd = `---
name: parsed-skill
description: A real description that is sufficiently long to satisfy schema length checks.
tags:
  - alpha
  - beta
category: utility
metadata:
  version: "2.3.4"
capabilities:
  network: true
  filesystem: readwrite
  tools:
    - Bash
requires-secrets:
  - name: API_KEY
    description: Example secret
    required: true
---

# Body
`;

describe("storage", () => {
  it("parses real frontmatter when reading a skill", async () => {
    await ensureStorage();
    await writeSkill("parsed-skill", skillMd);
    const skill = await readSkill("parsed-skill");
    expect(skill).not.toBeNull();
    expect(skill!.description).toMatch(/real description/);
    expect(skill!.version).toBe("2.3.4");
    expect(skill!.tags).toEqual(["alpha", "beta"]);
    expect(skill!.category).toBe("utility");
    expect(skill!.capabilities).toEqual({
      network: true,
      filesystem: "readwrite",
      tools: ["Bash"]
    });
    expect(skill!.requiresSecrets).toEqual([
      { name: "API_KEY", description: "Example secret", required: true }
    ]);
  });

  it("lists installed skill names", async () => {
    await writeSkill("alpha", skillMd.replace("parsed-skill", "alpha"));
    await writeSkill("beta", skillMd.replace("parsed-skill", "beta"));
    const names = await listInstalledSkillNames();
    expect(names.sort()).toEqual(["alpha", "beta"]);
  });

  it("writes resources safely and rejects traversal", async () => {
    await writeSkill("res-skill", skillMd.replace("parsed-skill", "res-skill"));
    await writeSkillResources("res-skill", [
      { path: "scripts/hello.sh", content: "echo hi" }
    ]);
    await expect(
      writeSkillResources("res-skill", [{ path: "../escape.txt", content: "x" }])
    ).rejects.toThrow();
    await expect(
      writeSkillResources("res-skill", [{ path: "/etc/passwd", content: "x" }])
    ).rejects.toThrow();
  });

  it("round-trips skill source metadata", async () => {
    await writeSkill("src-skill", skillMd.replace("parsed-skill", "src-skill"));
    await writeSkillSource("src-skill", {
      source: "github",
      identifier: "owner/repo",
      fetchedAt: new Date().toISOString(),
      contentHash: "abc"
    });
    const source = await readSkillSource("src-skill");
    expect(source?.source).toBe("github");
    expect(source?.contentHash).toBe("abc");
  });
});
