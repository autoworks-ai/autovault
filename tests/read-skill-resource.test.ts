import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureStorage,
  writeSkill,
  writeSkillResources
} from "../src/storage/index.js";
import { readSkillResource } from "../src/tools/read-skill-resource.js";
import { currentStorageRoot } from "./setup.js";

const skillMd = `---
name: rsr
description: A description that is intentionally long enough to satisfy the schema length checks.
metadata:
  version: "1.0.0"
---

# Body
`;

describe("readSkillResource", () => {
  it("reads a resource and infers a mime type", async () => {
    await ensureStorage();
    await writeSkill("rsr", skillMd);
    await writeSkillResources("rsr", [{ path: "data.json", content: "{}" }]);
    const result = await readSkillResource("rsr", "data.json");
    expect(result.content).toBe("{}");
    expect(result.mime_type).toBe("application/json");
  });

  it("rejects path traversal in resource path", async () => {
    await writeSkill("rsr", skillMd);
    await expect(readSkillResource("rsr", "../../etc/passwd")).rejects.toThrow(/Invalid/);
    await expect(readSkillResource("rsr", "..\\..\\etc\\passwd")).rejects.toThrow(/Invalid/);
    await expect(readSkillResource("rsr", "/etc/passwd")).rejects.toThrow(/Invalid/);
  });

  it("rejects unsafe skill names", async () => {
    await expect(readSkillResource("../escape", "x")).rejects.toThrow(/Invalid skill name/);
    await expect(readSkillResource("foo/bar", "x")).rejects.toThrow(/Invalid skill name/);
    await expect(readSkillResource("foo\\bar", "x")).rejects.toThrow(/Invalid skill name/);
  });

  it("allows non-traversal filenames that contain double dots", async () => {
    await writeSkill("rsr", skillMd);
    await writeSkillResources("rsr", [{ path: "examples/v1..json", content: "{\"ok\":true}" }]);
    const result = await readSkillResource("rsr", "examples/v1..json");
    expect(result.content).toBe("{\"ok\":true}");
    expect(result.mime_type).toBe("application/json");
  });

  it("warns when the manifest is absent (deleted post-install)", async () => {
    // Mirrors readSkill's missing-integrity-file behavior. Before the fix,
    // read_skill_resource silently returned bytes when readSkillManifest
    // returned null, so an attacker who deleted .autovault-manifest could
    // tamper with resources and the agent-facing read would surface no signal.
    const calls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logModule = await import("../src/util/log.js");
    const original = logModule.log.warn;
    logModule.log.warn = (msg: string, meta?: Record<string, unknown>) => {
      calls.push({ msg, meta });
    };
    try {
      await writeSkill("rsr-no-manifest", skillMd.replace("rsr", "rsr-no-manifest"), [
        { path: "data.json", content: "{\"ok\":true}" }
      ]);
      const manifestPath = path.join(
        currentStorageRoot(),
        "skills",
        "rsr-no-manifest",
        ".autovault-manifest"
      );
      await fs.unlink(manifestPath);
      const result = await readSkillResource("rsr-no-manifest", "data.json");
      expect(result.content).toBe("{\"ok\":true}");
      const warning = calls.find(
        (entry) =>
          entry.msg === "read_skill_resource.signature_mismatch" &&
          entry.meta?.reason === "no_integrity_file"
      );
      expect(warning).toBeDefined();
      expect(warning?.meta?.skill).toBe("rsr-no-manifest");
    } finally {
      logModule.log.warn = original;
    }
  });

  it("warns when the manifest is corrupt", async () => {
    const calls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logModule = await import("../src/util/log.js");
    const original = logModule.log.warn;
    logModule.log.warn = (msg: string, meta?: Record<string, unknown>) => {
      calls.push({ msg, meta });
    };
    try {
      await writeSkill("rsr-corrupt-manifest", skillMd.replace("rsr", "rsr-corrupt-manifest"), [
        { path: "data.json", content: "{\"ok\":true}" }
      ]);
      const manifestPath = path.join(
        currentStorageRoot(),
        "skills",
        "rsr-corrupt-manifest",
        ".autovault-manifest"
      );
      await fs.writeFile(manifestPath, "not json", "utf-8");
      const result = await readSkillResource("rsr-corrupt-manifest", "data.json");
      expect(result.content).toBe("{\"ok\":true}");
      const warning = calls.find(
        (entry) =>
          entry.msg === "read_skill_resource.signature_mismatch" &&
          entry.meta?.reason === "manifest_corrupt"
      );
      expect(warning).toBeDefined();
    } finally {
      logModule.log.warn = original;
    }
  });

  it("reads a resource declared with backslashes via the canonical path (round-34)", async () => {
    // Regression: writeSkill normalizes resource paths via canonicalRelPath, so
    // a declaration like `examples\guide.md` lands on disk as `examples/guide.md`.
    // Pre-fix, validateResourcePath resolved the raw `resourcePath` argument
    // and returned a literal-backslash filename, which read_skill_resource then
    // failed to read. Validation/write/read must all key off the same canonical
    // form so a valid install can be read back.
    await writeSkill("rsr-backslash", skillMd.replace("rsr", "rsr-backslash"), [
      { path: "examples\\guide.md", content: "# guide" }
    ]);
    const result = await readSkillResource("rsr-backslash", "examples\\guide.md");
    expect(result.content).toBe("# guide");
    expect(result.mime_type).toBe("text/markdown");
    // POSIX path is what actually exists on disk.
    const onDisk = await fs.readFile(
      path.join(currentStorageRoot(), "skills", "rsr-backslash", "examples", "guide.md"),
      "utf-8"
    );
    expect(onDisk).toBe("# guide");
  });

  it("logs a signature mismatch warning when a signed resource is tampered", async () => {
    // V1 enforcement is log-only here (matches readSkill's SKILL.md behavior)
    // — agents and the CLI hard-fail at exec time. The point of this test is
    // to ensure read_skill_resource does NOT silently bypass the manifest.
    const calls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logModule = await import("../src/util/log.js");
    const original = logModule.log.warn;
    logModule.log.warn = (msg: string, meta?: Record<string, unknown>) => {
      calls.push({ msg, meta });
    };
    try {
      await writeSkill("rsr-tamper", skillMd.replace("rsr", "rsr-tamper"), [
        { path: "data.json", content: "{\"ok\":true}" }
      ]);
      const resourcePath = path.join(
        currentStorageRoot(),
        "skills",
        "rsr-tamper",
        "data.json"
      );
      await fs.writeFile(resourcePath, "{\"ok\":false}", "utf-8");
      const result = await readSkillResource("rsr-tamper", "data.json");
      expect(result.content).toBe("{\"ok\":false}");
      const mismatched = calls.find(
        (entry) => entry.msg === "read_skill_resource.signature_mismatch"
      );
      expect(mismatched).toBeDefined();
      expect(mismatched?.meta?.skill).toBe("rsr-tamper");
    } finally {
      logModule.log.warn = original;
    }
  });
});
