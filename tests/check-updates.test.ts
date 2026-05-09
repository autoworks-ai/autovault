import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installSkill } from "../src/tools/install-skill.js";
import { checkUpdates } from "../src/tools/check-updates.js";
import { skillDir } from "../src/storage/index.js";
import { signContent } from "../src/util/sign.js";
import { currentStorageRoot } from "./setup.js";

const skillMd = `---
name: drift-skill
description: A description that is intentionally long enough to satisfy the schema length check.
agents: [codex]
metadata:
  version: "1.0.0"
---

# Body
`;

const skillMdV2 = skillMd.replace("# Body", "# Body v2");

async function writeBundledSkill(
  name: string,
  body: string,
  resources: Array<{ path: string; content: string }> = []
): Promise<string> {
  const bundledRoot = path.join(currentStorageRoot(), "bundled-skills");
  const skillRoot = path.join(bundledRoot, name);
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), body, "utf-8");
  for (const resource of resources) {
    const target = path.join(skillRoot, resource.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, resource.content, "utf-8");
  }
  return bundledRoot;
}

describe("checkUpdates", () => {
  it("reports up_to_date when upstream content is unchanged", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );
    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.up_to_date).toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports drift when content hash changes upstream", async () => {
    const installFetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: installFetcher } }
    );
    const checkFetcher = vi.fn().mockResolvedValue({
      skillMd: skillMdV2,
      sourceUrl: "https://x",
      upstreamSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    const result = await checkUpdates(undefined, { fetchers: { github: checkFetcher } });
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].name).toBe("drift-skill");
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports bundled inline skills as up_to_date when repo content matches", async () => {
    const bundledSkillsDir = await writeBundledSkill("drift-skill", skillMd);
    await installSkill({
      source: "url",
      identifier: "drift-skill",
      bundled_skill_name: "drift-skill",
      skill_md: skillMd
    });
    const result = await checkUpdates(undefined, { bundledSkillsDir });
    expect(result.up_to_date).toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.unchecked).toHaveLength(0);
  });

  it("stays up_to_date when only ignored OS metadata is present locally", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );
    await fs.writeFile(path.join(skillDir("drift-skill"), ".DS_Store"), "finder\n", "utf-8");

    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.up_to_date).toContain("drift-skill");
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toEqual([
      {
        name: "drift-skill",
        warning: "Ignored benign OS/editor metadata; run autovault doctor --clean to remove it.",
        ignored_artifacts: [".DS_Store"]
      }
    ]);
  });

  it("ignores bundled .autovault metadata when comparing inline bundles", async () => {
    const skillWithResource = `---
name: drift-skill
description: A description that is intentionally long enough to satisfy the schema length check.
agents: [codex]
metadata:
  version: "1.0.0"
resources:
  - path: references/notes.md
    type: file
---

# Body
`;
    const resources = [{ path: "references/notes.md", content: "# notes\n" }];
    const bundledSkillsDir = await writeBundledSkill("drift-skill", skillWithResource, [
      ...resources,
      { path: ".autovault-manifest", content: "{}" },
      { path: ".DS_Store", content: "finder\n" },
      { path: "desktop.ini", content: "desktop\n" },
      { path: "references/._notes.md", content: "appledouble\n" }
    ]);
    await installSkill({
      source: "url",
      identifier: "drift-skill",
      bundled_skill_name: "drift-skill",
      skill_md: skillWithResource,
      resources
    });

    const result = await checkUpdates(undefined, { bundledSkillsDir });
    expect(result.up_to_date).toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports drift when bundled inline repo content changes", async () => {
    const bundledSkillsDir = await writeBundledSkill("drift-skill", skillMdV2);
    await installSkill({
      source: "url",
      identifier: "drift-skill",
      bundled_skill_name: "drift-skill",
      skill_md: skillMd
    });
    const result = await checkUpdates(undefined, { bundledSkillsDir });
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0]).toMatchObject({
      name: "drift-skill",
      source: "inline",
      identifier: "drift-skill",
      reason: "bundled content hash changed"
    });
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.unchecked).toHaveLength(0);
  });

  it("reports drift when only a fetched resource changes, not SKILL.md", async () => {
    const skillWithBin = `---
name: drift-skill
description: A description that is intentionally long enough to satisfy the schema length check.
agents: [codex]
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
---

# Body
`;
    const installFetcher = vi.fn().mockResolvedValue({
      skillMd: skillWithBin,
      sourceUrl: "https://x",
      upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resources: [{ path: "bin/setup", content: "#!/usr/bin/env bash\necho v1\n" }]
    });
    const installResult = await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: installFetcher } }
    );
    expect(installResult.success).toBe(true);

    // Upstream now serves identical SKILL.md but a patched bin/setup.
    const checkFetcher = vi.fn().mockResolvedValue({
      skillMd: skillWithBin,
      sourceUrl: "https://x",
      upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resources: [{ path: "bin/setup", content: "#!/usr/bin/env bash\necho v2\n" }]
    });
    const result = await checkUpdates(undefined, { fetchers: { github: checkFetcher } });
    expect(result.drifted.map((d) => d.name)).toContain("drift-skill");
    expect(result.drifted[0].reason).toBe("content hash changed");
  });

  it("treats remote SKILL.md as up_to_date when only repairable whitespace differs (round-53)", async () => {
    // Round 53 finding: install_skill records contentHash from
    // bundleHash(normalizedSkillMd, resources) where normalizedSkillMd is the
    // output of attemptRepair (tabs → 2 spaces, trailing whitespace stripped).
    // The remote drift path used to hash raw `fetched.skillMd`. So any GitHub/
    // URL/agentskills upstream whose SKILL.md needed repair would install
    // fine, then permanently report `content hash changed` even though the
    // upstream content was unchanged byte-for-byte vs install. The fix runs
    // attemptRepair on the fetched SKILL.md before hashing — same shape as
    // install — so install-time and check-time hashes agree.
    //
    // This test pins the guarantee: install with a SKILL.md that has trailing
    // whitespace (which attemptRepair strips), then check_updates with the
    // exact same upstream bytes. Without the fix, drift fires (raw bytes
    // differ from the repaired-and-hashed install record). With the fix,
    // up_to_date.
    // Embed a tab indent (attemptRepair turns tabs into 2 spaces) and a
    // trailing space on the body line (attemptRepair strips it). Either
    // mutation alone is enough to make the raw bytes differ from the
    // repaired bytes the install hashes.
    const repairable =
      "---\n" +
      "name: drift-skill\n" +
      "description: A description that is intentionally long enough to satisfy the schema length check.\n" +
      "agents: [codex]\n" +
      "metadata:\n" +
      "\tversion: \"1.0.0\"\n" +
      "---\n" +
      "\n" +
      "# Body \n";
    const fetcher = vi.fn().mockResolvedValue({
      skillMd: repairable,
      sourceUrl: "https://x",
      upstreamSha: "cccccccccccccccccccccccccccccccccccccccc"
    });
    const installResult = await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );
    expect(installResult.success).toBe(true);

    // Same upstream bytes, same SHA — nothing actually changed.
    const checkResult = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(checkResult.up_to_date).toContain("drift-skill");
    expect(checkResult.drifted).toHaveLength(0);
    expect(checkResult.unchecked).toHaveLength(0);
  });

  it("reports an error when local SKILL.md is tampered after install (round-55)", async () => {
    // Round 55 finding: check_updates relied on the signed source.contentHash
    // matching freshly-fetched upstream bytes to declare up_to_date. The
    // signed-source fix from round 54 prevented an attacker from rewriting
    // .autovault-source.json, but a local attacker who edits SKILL.md (or
    // any signed resource) directly leaves source.json untouched. With
    // upstream still serving the original bytes, check_updates would stamp
    // the skill up_to_date even though the live install had been tampered
    // with — a false clean bill of health for compromised content.
    //
    // Fix: gate the up_to_date verdict on verifyInstalledIntegrity before
    // touching the upstream. This test mutates SKILL.md on disk and asserts
    // the result becomes an error, not up_to_date.
    const fetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );

    // Mutate the live SKILL.md without re-signing the manifest.
    const liveSkillMd = path.join(skillDir("drift-skill"), "SKILL.md");
    await fs.writeFile(liveSkillMd, skillMd + "\n# Tampered\n", "utf-8");

    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("drift-skill");
    expect(result.errors[0].error).toMatch(/Local integrity check failed/);
    expect(result.errors[0].error).toMatch(/SKILL\.md/);
  });

  it("reports an error when a signed resource is tampered after install (round-55)", async () => {
    // Same threat model as the SKILL.md case but for a manifest-covered
    // resource. The bin script in particular is exec'd by the CLI, so
    // letting check_updates greenlight a tampered bin file would mask the
    // most dangerous local-tamper outcome.
    const skillWithBin = `---
name: drift-skill
description: A description that is intentionally long enough to satisfy the schema length check.
agents: [codex]
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
---

# Body
`;
    const fetcher = vi.fn().mockResolvedValue({
      skillMd: skillWithBin,
      sourceUrl: "https://x",
      upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resources: [{ path: "bin/setup", content: "#!/usr/bin/env bash\necho v1\n" }]
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );

    const liveBin = path.join(skillDir("drift-skill"), "bin", "setup");
    await fs.writeFile(liveBin, "#!/usr/bin/env bash\necho pwned\n", "utf-8");

    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("drift-skill");
    expect(result.errors[0].error).toMatch(/Local integrity check failed/);
    expect(result.errors[0].error).toMatch(/bin\/setup/);
  });

  it("treats pre-v1 legacy installs as unchecked, not tampered (round-56)", async () => {
    // Round 56 finding: pre-v1 (main-style) installs wrote
    // .autovault-signature (detached SKILL.md sig) and an unsigned
    // .autovault-source.json — no .autovault-manifest. After the round-54
    // signed-source change landed, every legitimate pre-upgrade install
    // would surface "Source metadata signature invalid (manifest_missing_entry)"
    // because readSkillSourceStatus refuses unsigned source data once the
    // manifest is the canonical binding. That's a version-skew migration
    // break, not evidence of tampering.
    //
    // Fix: detect the legacy shape (valid detached SKILL.md signature +
    // unsigned source.json + no manifest) and surface as unchecked with a
    // clear reinstall hint. Tampered installs (manifest deleted by an
    // attacker without a valid detached sig fallback) still surface as
    // tampered — see the next test.
    const fetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );

    // Reshape on disk to look like a pre-v1 install: drop the manifest,
    // write a valid detached SKILL.md signature in its place. Use the same
    // signing key (signContent) — that's what main's writeSkill produced.
    const dir = skillDir("drift-skill");
    await fs.unlink(path.join(dir, ".autovault-manifest"));
    const liveSkillMd = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");
    const detached = await signContent(liveSkillMd);
    await fs.writeFile(path.join(dir, ".autovault-signature"), detached, {
      encoding: "utf-8",
      mode: 0o600
    });

    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.errors).toHaveLength(0);
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.unchecked).toHaveLength(1);
    expect(result.unchecked[0].name).toBe("drift-skill");
    expect(result.unchecked[0].reason).toMatch(/legacy install/);
    expect(result.unchecked[0].reason).toMatch(/reinstall/);
  });

  it("rejects manifest-entry-deletion + file-tamper attack (round-57)", async () => {
    // Round 57 finding: verifyInstalledIntegrity only iterated keys present
    // in manifest.files. Because the manifest itself is unsigned, a local
    // tamperer could delete the SKILL.md (or bin/setup) entry from
    // .autovault-manifest, mutate the corresponding file, leave the signed
    // .autovault-source.json entry intact, and the integrity check would
    // miss the tamper entirely — the deleted key was simply never iterated.
    // check_updates would then report up_to_date against upstream, falsely
    // greenlighting a compromised install.
    //
    // Fix: enforce a required-key set (SKILL.md + .autovault-source.json +
    // declared resources/bins) before the per-entry verification. A removed
    // key surfaces as a missing_from_manifest mismatch.
    const skillWithBin = `---
name: drift-skill
description: A description that is intentionally long enough to satisfy the schema length check.
agents: [codex]
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
---

# Body
`;
    const fetcher = vi.fn().mockResolvedValue({
      skillMd: skillWithBin,
      sourceUrl: "https://x",
      upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resources: [{ path: "bin/setup", content: "#!/usr/bin/env bash\necho v1\n" }]
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );

    const dir = skillDir("drift-skill");
    const manifestPath = path.join(dir, ".autovault-manifest");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));

    // Simulated attacker move: drop the bin/setup entry from manifest, then
    // tamper bin/setup on disk. .autovault-source.json entry is left intact
    // so source-status verification passes.
    delete manifest.files["bin/setup"];
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await fs.writeFile(
      path.join(dir, "bin", "setup"),
      "#!/usr/bin/env bash\necho pwned\n",
      "utf-8"
    );

    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("drift-skill");
    expect(result.errors[0].error).toMatch(/Local integrity check failed/);
    expect(result.errors[0].error).toMatch(/bin\/setup/);
    expect(result.errors[0].error).toMatch(/missing_from_manifest/);
  });

  it("rejects SKILL.md manifest-entry deletion (round-57)", async () => {
    // Companion to the bin tamper: deleting the SKILL.md entry from the
    // manifest must also fail closed. Without the required-key gate, the
    // SKILL.md entry was the very thing the iteration trusted to derive
    // resource declarations from — losing it should be a hard error, not
    // a silent skip.
    const fetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );

    const dir = skillDir("drift-skill");
    const manifestPath = path.join(dir, ".autovault-manifest");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    delete manifest.files["SKILL.md"];
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await fs.writeFile(path.join(dir, "SKILL.md"), skillMd + "\n# Tampered\n", "utf-8");

    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/Local integrity check failed/);
    expect(result.errors[0].error).toMatch(/SKILL\.md/);
  });

  it("treats no-manifest-and-no-valid-signature installs as tampered (round-56)", async () => {
    // The flip side of the legacy migration: if the manifest is missing
    // AND the detached signature is missing or invalid, we cannot
    // distinguish the install from an attacker-driven tamper. Refuse the
    // drift check and surface a tamper error — the legacy path only
    // applies when the detached signature actually verifies.
    const fetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );

    // Strip the manifest without restoring any legacy signature: this is
    // the attacker shape, not a legitimate pre-v1 install.
    const dir = skillDir("drift-skill");
    await fs.unlink(path.join(dir, ".autovault-manifest"));

    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("drift-skill");
    expect(result.errors[0].error).toMatch(/Source metadata signature invalid/);
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.unchecked).toHaveLength(0);
  });

  it("rejects extra unmanifested files in the skill directory (round-59)", async () => {
    // Without a live-directory walk, a local attacker (or a corrupt write)
    // could plant an extra file under an installed skill — say a `lib/helper.sh`
    // that bin/setup later sources, or an alternate SKILL.md sibling — and
    // verifyInstalledIntegrity would still report kind=ok because every
    // manifest-listed entry still verifies. Manifest-only enforcement is a
    // closed-set check; tampering by *addition* needs an open-set check.
    // Walk the live directory and fail closed on any non-metadata file the
    // manifest does not cover.
    const fetcher = vi.fn().mockResolvedValue({
      skillMd,
      sourceUrl: "https://x",
      upstreamSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    });
    await installSkill(
      { source: "github", identifier: "owner/repo" },
      { fetchers: { github: fetcher } }
    );

    const dir = skillDir("drift-skill");
    await fs.mkdir(path.join(dir, "lib"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "lib", "helper.sh"),
      "#!/usr/bin/env bash\necho injected\n",
      "utf-8"
    );

    const result = await checkUpdates(undefined, { fetchers: { github: fetcher } });
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("drift-skill");
    expect(result.errors[0].error).toMatch(/Local integrity check failed/);
    expect(result.errors[0].error).toMatch(/lib\/helper\.sh/);
    expect(result.errors[0].error).toMatch(/unmanifested_file/);
  });

  it("reports non-bundled inline skills as unchecked", async () => {
    await installSkill({
      source: "url",
      identifier: "https://example.com/x",
      skill_md: skillMd
    });
    const result = await checkUpdates();
    expect(result.up_to_date).not.toContain("drift-skill");
    expect(result.drifted).toHaveLength(0);
    expect(result.unchecked).toEqual([
      {
        name: "drift-skill",
        source: "inline",
        identifier: "https://example.com/x",
        reason: "inline skill has no checkable upstream"
      }
    ]);
  });
});
