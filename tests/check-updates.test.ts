import { describe, expect, it, vi } from "vitest";
import { installSkill } from "../src/tools/install-skill.js";
import { checkUpdates } from "../src/tools/check-updates.js";

const skillMd = `---
name: drift-skill
description: A description that is intentionally long enough to satisfy the schema length check.
metadata:
  version: "1.0.0"
---

# Body
`;

const skillMdV2 = skillMd.replace("# Body", "# Body v2");

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
  });

  it("treats inline skills as up_to_date", async () => {
    await installSkill({
      source: "url",
      identifier: "https://example.com/x",
      skill_md: skillMd
    });
    const result = await checkUpdates();
    expect(result.up_to_date).toContain("drift-skill");
  });
});
