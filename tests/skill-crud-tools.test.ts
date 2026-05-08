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

const skillMdWithAgent = (name: string, body = "Body"): string => `---
name: ${name}
description: A description that is intentionally long enough to satisfy schema checks.
metadata:
  version: "1.0.0"
agents: [codex]
---

# ${body}
`;

const resourceSkillMd = (name: string, body = "Body"): string => `---
name: ${name}
description: A description that is intentionally long enough to satisfy schema checks.
metadata:
  version: "1.0.0"
resources:
  - path: bin/setup
    type: file
bin:
  setup:
    command: bin/setup
    args: []
    description: Run setup.
    requires-tty: false
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

  it("updates inline SKILL.md while reusing existing signed resources", async () => {
    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await resourceBundle("reuse-inline-skill", "Before")
    });

    const updated = await updateSkill({
      name: "reuse-inline-skill",
      source: "inline",
      skill_md: resourceSkillMd("reuse-inline-skill", "After"),
      reuse_existing_resources: true
    });

    expect(updated).toMatchObject({ success: true, name: "reuse-inline-skill" });
    await expect(getSkill("reuse-inline-skill", undefined, { includeResources: true })).resolves.toMatchObject({
      skill_md: expect.stringContaining("# After"),
      resource_contents: [
        expect.objectContaining({ path: "bin/setup", content: "echo setup\n" })
      ]
    });
  });

  it("fails inline resource reuse when the new SKILL.md stops declaring existing resources", async () => {
    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await resourceBundle("reuse-validation-skill", "Before")
    });

    const result = await updateSkill({
      name: "reuse-validation-skill",
      source: "inline",
      skill_md: skillMd("reuse-validation-skill", "After"),
      reuse_existing_resources: true
    });

    expect(result).toMatchObject({
      success: false,
      validation: { valid: false }
    });
    expect(JSON.stringify(result)).toContain("undisclosed file 'bin/setup'");
  });

  it("rejects inline updates that provide resources while requesting reuse", async () => {
    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await localBundle("reuse-conflict-skill", "Before")
    });

    const result = await updateSkill({
      name: "reuse-conflict-skill",
      source: "inline",
      skill_md: skillMd("reuse-conflict-skill", "After"),
      resources: [{ path: "bin/setup", content: "echo setup\n" }],
      reuse_existing_resources: true
    });

    expect(result).toMatchObject({
      success: false,
      name: "reuse-conflict-skill"
    });
    expect(JSON.stringify(result)).toContain("cannot be combined with resources");
  });

  it("compacts local update sync output unless verbose is requested", async () => {
    const profileRoot = path.join(currentStorageRoot(), "codex-profile");
    await addSkill({
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await localBundleWithAgent("compact-sync-skill", "Before"),
      profile_roots: { codex: profileRoot }
    });

    const compact = await updateSkill({
      name: "compact-sync-skill",
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await localBundleWithAgent("compact-sync-skill", "After"),
      profile_roots: { codex: profileRoot }
    });
    expect(compact).toMatchObject({
      success: true,
      paths: {
        skill: expect.stringContaining("compact-sync-skill")
      },
      sync: {
        profiles: { codex: 1 },
        linkedRoots: { codex: profileRoot }
      }
    });

    const verbose = await updateSkill({
      name: "compact-sync-skill",
      source: "local",
      identifier: "vendor/repo",
      skill_dir: await localBundleWithAgent("compact-sync-skill", "Verbose"),
      profile_roots: { codex: profileRoot },
      verbose: true
    });
    expect(verbose).toMatchObject({
      success: true,
      sync: {
        profiles: { codex: ["compact-sync-skill"] },
        linkedRoots: { codex: profileRoot }
      }
    });
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

async function localBundleWithAgent(name: string, body = "Body"): Promise<string> {
  const dir = path.join(currentStorageRoot(), `bundle-${name}-${body}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMdWithAgent(name, body), "utf-8");
  return dir;
}

async function resourceBundle(name: string, body = "Body"): Promise<string> {
  const dir = path.join(currentStorageRoot(), `bundle-${name}-${body}`);
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), resourceSkillMd(name, body), "utf-8");
  await fs.writeFile(path.join(dir, "bin", "setup"), "echo setup\n", "utf-8");
  return dir;
}
