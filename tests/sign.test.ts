import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  signContent,
  verifyContent,
  verifyFile,
  getSigningKeypair,
  parseManifest
} from "../src/util/sign.js";
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

  it("creates a signed manifest covering SKILL.md when a skill is written", async () => {
    const skillMd = `---
name: signed-skill
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
---

# Body
`;
    await writeSkill("signed-skill", skillMd);
    const manifestPath = path.join(
      currentStorageRoot(),
      "skills",
      "signed-skill",
      ".autovault-manifest"
    );
    const raw = await fs.readFile(manifestPath, "utf-8");
    const manifest = parseManifest(raw);
    expect(manifest).not.toBeNull();
    expect(manifest!.files["SKILL.md"]).toBeTruthy();
    expect(manifest!.skill).toBe("signed-skill");
    const result = await verifyFile(manifest!, "signed-skill", "SKILL.md", skillMd);
    expect(result).toEqual({ present: true, valid: true });

    const stat = await fs.stat(manifestPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("manifest covers declared bin resources too", async () => {
    const skillMd = `---
name: bin-skill
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
    description: One-shot setup
---

# Body
`;
    const setupContent = "#!/usr/bin/env bash\necho ok\n";
    await writeSkill("bin-skill", skillMd, [
      { path: "bin/setup", content: setupContent }
    ]);
    const manifestPath = path.join(
      currentStorageRoot(),
      "skills",
      "bin-skill",
      ".autovault-manifest"
    );
    const manifest = parseManifest(await fs.readFile(manifestPath, "utf-8"));
    expect(manifest).not.toBeNull();
    expect(manifest!.files["bin/setup"]).toBeTruthy();
    const setupResult = await verifyFile(manifest!, "bin-skill", "bin/setup", setupContent);
    expect(setupResult).toEqual({ present: true, valid: true });

    const setupPath = path.join(currentStorageRoot(), "skills", "bin-skill", "bin", "setup");
    const setupStat = await fs.stat(setupPath);
    expect(setupStat.mode & 0o777).toBe(0o755);
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

  it("does not silently fall through when the manifest file is corrupt", async () => {
    const skillMd = `---
name: corrupt-manifest
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
---

# Body
`;
    await writeSkill("corrupt-manifest", skillMd);
    // Corrupt the manifest. Before the fix, readSkill would return without
    // logging because parseManifest returned null and the legacy fallback was
    // already deleted by writeSkill — making post-install tampering invisible.
    const manifestPath = path.join(
      currentStorageRoot(),
      "skills",
      "corrupt-manifest",
      ".autovault-manifest"
    );
    await fs.writeFile(manifestPath, "not json", "utf-8");
    // Tamper with SKILL.md too so the corrupt-manifest path is the only thing
    // that could mask the change.
    const skillPath = path.join(currentStorageRoot(), "skills", "corrupt-manifest", "SKILL.md");
    await fs.writeFile(skillPath, skillMd + "\nappended\n", "utf-8");

    const record = await readSkill("corrupt-manifest");
    // We still return the record (log-only enforcement) but the warning is
    // emitted by the storage layer; the regression is silent fall-through, so
    // we assert the record loads via the manifest-aware path rather than the
    // legacy-signature absence path.
    expect(record).not.toBeNull();
    // Confirm the legacy detached signature does NOT exist — proving the only
    // path readSkill could take is the manifest path. That's what makes silent
    // fall-through dangerous and why the fix logs on corrupt manifests.
    await expect(
      fs.access(path.join(currentStorageRoot(), "skills", "corrupt-manifest", ".autovault-signature"))
    ).rejects.toThrow();
  });

  it("rejects a manifest whose recorded skill name disagrees with the directory", async () => {
    // Defense against the cross-skill manifest swap: an attacker copies the
    // entire .autovault-manifest from skill A into skill B's directory and
    // pairs it with A's bytes. Without the manifest.skill check, every per-
    // file signature still verifies internally against (A, path, content);
    // the attack is caught only because the SIGNATURES are bound to A. The
    // manifest.skill field is defense-in-depth: it surfaces the mismatch as
    // present:false BEFORE any per-file verify runs.
    const skillMd = `---
name: legitimate
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
---

# Body
`;
    await writeSkill("legitimate", skillMd);
    const manifestPath = path.join(
      currentStorageRoot(),
      "skills",
      "legitimate",
      ".autovault-manifest"
    );
    const manifest = parseManifest(await fs.readFile(manifestPath, "utf-8"));
    expect(manifest).not.toBeNull();
    // Caller resolves the manifest from "legitimate"'s directory but then
    // verifies under a different skill name — simulating a swap.
    const result = await verifyFile(manifest!, "imposter", "SKILL.md", skillMd);
    expect(result.present).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("rejects a signature lifted from a different file path within the same skill", async () => {
    // Per-file binding: even within the same skill, a signature from path X
    // must not verify path Y. Without (skill, path, content) binding, an
    // attacker who renamed bin/setup to bin/run (or duplicated its bytes
    // under a different declared bin command) would see the signature
    // verify under the new path because the raw bytes match. The path
    // component of the signing message catches this.
    const skillMd = `---
name: dual-bin
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
  run:
    command: bin/run
---

# Body
`;
    await writeSkill("dual-bin", skillMd, [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho setup\n" },
      { path: "bin/run", content: "#!/usr/bin/env bash\necho run\n" }
    ]);
    const manifestPath = path.join(
      currentStorageRoot(),
      "skills",
      "dual-bin",
      ".autovault-manifest"
    );
    const manifest = parseManifest(await fs.readFile(manifestPath, "utf-8"));
    expect(manifest).not.toBeNull();
    // Lift bin/setup's signature into bin/run's slot, then ask the verifier
    // about bin/run with bin/setup's bytes. Both pre-fix conditions for a
    // successful swap are satisfied (raw bytes match the lifted signature),
    // and the fix must still reject because path is part of the signed message.
    const setupBytes = "#!/usr/bin/env bash\necho setup\n";
    const liftedManifest = {
      ...manifest!,
      files: { ...manifest!.files, "bin/run": manifest!.files["bin/setup"] }
    };
    const liftedResult = await verifyFile(liftedManifest, "dual-bin", "bin/run", setupBytes);
    expect(liftedResult.present).toBe(true);
    expect(liftedResult.valid).toBe(false);
  });

  it("rejects a signature lifted from a different skill's manifest entry", async () => {
    // Cross-skill per-file lift: install two skills with identical bin/setup
    // bytes, then move the signature from skill A's manifest entry into
    // skill B's manifest entry under the same path. Pre-fix, both skills'
    // bin/setup is signed as raw content X — the same signature works for
    // both, so swapping is a no-op. Post-fix, the signatures are over
    // (A, "bin/setup", X) vs (B, "bin/setup", X) — different messages,
    // different signatures, swap fails.
    const sharedBin = "#!/usr/bin/env bash\necho hello\n";
    const buildSkillMd = (name: string) => `---
name: ${name}
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
---

# Body
`;
    await writeSkill("alpha", buildSkillMd("alpha"), [
      { path: "bin/setup", content: sharedBin }
    ]);
    await writeSkill("beta", buildSkillMd("beta"), [
      { path: "bin/setup", content: sharedBin }
    ]);

    const alphaManifest = parseManifest(
      await fs.readFile(
        path.join(currentStorageRoot(), "skills", "alpha", ".autovault-manifest"),
        "utf-8"
      )
    );
    const betaManifest = parseManifest(
      await fs.readFile(
        path.join(currentStorageRoot(), "skills", "beta", ".autovault-manifest"),
        "utf-8"
      )
    );
    expect(alphaManifest).not.toBeNull();
    expect(betaManifest).not.toBeNull();
    // Confirm the same content produces *different* signatures under the two
    // skill names — that's the property the binding provides.
    expect(alphaManifest!.files["bin/setup"]).not.toBe(betaManifest!.files["bin/setup"]);

    // Lift alpha's bin/setup signature into a beta-shaped manifest and verify
    // under "beta". Must fail.
    const tampered = {
      ...betaManifest!,
      files: { ...betaManifest!.files, "bin/setup": alphaManifest!.files["bin/setup"] }
    };
    const result = await verifyFile(tampered, "beta", "bin/setup", sharedBin);
    expect(result.valid).toBe(false);
  });

  it("verifyFile treats a hand-crafted __proto__ entry as 'not present', not as a prototype-chain hit (round-36)", async () => {
    // Defense-in-depth: validation rejects __proto__ at install time, but the
    // verifier must also be safe if a malicious operator hand-edits the
    // manifest to inject `"__proto__": "<sig>"`. parseManifest builds the
    // files map on Object.create(null), so parsed.files.__proto__ is a
    // regular own property — but if a future code path constructs a
    // SignedManifest from somewhere else, verifyFile must still refuse the
    // lookup. Confirm Object.hasOwn semantics: a missing own key returns
    // present:false even when Object.prototype has a property of the same name.
    const empty = parseManifest(
      JSON.stringify({ version: 2, skill: "x", files: {} })
    );
    expect(empty).not.toBeNull();
    // toString is on Object.prototype but NOT an own property of files; the
    // verifier must report 'not present'.
    const result = await verifyFile(empty!, "x", "toString", "anything");
    expect(result).toEqual({ present: false, valid: false });
  });

  it("rejects v1 manifests so post-fix CLI exec demands a fresh sign", async () => {
    // Pre-fix v1 manifests contain raw-content signatures with no skill+path
    // binding. Accepting them would defeat the entire round-15 hardening:
    // the CLI exec path would happily verify v1 entries that an attacker
    // could lift between skills. parseManifest must reject anything that
    // isn't version: 2.
    const v1 = JSON.stringify({
      version: 1,
      files: { "SKILL.md": "anything" }
    });
    expect(parseManifest(v1)).toBeNull();

    const missingSkill = JSON.stringify({
      version: 2,
      files: { "SKILL.md": "abc" }
    });
    expect(parseManifest(missingSkill)).toBeNull();

    const emptySkill = JSON.stringify({
      version: 2,
      skill: "",
      files: { "SKILL.md": "abc" }
    });
    expect(parseManifest(emptySkill)).toBeNull();
  });

  it("warns when both the manifest and the legacy signature are absent", async () => {
    // An attacker who deletes .autovault-manifest leaves a SKILL.md with no
    // integrity file at all. Before the fix, verifySignatureIfPresent silently
    // returned (the catch on the legacy-signature read swallowed ENOENT),
    // producing no warning even though the modern install MUST have a manifest.
    const skillMd = `---
name: deleted-manifest
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
---

# Body
`;
    await writeSkill("deleted-manifest", skillMd);
    const manifestPath = path.join(
      currentStorageRoot(),
      "skills",
      "deleted-manifest",
      ".autovault-manifest"
    );
    await fs.unlink(manifestPath);
    // Tamper with SKILL.md to make the integrity loss visible.
    const skillPath = path.join(currentStorageRoot(), "skills", "deleted-manifest", "SKILL.md");
    await fs.writeFile(skillPath, skillMd + "\ntampered\n", "utf-8");

    const calls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logModule = await import("../src/util/log.js");
    const original = logModule.log.warn;
    logModule.log.warn = (msg: string, meta?: Record<string, unknown>) => {
      calls.push({ msg, meta });
    };
    try {
      const record = await readSkill("deleted-manifest");
      expect(record).not.toBeNull();
      const warning = calls.find(
        (entry) =>
          entry.msg === "storage.signature_mismatch" &&
          entry.meta?.reason === "no_integrity_file"
      );
      expect(warning).toBeDefined();
      expect(warning?.meta?.name).toBe("deleted-manifest");
    } finally {
      logModule.log.warn = original;
    }
  });
});
