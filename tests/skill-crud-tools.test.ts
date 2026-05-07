import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addSkill } from "../src/tools/add-skill.js";
import { deleteSkill } from "../src/tools/delete-skill.js";
import { getSkill } from "../src/tools/get-skill.js";
import { updateSkill } from "../src/tools/update-skill.js";
import { readSkill, readSkillSource } from "../src/storage/index.js";
import { MAX_SKILL_MD_BYTES } from "../src/util/limits.js";
import { currentStorageRoot } from "./setup.js";

const skillMd = (name: string, body = "Body"): string => `---
name: ${name}
description: A description that is intentionally long enough to satisfy schema checks.
metadata:
  version: "1.0.0"
---

# ${body}
`;

async function writeLocalBundle(dir: string, name: string, body = "Body"): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMd(name, body), "utf-8");
}

describe("skill CRUD MCP tool handlers", () => {
  it("adds local skills using the CLI-shaped source fields", async () => {
    const bundle = path.join(currentStorageRoot(), "local-add");
    await writeLocalBundle(bundle, "local-add-skill");

    const result = await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: bundle
    });

    expect(result).toMatchObject({ success: true, name: "local-add-skill" });
    const source = await readSkillSource("local-add-skill");
    expect(source).toMatchObject({ source: "local", identifier: "vendor/repo" });
  });

  it("updates an existing skill from explicit inline bytes and refuses name drift", async () => {
    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await localBundle("update-inline-skill", "Before")
    });

    const updated = await updateSkill({
      name: "update-inline-skill",
      source: "inline",
      skill_md: skillMd("update-inline-skill", "After")
    });
    expect(updated).toMatchObject({ success: true, name: "update-inline-skill" });
    await expect(getSkill("update-inline-skill")).resolves.toMatchObject({
      skill_md: expect.stringContaining("# After")
    });

    const mismatch = await updateSkill({
      name: "update-inline-skill",
      source: "inline",
      skill_md: skillMd("wrong-name", "Wrong")
    });
    expect(mismatch).toMatchObject({ success: false, name: "" });
    expect(JSON.stringify(mismatch)).toContain("does not match");

    const ambiguousInline = await updateSkill({
      name: "update-inline-skill",
      skill_md: skillMd("update-inline-skill", "Ambiguous")
    });
    expect(ambiguousInline).toMatchObject({
      success: false,
      name: "update-inline-skill"
    });
    expect(JSON.stringify(ambiguousInline)).toContain("source='inline'");
  });

  it("returns structured failures for malformed local update frontmatter", async () => {
    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await localBundle("malformed-update-skill", "Before")
    });

    const malformed = path.join(currentStorageRoot(), "malformed-update-bundle");
    await fs.mkdir(malformed, { recursive: true });
    await fs.writeFile(
      path.join(malformed, "SKILL.md"),
      `---
name: [unterminated
description: A description that is intentionally long enough to satisfy schema checks.
metadata:
  version: "1.0.0"
---

# Broken
`,
      "utf-8"
    );

    const result = await updateSkill({
      name: "malformed-update-skill",
      source: "local",
      identifier: "vendor/repo",
      skill_dir: malformed
    });
    expect(result).toMatchObject({
      success: false,
      name: "malformed-update-skill",
      validation: {}
    });
    expect(JSON.stringify(result)).toContain("frontmatter could not be parsed");
    await expect(getSkill("malformed-update-skill")).resolves.toMatchObject({
      skill_md: expect.stringContaining("# Before")
    });
  });

  it("returns structured failures for local update bundle limit errors", async () => {
    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await localBundle("oversized-update-skill", "Before")
    });

    const oversized = path.join(currentStorageRoot(), "oversized-update-bundle");
    await fs.mkdir(oversized, { recursive: true });
    await fs.writeFile(
      path.join(oversized, "SKILL.md"),
      "x".repeat(MAX_SKILL_MD_BYTES + 1),
      "utf-8"
    );

    const result = await updateSkill({
      name: "oversized-update-skill",
      source: "local",
      identifier: "vendor/repo",
      skill_dir: oversized
    });
    expect(result).toMatchObject({
      success: false,
      name: "oversized-update-skill",
      validation: {
        valid: false,
        repaired: false,
        errors: [expect.stringContaining("SKILL.md is")]
      }
    });
    await expect(getSkill("oversized-update-skill")).resolves.toMatchObject({
      skill_md: expect.stringContaining("# Before")
    });
  });

  it("returns canonical resource contents paths without duplicates", async () => {
    const bundle = path.join(currentStorageRoot(), "canonical-resource-bundle");
    await fs.mkdir(path.join(bundle, "bin"), { recursive: true });
    await fs.writeFile(
      path.join(bundle, "SKILL.md"),
      `---
name: canonical-resource-skill
description: A description that is intentionally long enough to satisfy schema checks.
metadata:
  version: "1.0.0"
resources:
  - path: ./bin/setup
    type: file
bin:
  setup:
    command: bin/./setup
    args: []
    description: Run setup.
    requires-tty: false
---

# Canonical Resource
`,
      "utf-8"
    );
    await fs.writeFile(path.join(bundle, "bin", "setup"), "echo setup\n", "utf-8");

    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: bundle
    });

    const loaded = await getSkill("canonical-resource-skill", undefined, {
      includeResources: true
    });
    expect(loaded.resource_contents).toEqual([
      expect.objectContaining({ path: "bin/setup", content: "echo setup\n" })
    ]);
  });

  it("deletes skills and profile sync prunes the vault entry", async () => {
    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await localBundle("delete-me-skill")
    });

    const deleted = await deleteSkill({ name: "delete-me-skill" });
    expect(deleted).toMatchObject({ deleted: true, name: "delete-me-skill" });
    await expect(readSkill("delete-me-skill")).resolves.toBeNull();
  });
});

async function localBundle(name: string, body = "Body"): Promise<string> {
  const dir = path.join(currentStorageRoot(), `bundle-${name}-${body}`);
  await writeLocalBundle(dir, name, body);
  return dir;
}
