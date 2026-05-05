import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeSkill } from "../src/storage/index.js";
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

describe("autovault skill CLI", () => {
  it("prints usage when no subcommand is given", async () => {
    const result = await runCli(["skill"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Usage:/);
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
    expect(result.stdout).toMatch(/alpha:/);
    expect(result.stdout).toMatch(/setup/);
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
    expect(result.stderr).toMatch(/symbolic link/i);
    expect(result.stdout).not.toContain(externalTarget);
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
