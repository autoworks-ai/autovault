import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installSkill } from "../src/tools/install-skill.js";
import { checkUpdates } from "../src/tools/check-updates.js";
import { currentStorageRoot } from "./setup.js";

const skillMd = `---
name: drift-skill
description: A description that is intentionally long enough to satisfy the schema length check.
metadata:
  version: "1.0.0"
---

# Body
`;

const skillMdV2 = skillMd.replace("# Body", "# Body v2");

async function writeBundledSkill(name: string, body: string): Promise<string> {
  const bundledRoot = path.join(currentStorageRoot(), "bundled-skills");
  await fs.mkdir(path.join(bundledRoot, name), { recursive: true });
  await fs.writeFile(path.join(bundledRoot, name, "SKILL.md"), body, "utf-8");
  return bundledRoot;
}

describe("checkUpdates", () => {
  it("reports up_to_date when upstream content is unchanged", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );
    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.up_to_date).toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports drift when content hash changes upstream", async () => {
    const installFetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: installFetcher } }
    );
    const checkFetcher = vi.fn().mockResolvedValue({
      skillMd: skillMdV2,
      sourceUrl: "https://x",
      upstreamSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    const result = await checkUpdates(undefined, { fetchers: { github: checkFetcher } });
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].name).toBe("drift-skill");
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports bundled inline skills as up_to_date when repo content matches", async () => {
    const bundledSkillsDir = await writeBundledSkill("drift-skill", skillMd);
    await installSkill({
      source: "url",
      identifier: "bundled:drift-skill",
      skill_md: skillMd
    });
    const result = await checkUpdates(undefined, { bundledSkillsDir });
    expect(result.up_to_date).toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports drift when bundled inline repo content changes", async () => {
    const bundledSkillsDir = await writeBundledSkill("drift-skill", skillMdV2);
    await installSkill({
      source: "url",
      identifier: "bundled:drift-skill",
      skill_md: skillMd
    });
    const result = await checkUpdates(undefined, { bundledSkillsDir });
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0]).toMatchObject({
      name: "drift-skill",
      source: "inline",
      identifier: "bundled:drift-skill",
      reason: "bundled content hash changed"
    });
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports non-bundled inline skills as unchecked", async () => {
    await installSkill({
      source: "url",
      identifier: "https://example.com/x",
      skill_md: skillMd
    });
    const result = await checkUpdates();
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.unchecked).toEqual([
      {
        name: "drift-skill",
        source: "inline",
        identifier: "https://example.com/x",
        reason: "inline skill has no checkable upstream"
      }
    ]);
  });
});
