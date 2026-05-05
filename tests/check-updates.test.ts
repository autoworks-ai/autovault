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
      identifier: "drift-skill",
      bundled_skill_name: "drift-skill",
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
      identifier: "drift-skill",
      bundled_skill_name: "drift-skill",
      skill_md: skillMd
    });
    const result = await checkUpdates(undefined, { bundledSkillsDir });
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0]).toMatchObject({
      name: "drift-skill",
      source: "inline",
      identifier: "drift-skill",
      reason: "bundled content hash changed"
    });
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports drift when only a fetched resource changes, not SKILL.md", async () => {
    const skillWithBin = `---
name: drift-skill
description: A description that is intentionally long enough to satisfy the schema length check.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
---

# Body
`;
    const installFetcher = vi.fn().mockResolvedValue({
      skillMd: skillWithBin,
      sourceUrl: "https://x",
      upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resources: [{ path: "bin/setup", content: "#!/usr/bin/env bash\necho v1\n" }]
    });
    const installResult = await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: installFetcher } }
    );
    expect(installResult.success).toBe(true);

    // Upstream now serves identical SKILL.md but a patched bin/setup.
    const checkFetcher = vi.fn().mockResolvedValue({
      skillMd: skillWithBin,
      sourceUrl: "https://x",
      upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resources: [{ path: "bin/setup", content: "#!/usr/bin/env bash\necho v2\n" }]
    });
    const result = await checkUpdates(undefined, { fetchers: { github: checkFetcher } });
    expect(result.drifted.map((d) => d.name)).toContain("drift-skill");
    expect(result.drifted[0].reason).toBe("content hash changed");
  });

  it("treats remote SKILL.md as up_to_date when only repairable whitespace differs (round-53)", async () => {
    // Round 53 finding: install_skill records contentHash from
    // bundleHash(normalizedSkillMd, resources) where normalizedSkillMd is the
    // output of attemptRepair (tabs → 2 spaces, trailing whitespace stripped).
    // The remote drift path used to hash raw `fetched.skillMd`. So any GitHub/
    // URL/agentskills upstream whose SKILL.md needed repair would install
    // fine, then permanently report `content hash changed` even though the
    // upstream content was unchanged byte-for-byte vs install. The fix runs
    // attemptRepair on the fetched SKILL.md before hashing — same shape as
    // install — so install-time and check-time hashes agree.
    //
    // This test pins the guarantee: install with a SKILL.md that has trailing
    // whitespace (which attemptRepair strips), then check_updates with the
    // exact same upstream bytes. Without the fix, drift fires (raw bytes
    // differ from the repaired-and-hashed install record). With the fix,
    // up_to_date.
    // Embed a tab indent (attemptRepair turns tabs into 2 spaces) and a
    // trailing space on the body line (attemptRepair strips it). Either
    // mutation alone is enough to make the raw bytes differ from the
    // repaired bytes the install hashes.
    const repairable =
      "---\n" +
      "name: drift-skill\n" +
      "description: A description that is intentionally long enough to satisfy the schema length check.\n" +
      "metadata:\n" +
      "\tversion: \"1.0.0\"\n" +
      "---\n" +
      "\n" +
      "# Body \n";
    const fetcher = vi.fn().mockResolvedValue({
      skillMd: repairable,
      sourceUrl: "https://x",
      upstreamSha: "cccccccccccccccccccccccccccccccccccccccc"
    });
    const installResult = await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );
    expect(installResult.success).toBe(true);

    // Same upstream bytes, same SHA — nothing actually changed.
    const checkResult = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(checkResult.up_to_date).toContain("drift-skill");
    expect(checkResult.drifted).toHaveLength(0);
    expect(checkResult.unchecked).toHaveLength(0);
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
