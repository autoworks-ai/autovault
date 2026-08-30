import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readSkillSourceStatus,
  skillDir,
  verifyInstalledIntegrity,
  writeSkill
} from "../src/storage/index.js";
import { bundleHash } from "../src/util/hash.js";
import { MAX_SKILL_MD_BYTES } from "../src/util/limits.js";
import { sameFileIdentity } from "../src/cli/doctor.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runCli(
  args: string[],
  options: { ttyStdin?: boolean; env?: Record<string, string> } = {}
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true",
        ...(options.env ?? {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    if (options.ttyStdin === false) child.stdin.end();
    else child.stdin.end();
  });
}

async function writePluginSkill(
  root: string,
  relativeDir: string,
  name: string
): Promise<string> {
  const pluginDir = path.join(root, relativeDir, "skills", name);
  await fs.mkdir(pluginDir, { recursive: true });
  const skillPath = path.join(pluginDir, "SKILL.md");
  await fs.writeFile(skillPath, simpleSkill(name), "utf-8");
  return skillPath;
}

const fixtureSkill = (name: string, opts: { args?: string[] } = {}) => `---
name: ${name}
description: A description that is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
${opts.args ? `    args: ${JSON.stringify(opts.args)}\n` : ""}    description: Run setup
    requires-tty: false
---

# Body
`;

const simpleSkill = (name: string) => `---
name: ${name}
description: A description that is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
agents: [codex]
---

# Body
`;

describe("autovault skill CLI", () => {
  it("recognizes two paths with the same file identity", async () => {
    const original = path.join(currentStorageRoot(), "identity-original");
    const alias = path.join(currentStorageRoot(), "identity-alias");
    await fs.writeFile(original, "identity", "utf-8");
    await fs.link(original, alias);

    await expect(sameFileIdentity(original, alias)).resolves.toBe(true);
  });

  it("prints usage when no subcommand is given", async () => {
    const result = await runCli(["skill"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Usage:/);
  });

  it("top-level usage includes doctor", async () => {
    const result = await runCli([]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/autovault doctor \[skill-name\]/);
  });

  it("prints a trust dashboard for doctor in human mode", async () => {
    const skillMd = `---
name: doctor-human
description: A description that is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
---

# Body
`;
    await writeSkill("doctor-human", skillMd);

    const result = await runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    const normalized = result.stdout.replaceAll(currentStorageRoot(), "<ROOT>");
    expect(normalized).toMatchInlineSnapshot(`
"
[doctor] AutoVault trust dashboard
Vault health --------------------------------------------
  - storage   <ROOT>
  ! summary   0 ok, 1 warning(s), 0 error(s)
  - cleaned   0 artifact(s)
  - allowlist .DS_Store, Thumbs.db, desktop.ini, and AppleDouble ._* files

Skill integrity --------------------------------------------
! doctor-human warning
  integrity ok
  source absent
  - next: Reinstall or update the skill with source metadata if update checks should work.

"
`);
  });

  it("returns 0 with a 'no <action> declared' message when bin is absent", async () => {
    const skillMd = `---
name: no-bin
description: A description that is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
---

# Body
`;
    await writeSkill("no-bin", skillMd);
    const result = await runCli(["skill", "setup", "no-bin"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/No setup declared/);
  });

  it("refuses to exec without a TTY even when the skill sets requires-tty: false", async () => {
    // Hardening: skill metadata cannot lower the TTY guard. A malicious skill
    // could otherwise let an agent exec the bin script non-interactively, so
    // the user's enforcement wall depends on this being skill-independent.
    await writeSkill("fix-non-tty", fixtureSkill("fix-non-tty"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho should-not-run\n" }
    ]);
    const result = await runCli(["skill", "setup", "fix-non-tty"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/interactive terminal/i);
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("does not honor any env-var bypass — the spawning process cannot disable the TTY wall", async () => {
    // Regression for the adversarial finding: a per-process env var is
    // settable by whoever spawns the CLI (including the agent we're walling
    // off), so AutoVault must not honor any such bypass. The TTY check is
    // unconditional. This test asserts a few plausible bypass names do not
    // unlock exec — if a future change introduces one, this test catches it.
    await writeSkill("no-bypass", fixtureSkill("no-bypass"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho should-not-run\n" }
    ]);
    const candidates = [
      { AUTOVAULT_ALLOW_NON_TTY: "1" },
      { AUTOVAULT_NON_INTERACTIVE: "1" },
      { AUTOVAULT_FORCE: "1" },
      { CI: "true" }
    ];
    for (const env of candidates) {
      const result = await runCli(["skill", "setup", "no-bypass"], { env });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/interactive terminal/i);
      expect(result.stdout).not.toContain("should-not-run");
    }
  });

  it("refuses to exec when the bin file has been tampered with", async () => {
    await writeSkill("fix3", fixtureSkill("fix3"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho original\n" }
    ]);
    // Tamper with the file post-install — the manifest still has the old signature.
    const setupPath = path.join(currentStorageRoot(), "skills", "fix3", "bin", "setup");
    await fs.writeFile(setupPath, "#!/usr/bin/env bash\necho TAMPERED\n", {
      encoding: "utf-8",
      mode: 0o755
    });
    const result = await runCli(["skill", "setup", "fix3"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/signature mismatch/i);
    expect(result.stdout).not.toContain("TAMPERED");
  });

  it("refuses to exec when SKILL.md has been tampered with after install", async () => {
    await writeSkill("tampered-md", fixtureSkill("tampered-md"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho original\n" }
    ]);
    // Mutate SKILL.md (change requires-tty so we'd otherwise still exec). The bin
    // file body is untouched and still matches its manifest signature, but the
    // metadata that decides what to run has been altered.
    const skillMdPath = path.join(currentStorageRoot(), "skills", "tampered-md", "SKILL.md");
    const original = await fs.readFile(skillMdPath, "utf-8");
    const tampered = original.replace("requires-tty: false", "requires-tty: true");
    expect(tampered).not.toBe(original);
    await fs.writeFile(skillMdPath, tampered, "utf-8");

    const result = await runCli(["skill", "setup", "tampered-md"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/SKILL\.md signature mismatch/i);
    expect(result.stdout).not.toContain("original");
  });

  it("refuses to exec when an action is added to SKILL.md after install", async () => {
    await writeSkill("evil-action", fixtureSkill("evil-action"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho should-not-run\n" }
    ]);
    // Add a new action 'evil' that points at the already-signed bin/setup.
    // Without the SKILL.md hard-verify, the CLI would happily exec because the
    // bin file body still matches the manifest signature.
    const skillMdPath = path.join(currentStorageRoot(), "skills", "evil-action", "SKILL.md");
    const original = await fs.readFile(skillMdPath, "utf-8");
    const tampered = original.replace(
      "bin:\n  setup:",
      "bin:\n  evil:\n    command: bin/setup\n    requires-tty: false\n  setup:"
    );
    expect(tampered).not.toBe(original);
    await fs.writeFile(skillMdPath, tampered, "utf-8");

    const result = await runCli(["skill", "evil", "evil-action"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/SKILL\.md signature mismatch/i);
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("refuses to exec when stdin is not a TTY and requires-tty is true", async () => {
    const tty = `---
name: needs-tty
description: A description that is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
    requires-tty: true
---

# Body
`;
    await writeSkill("needs-tty", tty, [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho should-not-run\n" }
    ]);
    const result = await runCli(["skill", "setup", "needs-tty"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/interactive terminal/i);
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("lists installed skills and the actions they declare", async () => {
    await writeSkill("alpha", fixtureSkill("alpha"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    const result = await runCli(["skill", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[vault] AutoVault skill catalog");
    expect(result.stdout).toContain("Runnable actions");
    expect(result.stdout).toContain("All skills");
    expect(result.stdout).toMatch(/alpha/);
    expect(result.stdout).toMatch(/setup/);
  });

  it("searches installed skills from the skill CLI", async () => {
    await writeSkill("copilot-review", `---
name: copilot-review
description: Fix Copilot comments on a pull request and resolve review threads.
tags:
  - copilot
  - pull-request
metadata:
  version: "1.0.0"
---

# Body
`);
    const result = await runCli(["skill", "search", "fix", "copilot", "comments"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("copilot-review");
    expect(result.stdout).toContain("matched");
    expect(result.stdout).toContain("tags: copilot, pull-request");
  });

  it("skill search reports empty matches", async () => {
    const result = await runCli(["skill", "search", "nope-nope-nope"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("No matching skills.\n");
  });

  it("skill search honors --top-k", async () => {
    await writeSkill("alpha-search", fixtureSkill("alpha-search"));
    await writeSkill("beta-search", fixtureSkill("beta-search"));
    const result = await runCli(["skill", "search", "search", "--top-k", "1"]);
    expect(result.exitCode).toBe(0);
    const resultLines = result.stdout.split("\n").filter((line) => /^[a-z].*\t/.test(line));
    expect(resultLines).toHaveLength(1);
  });

  it("skill search escapes control characters in rendered metadata", async () => {
    await writeSkill("unsafe-search", `---
name: unsafe-search
description: "Unsafe\\n\\u001b[2J description for metadata text search output."
tags:
  - "tag\\tvalue"
category: "cat\\rvalue"
metadata:
  version: "1.0.0"
---

# Body
`);
    const result = await runCli(["skill", "search", "unsafe"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unsafe\\n\\x1b[2J description");
    expect(result.stdout).toContain("tags: tag\\tvalue");
    expect(result.stdout).toContain("category: cat\\rvalue");
    expect(result.stdout).not.toContain("\u001b[2J");
  });

  it("prints the resolved script path + cwd via 'skill which' (no args case)", async () => {
    await writeSkill("which1", fixtureSkill("which1"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    const result = await runCli(["skill", "which", "which1", "setup"]);
    expect(result.exitCode).toBe(0);
    const expectedPath = path.join(
      currentStorageRoot(),
      "skills",
      "which1",
      "bin",
      "setup"
    );
    const expectedCwd = path.join(currentStorageRoot(), "skills", "which1");
    expect(result.stdout.trim()).toBe(`${expectedPath}\t# cwd: ${expectedCwd}`);
  });

  it("'skill which' prints the full signed argv, not just the path (round-27)", async () => {
    // Round 27 finding: which used to print only the resolved path, hiding
    // signed bin.<action>.args that runAction passes verbatim to spawn().
    // A user reviewing the script body via `which` could miss attacker-
    // controlled args (config paths, mode switches, secret-output flags)
    // even though they materially change behavior. The review surface must
    // match the execution surface — pin that here with an arg that contains
    // a shell metachar so the escape path is exercised too.
    await writeSkill(
      "which-args",
      fixtureSkill("which-args", { args: ["install", "--config=$SECRET", "rest"] }),
      [{ path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }]
    );
    const result = await runCli(["skill", "which", "which-args", "setup"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout.trim();
    // Path appears.
    expect(out).toContain(
      path.join(currentStorageRoot(), "skills", "which-args", "bin", "setup")
    );
    // All three signed args appear (the second arg's `$` must be quoted, so
    // we look for the value inside the escape — `'--config=$SECRET'`).
    expect(out).toContain("install");
    expect(out).toContain("'--config=$SECRET'");
    expect(out).toContain("rest");
    expect(out).toContain("# cwd: ");
  });

  it("'skill which' ignores benign OS metadata artifacts", async () => {
    await writeSkill("which-finder", fixtureSkill("which-finder"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    const skillRoot = path.join(currentStorageRoot(), "skills", "which-finder");
    await fs.writeFile(path.join(skillRoot, ".DS_Store"), "finder\n", "utf-8");

    const result = await runCli(["skill", "which", "which-finder", "setup"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(path.join(skillRoot, "bin", "setup"));
  });

  it("doctor --clean --json removes only ignored artifacts", async () => {
    await writeSkill("doctor-finder", fixtureSkill("doctor-finder"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    const skillRoot = path.join(currentStorageRoot(), "skills", "doctor-finder");
    await fs.writeFile(path.join(skillRoot, ".DS_Store"), "finder\n", "utf-8");
    await fs.writeFile(path.join(skillRoot, ".env"), "SECRET=x\n", "utf-8");

    const result = await runCli(["doctor", "doctor-finder", "--clean", "--json"]);
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      summary: { cleaned: number; errors: number };
      skills: Array<{ cleaned: string[]; integrity: { kind: string } }>;
    };
    expect(parsed.summary.cleaned).toBe(1);
    expect(parsed.summary.errors).toBe(1);
    expect(parsed.skills[0]?.cleaned).toEqual([".DS_Store"]);
    expect(parsed.skills[0]?.integrity.kind).toBe("tampered");
    await expect(fs.access(path.join(skillRoot, ".DS_Store"))).rejects.toThrow();
    await expect(fs.access(path.join(skillRoot, ".env"))).resolves.toBeUndefined();
  });

  it("doctor --repair signs an unsigned valid local skill and records local source metadata", async () => {
    const name = "unsigned-repair";
    const root = skillDir(name);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "SKILL.md"), simpleSkill(name), "utf-8");

    const result = await runCli(["doctor", name, "--repair", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      summary: { ok: number; errors: number };
      skills: Array<{ repaired: boolean; repair_status: string; repair_reason: string }>;
    };
    expect(parsed.summary).toMatchObject({ ok: 1, errors: 0 });
    expect(parsed.skills[0]).toMatchObject({
      repaired: true,
      repair_status: "repaired"
    });
    expect(parsed.skills[0]?.repair_reason).toMatch(/local:unsigned-repair/);
    await expect(verifyInstalledIntegrity(name)).resolves.toMatchObject({ kind: "ok" });
    const source = await readSkillSourceStatus(name);
    expect(source.kind).toBe("present");
    if (source.kind === "present") {
      expect(source.source.source).toBe("local");
      expect(source.source.identifier).toBe("local:unsigned-repair");
      expect(source.source.contentHash).toBe(bundleHash(simpleSkill(name), []));
    }
  });

  it("doctor --repair re-signs a local-source SKILL.md edit and preserves its identifier", async () => {
    const name = "local-repair";
    const updated = `${simpleSkill(name)}\n## Local edit\n`;
    await writeSkill(name, simpleSkill(name), [], {
      source: "local",
      identifier: "vendor/local-repair",
      fetchedAt: new Date().toISOString(),
      contentHash: "oldhash"
    });
    await fs.writeFile(path.join(skillDir(name), "SKILL.md"), updated, "utf-8");
    await expect(verifyInstalledIntegrity(name)).resolves.toMatchObject({ kind: "tampered" });

    const result = await runCli(["doctor", name, "--repair", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      skills: Array<{ repaired: boolean; repair_status: string; repair_reason: string }>;
    };
    expect(parsed.skills[0]).toMatchObject({ repaired: true, repair_status: "repaired" });
    await expect(verifyInstalledIntegrity(name)).resolves.toMatchObject({ kind: "ok" });
    const source = await readSkillSourceStatus(name);
    expect(source.kind).toBe("present");
    if (source.kind === "present") {
      expect(source.source.identifier).toBe("vendor/local-repair");
      expect(source.source.contentHash).toBe(bundleHash(updated, []));
    }
  });

  it("doctor gives source-bundle reinstall guidance for local signature tampering", async () => {
    const name = "local-source-guidance";
    const sourceDir = path.join(currentStorageRoot(), "source bundles", name);
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), simpleSkill(name), "utf-8");
    await writeSkill(name, simpleSkill(name), [], {
      source: "local",
      identifier: sourceDir,
      fetchedAt: new Date().toISOString(),
      contentHash: bundleHash(simpleSkill(name), [])
    });
    await fs.writeFile(path.join(skillDir(name), "SKILL.md"), `${simpleSkill(name)}\n# Tampered\n`, "utf-8");

    const result = await runCli(["doctor", name, "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      skills: Array<{ actions: string[]; integrity: { kind: string } }>;
    };
    expect(parsed.skills[0]?.integrity.kind).toBe("tampered");
    const actions = parsed.skills[0]?.actions.join("\n") ?? "";
    expect(actions).toContain("The vaulted copy was edited after signing");
    expect(actions).toContain("Do not edit");
    expect(actions).toContain(`autovault add-local '${sourceDir}' --sync-profiles`);
    expect(actions).toContain(`autovault doctor ${name} --repair`);
  });

  it("doctor reports advisory plugin cache collisions without changing plugin caches", async () => {
    const name = "plugin-shadow-target";
    const fakeHome = path.join(currentStorageRoot(), "plugin-home");
    const cursorRoot = path.join(fakeHome, ".cursor", "plugins", "cache");
    const claudeRoot = path.join(fakeHome, ".claude", "plugins");
    const skillMd = simpleSkill(name);
    await writeSkill(name, skillMd, [], {
      source: "local",
      identifier: "vendor/plugin-shadow-target",
      fetchedAt: new Date().toISOString(),
      contentHash: bundleHash(skillMd, [])
    });

    const cursorNamed = await writePluginSkill(
      cursorRoot,
      "cursor-public/superpowers/hash-one",
      name
    );
    const cursorAlias = await writePluginSkill(
      cursorRoot,
      "cursor-public/684/hash-one",
      name
    );
    const claude = await writePluginSkill(
      claudeRoot,
      "cache/claude-plugins-official/superpowers/6.3.0",
      name
    );
    await writePluginSkill(cursorRoot, "cursor-public/unrelated/hash-two", "unrelated-plugin-skill");

    const result = await runCli(["doctor", name, "--json"], {
      env: { HOME: fakeHome }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      summary: { plugin_shadowed: number; warnings: number; errors: number };
      plugin_scan: {
        scanned_skill_files: number;
        incomplete: boolean;
        truncation_reasons: string[];
      };
      skills: Array<{
        status: string;
        plugin_shadows: Array<{
          category: string;
          evidence: string;
          advisory: boolean;
          host: string;
          plugin: string;
          skill_md_path: string;
        }>;
        actions: string[];
      }>;
    };
    expect(parsed.summary).toMatchObject({ plugin_shadowed: 1, warnings: 1, errors: 0 });
    expect(parsed.plugin_scan).toMatchObject({
      scanned_skill_files: 4,
      incomplete: false,
      truncation_reasons: []
    });
    expect(parsed.skills[0]?.status).toBe("warning");
    expect(parsed.skills[0]?.plugin_shadows).toEqual([
      {
        category: "plugin-shadowed",
        evidence: "cached_collision",
        advisory: true,
        host: "claude-code",
        plugin: "cache/claude-plugins-official/superpowers/6.3.0",
        skill_md_path: claude
      },
      {
        category: "plugin-shadowed",
        evidence: "cached_collision",
        advisory: true,
        host: "cursor",
        plugin: "cursor-public/684/hash-one",
        skill_md_path: cursorAlias
      },
      {
        category: "plugin-shadowed",
        evidence: "cached_collision",
        advisory: true,
        host: "cursor",
        plugin: "cursor-public/superpowers/hash-one",
        skill_md_path: cursorNamed
      }
    ]);
    expect(parsed.skills[0]?.actions.join("\n")).toContain(
      "Cached plugin copies can shadow vault skills"
    );
    await expect(fs.readFile(cursorNamed, "utf-8")).resolves.toBe(simpleSkill(name));
    await expect(fs.readFile(cursorAlias, "utf-8")).resolves.toBe(simpleSkill(name));
    await expect(fs.readFile(claude, "utf-8")).resolves.toBe(simpleSkill(name));

    const human = await runCli(["doctor", name], { env: { HOME: fakeHome } });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("plugin cache collision");
    expect(human.stdout).toContain("claude-code");
    expect(human.stdout).toContain("cursor");
  });

  it("doctor handles prototype-named and oversized plugin skills safely", async () => {
    const name = "constructor";
    const fakeHome = path.join(currentStorageRoot(), "plugin-edge-home");
    const cursorRoot = path.join(fakeHome, ".cursor", "plugins", "cache");
    const skillMd = simpleSkill(name);
    await writeSkill(name, skillMd, [], {
      source: "local",
      identifier: "vendor/constructor",
      fetchedAt: new Date().toISOString(),
      contentHash: bundleHash(skillMd, [])
    });

    const matching = await writePluginSkill(cursorRoot, "vendor/plugin/1.0.0", name);
    const oversized = path.join(cursorRoot, "vendor", "oversized", "1.0.0", "skills", "SKILL.md");
    await fs.mkdir(path.dirname(oversized), { recursive: true });
    await fs.writeFile(oversized, `${simpleSkill(name)}${"x".repeat(MAX_SKILL_MD_BYTES)}`, "utf-8");

    const result = await runCli(["doctor", name, "--json"], { env: { HOME: fakeHome } });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      skills: Array<{ plugin_shadows: Array<{ skill_md_path: string }> }>;
    };
    expect(parsed.skills[0]?.plugin_shadows).toEqual([{
      category: "plugin-shadowed",
      evidence: "cached_collision",
      advisory: true,
      host: "cursor",
      plugin: "vendor/plugin/1.0.0",
      skill_md_path: matching
    }]);
  });

  it("doctor never recommends reinstalling from a self-referential vault source", async () => {
    const name = "self-referential-local-source";
    const vaultDir = skillDir(name);
    const skillMd = simpleSkill(name);
    await writeSkill(name, skillMd, [], {
      source: "local",
      identifier: vaultDir,
      fetchedAt: new Date().toISOString(),
      contentHash: bundleHash(skillMd, [])
    });
    await fs.writeFile(path.join(vaultDir, "SKILL.md"), `${skillMd}\n# Tampered\n`, "utf-8");
    const result = await runCli(["doctor", name, "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { skills: Array<{ actions: string[] }> };
    const actions = parsed.skills[0]?.actions.join("\n") ?? "";
    expect(actions).toContain("copy the bundle to a working directory outside the vault");
    expect(actions).toContain("autovault add-local '<copied-bundle-path>' --sync-profiles");
    expect(actions).toContain(`autovault doctor ${name} --repair`);
    expect(actions).not.toContain(`autovault add-local '${vaultDir}'`);
  });

  it("doctor treats a SKILL.md beneath the vault as a self-referential local source", async () => {
    const name = "self-referential-local-skill-md";
    const vaultDir = skillDir(name);
    const identifier = path.join(vaultDir, "SKILL.md");
    const skillMd = simpleSkill(name);
    await writeSkill(name, skillMd, [], {
      source: "local",
      identifier,
      fetchedAt: new Date().toISOString(),
      contentHash: bundleHash(skillMd, [])
    });
    await fs.writeFile(identifier, `${skillMd}\n# Tampered\n`, "utf-8");

    const result = await runCli(["doctor", name, "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { skills: Array<{ actions: string[] }> };
    const actions = parsed.skills[0]?.actions.join("\n") ?? "";
    expect(actions).toContain("copy the bundle to a working directory outside the vault");
    expect(actions).toContain("autovault add-local '<copied-bundle-path>' --sync-profiles");
    expect(actions).not.toContain(`autovault add-local '${identifier}'`);
    expect(actions).toContain(`autovault doctor ${name} --repair`);
  });

  it("doctor treats a source under another installed skill as self-referential", async () => {
    const name = "self-referential-sibling-source";
    const siblingName = "self-referential-sibling-vault";
    const siblingSource = skillDir(siblingName);
    const skillMd = simpleSkill(name);
    await writeSkill(siblingName, simpleSkill(siblingName));
    await writeSkill(name, skillMd, [], {
      source: "local",
      identifier: siblingSource,
      fetchedAt: new Date().toISOString(),
      contentHash: bundleHash(skillMd, [])
    });
    await fs.writeFile(path.join(skillDir(name), "SKILL.md"), `${skillMd}\n# Tampered\n`, "utf-8");

    const result = await runCli(["doctor", name, "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { skills: Array<{ actions: string[] }> };
    const actions = parsed.skills[0]?.actions.join("\n") ?? "";
    expect(actions).toContain("copy the bundle to a working directory outside the vault");
    expect(actions).toContain("autovault add-local '<copied-bundle-path>' --sync-profiles");
    expect(actions).not.toContain(`autovault add-local '${siblingSource}'`);
    expect(actions).toContain(`autovault doctor ${name} --repair`);
  });

  it.each([
    ["an external hard-linked SKILL.md", "file"],
    ["an external directory containing a hard-linked SKILL.md", "directory"]
  ] as const)("doctor treats %s as self-referential", async (_description, sourceKind) => {
    const name = `hard-linked-vault-source-${sourceKind}`;
    const externalDir = path.join(currentStorageRoot(), `external-hard-link-${sourceKind}`);
    const externalSkillMd = path.join(externalDir, "SKILL.md");
    const identifier = sourceKind === "file" ? externalSkillMd : externalDir;
    const skillMd = simpleSkill(name);
    await fs.mkdir(externalDir, { recursive: true });
    await writeSkill(name, skillMd, [], {
      source: "local",
      identifier,
      fetchedAt: new Date().toISOString(),
      contentHash: bundleHash(skillMd, [])
    });
    const vaultedSkillMd = path.join(skillDir(name), "SKILL.md");
    await fs.link(vaultedSkillMd, externalSkillMd);
    await fs.writeFile(vaultedSkillMd, `${skillMd}\n# Tampered\n`, "utf-8");

    const result = await runCli(["doctor", name, "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { skills: Array<{ actions: string[] }> };
    const actions = parsed.skills[0]?.actions.join("\n") ?? "";
    expect(actions).toContain("copy the bundle to a working directory outside the vault");
    expect(actions).toContain("autovault add-local '<copied-bundle-path>' --sync-profiles");
    expect(actions).not.toContain(`autovault add-local '${identifier}'`);
    expect(actions).toContain(`autovault doctor ${name} --repair`);
  });

  it("doctor recognizes a self-referential vault source through a symlink", async () => {
    const name = "symlinked-self-referential-local-source";
    const vaultDir = skillDir(name);
    const aliasRoot = path.join(currentStorageRoot(), "vault-alias");
    const alias = path.join(aliasRoot, name);
    const skillMd = simpleSkill(name);
    await fs.symlink(path.join(currentStorageRoot(), "skills"), aliasRoot, "dir");
    await writeSkill(name, skillMd, [], {
      source: "local",
      identifier: alias,
      fetchedAt: new Date().toISOString(),
      contentHash: bundleHash(skillMd, [])
    });
    await fs.writeFile(path.join(vaultDir, "SKILL.md"), `${skillMd}\n# Tampered\n`, "utf-8");
    expect(await fs.realpath(alias)).toBe(await fs.realpath(vaultDir));

    const result = await runCli(["doctor", name, "--json"]);

    const parsed = JSON.parse(result.stdout) as { skills: Array<{ actions: string[] }> };
    const actions = parsed.skills[0]?.actions.join("\n") ?? "";
    expect(actions).toContain("copy the bundle to a working directory outside the vault");
    expect(actions).not.toContain(`autovault add-local '${alias}'`);
  });

  it("doctor --repair refuses to bless remote-source tampering", async () => {
    const name = "remote-repair";
    await writeSkill(name, simpleSkill(name), [], {
      source: "github",
      identifier: "owner/repo",
      fetchedAt: new Date().toISOString(),
      contentHash: "oldhash",
      upstreamSha: "0123456789abcdef0123456789abcdef01234567"
    });
    await fs.writeFile(path.join(skillDir(name), "SKILL.md"), `${simpleSkill(name)}\n# Tampered\n`, "utf-8");

    const result = await runCli(["doctor", name, "--repair", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      skills: Array<{ repaired: boolean; repair_status: string; repair_reason: string }>;
    };
    expect(parsed.skills[0]).toMatchObject({
      repaired: false,
      repair_status: "refused"
    });
    expect(parsed.skills[0]?.repair_reason).toMatch(/remote source 'github'/);
    await expect(verifyInstalledIntegrity(name)).resolves.toMatchObject({ kind: "tampered" });
  });

  it("doctor --repair refuses an invalid current bundle without writing a manifest", async () => {
    const name = "invalid-repair";
    const root = skillDir(name);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "SKILL.md"), simpleSkill(name), "utf-8");
    await fs.writeFile(path.join(root, "extra.md"), "not declared\n", "utf-8");

    const result = await runCli(["doctor", name, "--repair", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      skills: Array<{ repaired: boolean; repair_status: string; repair_reason: string }>;
    };
    expect(parsed.skills[0]).toMatchObject({
      repaired: false,
      repair_status: "refused"
    });
    expect(parsed.skills[0]?.repair_reason).toMatch(/Bundle validation failed/);
    await expect(fs.access(path.join(root, ".autovault-manifest"))).rejects.toThrow();
  });

  it("'skill which' resolves a backslash-form bin command via canonical normalization (round-32)", async () => {
    // Round 32 finding: validation canonicalizes bin\setup → bin/setup for
    // resource matching, and writeSkill stores/signs resources under the
    // canonical (forward-slash) form. The CLI used to take entry.command
    // literally and try to resolve `bin\setup` as a real POSIX filename, so
    // the install succeeded but every which/exec call failed with "not
    // accessible." This test pins all four canonicalization sites in
    // agreement (validate, write, manifest-verify, CLI-resolve) by installing
    // a backslash-form command and asserting `which` resolves it to the
    // forward-slash path that was actually written and signed.
    const skillMd = `---
name: bs-cmd
description: A description that is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin\\setup
    requires-tty: false
---

# Body
`;
    await writeSkill("bs-cmd", skillMd, [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    const result = await runCli(["skill", "which", "bs-cmd", "setup"]);
    expect(result.exitCode).toBe(0);
    const expectedPath = path.join(
      currentStorageRoot(),
      "skills",
      "bs-cmd",
      "bin",
      "setup"
    );
    expect(result.stdout).toContain(expectedPath);
    // Without the canonical-resolve fix, the CLI would have failed with
    // "not accessible" on the literal-backslash filename.
    expect(result.stderr).not.toMatch(/not accessible/i);
  });

  // Round-44 fix: writeSkill stages live → bak → live; if the process dies
  // between rename(live, bak) and rename(tmp, live) the skill exists only
  // under `<name>.bak.<rand>`. recoverOrphanBackups rolls that backup
  // forward, but it was previously only wired into MCP server startup.
  // The user-facing `autovault skill` CLI is exactly the surface that
  // would expose the strand: `skill list` or `skill which` after a crash
  // would silently hide a valid backup until something else (an MCP host)
  // started. The fix calls recoverOrphanBackups in runSkillCommand.
  it("rolls forward an orphan .bak.* skill before listing (round-44)", async () => {
    // First install the skill normally so it ends up fully formed on disk
    // (SKILL.md, manifest, source.json, resources).
    await writeSkill("crash-victim", fixtureSkill("crash-victim"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    // Then move the live dir into a `.bak.*` suffix to simulate a crash
    // between rename(live, bak) and rename(tmp, live). The live name no
    // longer exists; without recovery the CLI would not see this skill.
    const liveDir = path.join(currentStorageRoot(), "skills", "crash-victim");
    const bakDir = path.join(
      currentStorageRoot(),
      "skills",
      "crash-victim.bak.1234567890"
    );
    await fs.rename(liveDir, bakDir);

    const result = await runCli(["skill", "list"]);
    expect(result.exitCode).toBe(0);
    // Recovery rolled the backup forward — the CLI now sees the skill.
    expect(result.stdout).toMatch(/crash-victim/);
    // And the live directory exists again on disk.
    await expect(fs.stat(liveDir)).resolves.toBeTruthy();
  });

  it("refuses to exec when bin/setup has been swapped to a symlink (round-53)", async () => {
    // Round 53 finding: assertWithinStorage was a TEXTUAL prefix check on the
    // computed path. fs.stat / fs.readFile / spawn() all FOLLOW symlinks, so a
    // post-install swap of bin/setup → a symlink pointing at an external file
    // (or any inode the attacker controls) would (a) stat as a regular file,
    // (b) read attacker-controlled bytes that, by content match, could still
    // verify against the manifest, and (c) execve the attacker file.
    //
    // The fix realpath's both sides and rejects any symlink at the bin path.
    // This test pins the protection: replace bin/setup with a symlink to an
    // out-of-vault file with identical content, run the action, expect refusal
    // with the dedicated symlink message and no exec.
    await writeSkill("symlink-bin", fixtureSkill("symlink-bin"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho should-not-run\n" }
    ]);
    const setupPath = path.join(currentStorageRoot(), "skills", "symlink-bin", "bin", "setup");
    const externalDir = await fs.mkdtemp(path.join(currentStorageRoot(), "..", "external-"));
    const externalTarget = path.join(externalDir, "evil");
    // Same bytes as the signed bin/setup so a content-only verify would pass
    // — only the symlink rejection blocks this.
    await fs.writeFile(externalTarget, "#!/usr/bin/env bash\necho should-not-run\n", {
      mode: 0o755
    });
    await fs.unlink(setupPath);
    await fs.symlink(externalTarget, setupPath);

    const result = await runCli(["skill", "setup", "symlink-bin"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/symbolic link/i);
    // Critically, the script must not have executed through the symlink.
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("'skill which' refuses to print when bin path is a symlink (round-53)", async () => {
    // The review surface must match the exec surface: if `which` printed a
    // path that resolved through a symlink, a user piping that into another
    // tool (or just trusting that path was vault-local) would be misled. The
    // CLI rejects symlinks at the same gate as exec.
    await writeSkill("which-symlink", fixtureSkill("which-symlink"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    const setupPath = path.join(currentStorageRoot(), "skills", "which-symlink", "bin", "setup");
    const externalDir = await fs.mkdtemp(path.join(currentStorageRoot(), "..", "which-external-"));
    const externalTarget = path.join(externalDir, "decoy");
    await fs.writeFile(externalTarget, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    await fs.unlink(setupPath);
    await fs.symlink(externalTarget, setupPath);

    const result = await runCli(["skill", "which", "which-symlink", "setup"]);
    expect(result.exitCode).not.toBe(0);
    // Round-60 widened the gate: the integrity walk catches the symlink as
    // unmanifested_file before the per-action symlink check, so either form
    // is a valid refusal. The security property is the same: refuse, no
    // external-path leak in stdout.
    expect(result.stderr).toMatch(/symbolic link|unmanifested_file/i);
    expect(result.stdout).not.toContain(externalTarget);
  });

  it("refuses to exec when an unsigned sibling file is dropped into the skill dir (round-60)", async () => {
    // Closed-set verify (SKILL.md + bin file each individually signed) is
    // not enough. The bin script runs with cwd set to the skill directory,
    // so a signed wrapper that does `source ./lib/helper.sh` would happily
    // pull in attacker-placed unsigned code without modifying any signed
    // file. Walk the live directory and refuse on any unmanifested file
    // before exec — turn the closed-set check into an open-set check.
    await writeSkill("sibling-inject", fixtureSkill("sibling-inject"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho clean\n" }
    ]);
    const skillRoot = path.join(currentStorageRoot(), "skills", "sibling-inject");
    await fs.mkdir(path.join(skillRoot, "lib"), { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "lib", "helper.sh"),
      "#!/usr/bin/env bash\necho injected\n",
      "utf-8"
    );

    const result = await runCli(["skill", "setup", "sibling-inject"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/integrity check failed/i);
    expect(result.stderr).toMatch(/lib\/helper\.sh/);
    expect(result.stderr).toMatch(/unmanifested_file/);
    expect(result.stdout).not.toContain("clean");
    expect(result.stdout).not.toContain("injected");
  });

  it("'skill which' refuses to print when an unsigned sibling file is present (round-60)", async () => {
    // Same gap, review surface. A user inspecting `skill which` before
    // running expects it to represent the whole signed install — a
    // sibling injection invalidates that promise.
    await writeSkill("which-sibling", fixtureSkill("which-sibling"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    const skillRoot = path.join(currentStorageRoot(), "skills", "which-sibling");
    await fs.writeFile(
      path.join(skillRoot, "rogue.txt"),
      "untracked\n",
      "utf-8"
    );

    const result = await runCli(["skill", "which", "which-sibling", "setup"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/integrity check failed/i);
    expect(result.stderr).toMatch(/rogue\.txt/);
    expect(result.stderr).toMatch(/unmanifested_file/);
  });

  it("'skill which' refuses to print after SKILL.md is tampered", async () => {
    // Without manifest-verified SKILL.md, an attacker who edits the on-disk
    // SKILL.md can make `which` print an arbitrary path — which is dangerous
    // because the documented automation pattern shells out to it. The CLI must
    // refuse to print on tamper, not print stale-or-attacker content.
    await writeSkill("which-tamper", fixtureSkill("which-tamper"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    const skillMdPath = path.join(currentStorageRoot(), "skills", "which-tamper", "SKILL.md");
    const original = await fs.readFile(skillMdPath, "utf-8");
    const tampered = original.replace("command: bin/setup", "command: ../escape");
    expect(tampered).not.toBe(original);
    await fs.writeFile(skillMdPath, tampered, "utf-8");

    const result = await runCli(["skill", "which", "which-tamper", "setup"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/SKILL\.md signature mismatch/i);
    expect(result.stdout).not.toContain("escape");
  });
});
