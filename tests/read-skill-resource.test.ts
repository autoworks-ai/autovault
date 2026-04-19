import { describe, expect, it } from "vitest";
import {
  ensureStorage,
  writeSkill,
  writeSkillResources
} from "../src/storage/index.js";
import { readSkillResource } from "../src/tools/read-skill-resource.js";

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
});
