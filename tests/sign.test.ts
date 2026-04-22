import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signContent, verifyContent, getSigningKeypair } from "../src/util/sign.js";
import { writeSkill, readSkill } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

describe("signing", () => {
  it("signs and verifies identical content", async () => {
    const sig = await signContent("hello world");
    expect(await verifyContent("hello world", sig)).toBe(true);
  });

  it("rejects tampered content", async () => {
    const sig = await signContent("original content");
    expect(await verifyContent("tampered content", sig)).toBe(false);
  });

  it("persists the keypair to storage with restrictive permissions", async () => {
    await getSigningKeypair();
    const keyPath = path.join(currentStorageRoot(), ".signing-key.json");
    const stat = await fs.stat(keyPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates a signature sidecar when a skill is written", async () => {
    const skillMd = `---
name: signed-skill
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
---

# Body
`;
    await writeSkill("signed-skill", skillMd);
    const sigPath = path.join(
      currentStorageRoot(),
      "skills",
      "signed-skill",
      ".autovault-signature"
    );
    const sig = (await fs.readFile(sigPath, "utf-8")).trim();
    expect(sig.length).toBeGreaterThan(0);
    expect(await verifyContent(skillMd, sig)).toBe(true);
  });

  it("reading a skill does not throw on signature mismatch (log-only enforcement)", async () => {
    const skillMd = `---
name: tampered-skill
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
---

# Body
`;
    await writeSkill("tampered-skill", skillMd);
    const skillPath = path.join(currentStorageRoot(), "skills", "tampered-skill", "SKILL.md");
    await fs.writeFile(skillPath, skillMd + "\ntampered", "utf-8");
    const record = await readSkill("tampered-skill");
    expect(record).not.toBeNull();
  });
});
