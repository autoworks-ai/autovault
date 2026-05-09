import { describe, expect, it } from "vitest";
import { listSkills } from "../src/tools/list-skills.js";
import { searchSkills } from "../src/tools/search-skills.js";
import { getSkill } from "../src/tools/get-skill.js";
import { writeSkill } from "../src/storage/index.js";

const md = (name: string, extra = "") => `---
name: ${name}
description: A description that is intentionally long enough to satisfy the schema length checks for ${name}.
${extra.includes("tags:") ? "" : `tags:
  - alpha
`}
${extra}capabilities:
  network: false
  filesystem: readonly
  tools: [Bash]
requires-secrets:
  - name: EXAMPLE_TOKEN
    description: Example token for test coverage
    required: false
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
      expect(skill.requires_tools).toEqual(["Bash"]);
      expect(skill.requires_secrets[0]?.name).toBe("EXAMPLE_TOKEN");
      expect(skill.capabilities.filesystem).toBe("readonly");
    }
  });

  it("listSkills includes optional discovery metadata when present", async () => {
    await writeSkill("metadata-rich", md("metadata-rich", `title: Metadata Rich Skill
category: discovery
when_to_use: Use when searching for skills by intent before loading full instructions.
when_not_to_use: Do not use when exact skill names are already known.
risk_level: low
`));
    const result = await listSkills();
    expect(result.skills[0]).toMatchObject({
      name: "metadata-rich",
      title: "Metadata Rich Skill",
      category: "discovery",
      when_to_use: "Use when searching for skills by intent before loading full instructions.",
      when_not_to_use: "Do not use when exact skill names are already known.",
      risk_level: "low"
    });
  });

  it("searchSkills ranks by query against parsed metadata", async () => {
    await writeSkill("alpha-skill", md("alpha-skill"));
    await writeSkill("beta-skill", md("beta-skill"));
    const result = await searchSkills("alpha");
    expect(result.matches[0]?.name).toBe("alpha-skill");
    expect(result.matches[0]?.reason).toMatch(/matched/);
    expect(result.matches[0]?.search_type).toBe("metadata_text");
    expect(result.matches[0]?.reasons.map((reason) => reason.kind)).toContain("name_match");
  });

  it("searchSkills explains tag and description metadata matches", async () => {
    await writeSkill("cloudflare-worker", md("cloudflare-worker", `tags:
  - cloudflare
  - d1
category: deployment
when_to_use: Use when deploying a Worker backed by D1 storage.
`));
    const result = await searchSkills("deploy worker with D1");
    expect(result.matches[0]?.name).toBe("cloudflare-worker");
    expect(result.matches[0]?.reasons.map((reason) => reason.kind)).toEqual(
      expect.arrayContaining(["tag_match", "description_match"])
    );
    expect(result.matches[0]?.reason).toContain("matched tags");
  });

  it("searchSkills returns empty matches for unrelated queries", async () => {
    const result = await searchSkills("totallyunrelatedquery");
    expect(result.matches).toHaveLength(0);
  });

  it("getSkill returns the full record plus source metadata when available", async () => {
    await writeSkill("alpha-skill", md("alpha-skill"), [], {
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

  it("getSkill can inline packaged resources when requested", async () => {
    await writeSkill("resource-skill", `---
name: resource-skill
description: A description that is intentionally long enough to satisfy the schema length checks for resource-skill.
metadata:
  version: "0.0.1"
resources:
  - path: references/guide.md
---

# Body
`, [
      { path: "references/guide.md", content: "# guide\n" }
    ]);
    const skill = await getSkill("resource-skill", undefined, { includeResources: true });
    expect(skill.resource_contents).toEqual([
      {
        path: "references/guide.md",
        content: "# guide\n",
        mime_type: "text/markdown"
      }
    ]);
  });

  it("getSkill throws when the skill does not exist", async () => {
    await expect(getSkill("missing-skill")).rejects.toThrow(/not found/);
  });

  it("gold discovery queries find expected skill fixtures", async () => {
    await writeSkill("parallel-task-batch", md("parallel-task-batch", `tags:
  - parallel
  - pull-request
category: orchestration
when_to_use: Use to run several agents in parallel and merge their PRs after review.
`));
    await writeSkill("copilot-review", md("copilot-review", `tags:
  - copilot
  - pull-request
category: review
when_to_use: Use to fix Copilot comments on a PR and resolve review threads.
`));
    await writeSkill("cloudflare-ops", md("cloudflare-ops", `tags:
  - cloudflare
  - d1
  - worker
category: deployment
when_to_use: Use to deploy a Worker with D1 storage on Cloudflare.
`));

    expect((await searchSkills("run several agents in parallel and merge their PRs")).matches[0]?.name).toBe(
      "parallel-task-batch"
    );
    expect((await searchSkills("fix Copilot comments on a PR")).matches[0]?.name).toBe("copilot-review");
    expect((await searchSkills("deploy a worker with D1")).matches[0]?.name).toBe("cloudflare-ops");
  });
});
