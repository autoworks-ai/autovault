import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { syncProfiles } from "../src/profiles/sync.js";
import { skillDir, writeSkill } from "../src/storage/index.js";
import {
  listSkillTransforms,
  removeSkillTransform,
  renderSkillForAgent,
  skillTransformDir
} from "../src/transforms/index.js";
import { getSkill } from "../src/tools/get-skill.js";
import { checkUpdates } from "../src/tools/check-updates.js";
import { listSkillTransformsTool } from "../src/tools/list-skill-transforms.js";
import { proposeSkillTransformTool } from "../src/tools/propose-skill-transform.js";
import { removeSkillTransformTool } from "../src/tools/remove-skill-transform.js";
import { parseFrontmatter } from "../src/validation/frontmatter.js";
import { currentStorageRoot } from "./setup.js";

const baseSkill = (name: string, agents: string[] = ["codex"], version = "1.0.0"): string => `---
name: ${name}
description: ${name} base skill with enough description text.
tags: [demo, transform]
agents: [${agents.join(", ")}]
metadata:
  version: "${version}"
capabilities:
  network: false
  filesystem: readonly
  tools: [Bash, web_search]
resources:
  - path: references/info.md
    type: file
---

# ${name} Base ${version}

Use web_search when research is needed.
`;

const transformMd = (name: string, base: string, body: string, extra = ""): string => `---
name: ${name}
base: ${base}
description: ${name} transform with enough description text.
targets:
  agents: [codex]
priority: 100
capability_overrides:
  network: true
  tools:
    add: [mcp__perplexity__search]
    remove: [web_search]
metadata:
  version: "1.0.0"
${extra}---

${body}
`;

async function writeBase(name: string, agents: string[] = ["codex"], version = "1.0.0"): Promise<void> {
  await writeSkill(name, baseSkill(name, agents, version), [
    { path: "references/info.md", content: `# ${name} reference\n` }
  ]);
}

function renderedSkillPath(agent: string, name: string): string {
  return path.join(currentStorageRoot(), "rendered", agent, name, "SKILL.md");
}

describe("skill transforms", () => {
  it("renders targeted profile variants without mutating the upstream skill", async () => {
    await writeBase("research-skill", ["codex", "claude-code"]);

    const proposed = await proposeSkillTransformTool({
      transform_md: transformMd(
        "perplexity",
        "research-skill",
        "Use mcp__perplexity__search instead of web_search for all research."
      )
    });

    expect(proposed.outcome).toBe("accepted");

    const codexLink = path.join(currentStorageRoot(), "profiles", "codex", "research-skill");
    const claudeLink = path.join(currentStorageRoot(), "profiles", "claude-code", "research-skill");
    const codexTarget = await fs.realpath(codexLink);
    const claudeTarget = await fs.realpath(claudeLink);

    expect(codexTarget).toContain(path.join("rendered", "codex", "research-skill"));
    expect(claudeTarget).toBe(await fs.realpath(skillDir("research-skill")));

    const rendered = await fs.readFile(path.join(codexTarget, "SKILL.md"), "utf-8");
    expect(rendered).toContain("## AutoVault Transform Overlays");
    expect(rendered).toContain("mcp__perplexity__search");
    await expect(fs.readFile(path.join(codexTarget, "references", "info.md"), "utf-8")).resolves.toContain(
      "research-skill reference"
    );

    const upstream = await fs.readFile(path.join(skillDir("research-skill"), "SKILL.md"), "utf-8");
    expect(upstream).not.toContain("AutoVault Transform Overlays");
    expect(upstream).toContain("web_search");
  });

  it("composes multiple transforms by priority and applies capability overrides", async () => {
    await writeBase("ordered-skill");
    await proposeSkillTransformTool({
      transform_md: `---
name: high
base: ordered-skill
description: High priority transform with enough text.
targets:
  agents: [codex]
priority: 100
capability_overrides:
  tools:
    add: [high_tool]
    remove: [web_search]
---

High priority instruction.
`
    });
    await proposeSkillTransformTool({
      transform_md: `---
name: low
base: ordered-skill
description: Low priority transform with enough text.
targets:
  agents: [codex]
priority: 10
capability_overrides:
  network: true
  tools:
    add: [low_tool]
---

Low priority instruction.
`
    });

    const rendered = await renderSkillForAgent("ordered-skill", "codex");
    expect(rendered.skill_md.indexOf("Low priority instruction")).toBeLessThan(
      rendered.skill_md.indexOf("High priority instruction")
    );

    const { data } = parseFrontmatter(rendered.skill_md);
    const capabilities = data.capabilities as { network: boolean; tools: string[] };
    expect(capabilities.network).toBe(true);
    expect(capabilities.tools).toContain("Bash");
    expect(capabilities.tools).toContain("low_tool");
    expect(capabilities.tools).toContain("high_tool");
    expect(capabilities.tools).not.toContain("web_search");
  });

  it("rejects transforms whose generated skill violates capability declarations", async () => {
    await writeBase("invalid-transform-skill");

    const result = await proposeSkillTransformTool({
      transform_md: `---
name: unsafe
base: invalid-transform-skill
description: Unsafe transform with enough description text.
targets:
  agents: [codex]
priority: 1
---

Run curl https://example.com before doing the work.
`
    });

    expect(result.outcome).toBe("invalid");
    expect(JSON.stringify(result)).toContain("capabilities.network=false");
  });

  it("reports transform reviews when the pinned base skill changes", async () => {
    await writeBase("drift-transform-skill", ["codex"], "1.0.0");
    await proposeSkillTransformTool({
      transform_md: transformMd(
        "perplexity",
        "drift-transform-skill",
        "Use mcp__perplexity__search instead of web_search."
      )
    });

    await writeBase("drift-transform-skill", ["codex"], "2.0.0");

    const result = await checkUpdates("drift-transform-skill");
    expect(result.transform_reviews).toHaveLength(1);
    expect(result.transform_reviews[0]).toMatchObject({
      base: "drift-transform-skill",
      transform: "perplexity",
      reason: "base_skill_changed",
      pinned_base_version: "1.0.0",
      current_base_version: "2.0.0"
    });
    expect(result.transform_reviews[0].pinned_skill_md).toContain("Base 1.0.0");
  });

  it("detects tampered transform files and skips them during rendering", async () => {
    await writeBase("tamper-transform-skill");
    await proposeSkillTransformTool({
      transform_md: transformMd(
        "perplexity",
        "tamper-transform-skill",
        "Use mcp__perplexity__search instead of web_search."
      )
    });

    await fs.writeFile(
      path.join(skillTransformDir("tamper-transform-skill", "perplexity"), "TRANSFORM.md"),
      transformMd(
        "perplexity",
        "tamper-transform-skill",
        "Tampered instructions should not be trusted."
      ),
      "utf-8"
    );

    const listed = await listSkillTransforms({ base: "tamper-transform-skill" });
    expect(listed.transforms).toHaveLength(1);
    expect(listed.transforms[0]).toMatchObject({ status: "tampered" });

    const rendered = await renderSkillForAgent("tamper-transform-skill", "codex");
    expect(rendered.applied_transforms).toHaveLength(0);
    expect(rendered.skill_md).not.toContain("AutoVault Transform Overlays");
    expect(rendered.warnings.join("\n")).toContain("Skipping tampered transform");
  });

  it("removes transforms and cleans generated render directories on the next sync", async () => {
    await writeBase("remove-transform-skill");
    await proposeSkillTransformTool({
      transform_md: transformMd(
        "perplexity",
        "remove-transform-skill",
        "Use mcp__perplexity__search instead of web_search."
      )
    });

    await expect(fs.readFile(renderedSkillPath("codex", "remove-transform-skill"), "utf-8")).resolves.toContain(
      "AutoVault Transform Overlays"
    );

    const removed = await removeSkillTransform({
      base: "remove-transform-skill",
      name: "perplexity"
    });
    expect(removed.removed).toBe(true);
    await syncProfiles();

    const link = path.join(currentStorageRoot(), "profiles", "codex", "remove-transform-skill");
    expect(await fs.realpath(link)).toBe(await fs.realpath(skillDir("remove-transform-skill")));
    await expect(fs.lstat(path.join(currentStorageRoot(), "rendered", "codex", "remove-transform-skill"))).rejects.toThrow();
  });

  it("exposes transformed get_skill output and MCP-style transform tools", async () => {
    await writeBase("tool-transform-skill");
    const proposed = await proposeSkillTransformTool({
      transform_md: transformMd(
        "perplexity",
        "tool-transform-skill",
        "Use mcp__perplexity__search instead of web_search."
      )
    });
    expect(proposed.outcome).toBe("accepted");

    const listed = await listSkillTransformsTool("tool-transform-skill");
    expect((listed.transforms as Array<{ name: string }>).map((entry) => entry.name)).toContain("perplexity");

    const pristine = await getSkill("tool-transform-skill");
    expect(String(pristine.skill_md)).not.toContain("AutoVault Transform Overlays");

    const transformed = await getSkill("tool-transform-skill", "codex");
    expect(String(transformed.skill_md)).toContain("AutoVault Transform Overlays");
    expect(transformed.applied_transforms).toEqual([
      expect.objectContaining({ name: "perplexity" })
    ]);

    const removed = await removeSkillTransformTool({
      base: "tool-transform-skill",
      name: "perplexity"
    });
    expect(removed.removed).toBe(true);
  });
});
