import { describe, expect, it } from "vitest";
import { listSkills } from "../src/tools/list-skills.js";
import { searchSkills } from "../src/tools/search-skills.js";
import { getSkill } from "../src/tools/get-skill.js";
import { writeSkill, writeSkillSource } from "../src/storage/index.js";

const md = (name: string) => `---
name: ${name}
description: A description that is intentionally long enough to satisfy the schema length checks for ${name}.
tags:
  - alpha
metadata:
  version: "0.0.1"
---

# Body
`;

describe("list/search/get tools", () => {
  it("listSkills returns parsed metadata from frontmatter", async () => {
    await writeSkill("alpha-skill", md("alpha-skill"));
    await writeSkill("beta-skill", md("beta-skill"));
    const result = await listSkills();
    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(["alpha-skill", "beta-skill"]);
    for (const skill of result.skills) {
      expect(skill.description).toMatch(/long enough/);
      expect(skill.tags).toEqual(["alpha"]);
      expect(skill.version).toBe("0.0.1");
    }
  });

  it("searchSkills ranks by query against parsed metadata", async () => {
    await writeSkill("alpha-skill", md("alpha-skill"));
    await writeSkill("beta-skill", md("beta-skill"));
    const result = await searchSkills("alpha");
    expect(result.matches[0]?.name).toBe("alpha-skill");
    expect(result.matches[0]?.reason).toMatch(/Text match/);
  });

  it("searchSkills returns empty matches for unrelated queries", async () => {
    const result = await searchSkills("totallyunrelatedquery");
    expect(result.matches).toHaveLength(0);
  });

  it("getSkill returns the full record plus source metadata when available", async () => {
    await writeSkill("alpha-skill", md("alpha-skill"));
    await writeSkillSource("alpha-skill", {
      source: "github",
      identifier: "owner/repo",
      fetchedAt: new Date().toISOString(),
      contentHash: "deadbeef"
    });
    const skill = await getSkill("alpha-skill");
    expect(skill.name).toBe("alpha-skill");
    expect(skill.skill_md).toMatch(/Body/);
    expect((skill.source as { source: string }).source).toBe("github");
  });

  it("getSkill throws when the skill does not exist", async () => {
    await expect(getSkill("missing-skill")).rejects.toThrow(/not found/);
  });
});
