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
    // Round-61: resources must be written through writeSkill so the manifest
    // covers them — read_skill_resource hard-fails on uncovered bytes.
    await writeSkill("rsr", skillMd, [{ path: "data.json", content: "{}" }]);
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
    await writeSkill("rsr", skillMd, [
      { path: "examples/v1..json", content: "{\"ok\":true}" }
    ]);
    const result = await readSkillResource("rsr", "examples/v1..json");
    expect(result.content).toBe("{\"ok\":true}");
    expect(result.mime_type).toBe("application/json");
  });

  it("refuses to read when the manifest is absent (deleted post-install) (round-61)", async () => {
    // Round 61 finding: stderr-only warnings never reach the MCP caller, so
    // an agent consuming the tool result couldn't tell a tampered/unsigned
    // resource from a clean one. The fix is hard-fail — match the CLI
    // exec/print surface. An attacker who deletes .autovault-manifest now
    // gets a thrown error from the read path instead of the bytes plus a
    // log line nobody reads.
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
    await expect(
      readSkillResource("rsr-no-manifest", "data.json")
    ).rejects.toThrow(/no signed manifest/);
  });

  it("refuses to read when the manifest is corrupt (round-61)", async () => {
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
    await expect(
      readSkillResource("rsr-corrupt-manifest", "data.json")
    ).rejects.toThrow(/manifest .* is corrupt/);
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

  it("refuses to read when a signed resource has been tampered (round-61)", async () => {
    // Round 61 finding: log-only enforcement was invisible to MCP callers.
    // Hard-fail so an agent calling read_skill_resource on tampered bytes
    // gets an explicit error in-band instead of attacker-controlled content
    // plus a stderr line it never sees.
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
    // Round-62 widened the gate: the full integrity walk catches this as a
    // signature_invalid before the per-file check. Same outcome — refuse —
    // either message form is a valid refusal.
    await expect(
      readSkillResource("rsr-tamper", "data.json")
    ).rejects.toThrow(/signature.mismatch|signature_invalid/);
  });

  it("refuses to read even a clean resource when an unmanifested sibling is present (round-62)", async () => {
    // Round 62 finding: read_skill_resource used to verify only the requested
    // file's signature, so an install with a clean signed resource plus an
    // injected sibling (e.g. lib/helper.sh that bin/setup later sources) was
    // returned as trusted. The MCP caller couldn't tell the install was
    // tampered. Now the full open-set integrity walk runs first; any sibling
    // injection blocks reads of every resource, not just the injected file.
    await writeSkill("rsr-sibling-injection", skillMd.replace("rsr", "rsr-sibling-injection"), [
      { path: "data.json", content: "{\"ok\":true}" }
    ]);
    const liveRoot = path.join(currentStorageRoot(), "skills", "rsr-sibling-injection");
    await fs.mkdir(path.join(liveRoot, "lib"));
    await fs.writeFile(
      path.join(liveRoot, "lib", "helper.sh"),
      "#!/usr/bin/env bash\necho injected\n",
      "utf-8"
    );
    // The requested file (data.json) is itself untouched and signed; the read
    // must still refuse because the install as a whole is no longer clean.
    await expect(
      readSkillResource("rsr-sibling-injection", "data.json")
    ).rejects.toThrow(/integrity check failed.*lib\/helper\.sh|unmanifested_file/);
  });

  it("refuses to read a resource not covered by the signed manifest (round-61)", async () => {
    // A resource present on disk but absent from the manifest is what
    // happens when an attacker drops a sibling file post-install. Even if
    // they then somehow forge a signature for it, the manifest binding
    // (verifyFile.present check) is the gate that catches it.
    await writeSkill("rsr-uncovered", skillMd.replace("rsr", "rsr-uncovered"), [
      { path: "data.json", content: "{\"ok\":true}" }
    ]);
    const stray = path.join(
      currentStorageRoot(),
      "skills",
      "rsr-uncovered",
      "stray.txt"
    );
    await fs.writeFile(stray, "hello", "utf-8");
    // Round-62: the integrity walk catches this earlier as
    // unmanifested_file, before the per-file not_covered branch fires.
    // Either is a valid refusal — both indicate manifest gap.
    await expect(
      readSkillResource("rsr-uncovered", "stray.txt")
    ).rejects.toThrow(/not covered by the signed manifest|unmanifested_file/);
  });
});
