import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addLocalSkill } from "../src/installer/local.js";
import { runDoctorReport } from "../src/cli/doctor.js";
import { currentStorageRoot } from "./setup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const skillName = "codex-docs-drift-scout";
const repoSkillDir = path.join(repoRoot, "skills", skillName);
const repoBin = path.join(repoSkillDir, "bin", "codex-bundle");

function runBundle(
  scriptPath: string,
  args: string[],
  env: Record<string, string> = {},
  cwd = repoRoot
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [scriptPath, ...args], {
      cwd,
      env: { ...process.env, HOME: os.homedir(), ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Install the tracked demo skill into the per-test temp vault, then hand back
// the path to the VAULT COPY of the bin helper. The check verifies the signed
// vault copy, so the render must run from there — not the repo tree.
async function installVaultSkill(): Promise<string> {
  const result = await addLocalSkill({ skillDir: repoSkillDir });
  if (!result.success) {
    throw new Error(`vault install failed: ${result.validation.errors.join("; ")}`);
  }
  return path.join(currentStorageRoot(), "skills", skillName, "bin", "codex-bundle");
}

async function makeScratch(): Promise<{ projectRoot: string; codexHome: string }> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "autovault-codex-scratch-"));
  const projectRoot = path.join(scratch, "autohub");
  const codexHome = path.join(scratch, ".codex");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.join(codexHome, "automations"), { recursive: true });
  return { projectRoot, codexHome };
}

function renderFor(
  report: Awaited<ReturnType<typeof runDoctorReport>>,
  name: string
) {
  const skill = report.skills.find((entry) => entry.name === name);
  if (!skill) throw new Error(`skill ${name} not present in doctor report`);
  return skill.render;
}

describe("Codex docs drift bundle helper + autovault doctor render fidelity", () => {
  it("renders from the signed vault copy and doctor reports render fidelity ok", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const resolvedProjectRoot = await fs.realpath(projectRoot);
    const beforeInstall = Date.now();

    const install = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(install, install.stderr).toMatchObject({ code: 0 });

    const renderRoot = path.join(
      currentStorageRoot(),
      "rendered",
      "codex-automations",
      "docs-drift-scout"
    );
    const automationPath = path.join(renderRoot, "automation.toml");
    const environmentPath = path.join(renderRoot, "environment.toml");
    const automation = await fs.readFile(automationPath, "utf8");
    const environment = await fs.readFile(environmentPath, "utf8");
    expect(automation).toContain(`cwds = ["${resolvedProjectRoot}"]`);
    expect(automation).toContain(
      `target = { type = "project", project_id = "${resolvedProjectRoot}" }`
    );
    expect(automation).toContain(`local_environment_config_path = "${environmentPath}"`);
    expect(automation).toContain("npm run --silent autovault:audit");
    expect(automation).toContain("$copilot-review");
    expect(automation).not.toContain("COPILOT_REVIEW_SKILL");
    const createdAt = Number(automation.match(/^created_at = (\d+)$/m)?.[1]);
    const updatedAt = Number(automation.match(/^updated_at = (\d+)$/m)?.[1]);
    expect(createdAt).toBeGreaterThanOrEqual(beforeInstall - 999);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
    expect(updatedAt).toBe(createdAt);
    expect(automation).not.toContain("{{");
    expect(environment).toContain('name = "autohub"');
    expect(environment).toContain('cd "${CODEX_WORKTREE_PATH:?CODEX_WORKTREE_PATH is required}"');
    expect(environment).toContain("set -uo pipefail");
    expect(environment).not.toContain("{{");

    // The render index lives OUTSIDE rendered/, a sibling under the storage root.
    const indexRaw = await fs.readFile(
      path.join(currentStorageRoot(), "render-index.json"),
      "utf8"
    );
    const index = JSON.parse(indexRaw);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].skill).toBe(skillName);
    expect(index.entries[0].templates).toHaveLength(2);
    expect(index.entries[0].rendered).toHaveLength(2);

    const linkPath = path.join(codexHome, "automations", "docs-drift-scout");
    await expect(fs.readlink(linkPath)).resolves.toBe(renderRoot);

    const report = await runDoctorReport({});
    expect(renderFor(report, skillName)).toMatchObject({ kind: "ok" });
    expect(report.summary.errors).toBe(0);
  });

  it("reports skipped (not ok) for a vault-installed skill never rendered here", async () => {
    await installVaultSkill();
    const report = await runDoctorReport({});
    expect(renderFor(report, skillName).kind).toBe("skipped");
    expect(report.summary.errors).toBe(0);
  });

  it("flags a hand-edited rendered file as an error", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const install = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(install, install.stderr).toMatchObject({ code: 0 });

    const automationPath = path.join(
      currentStorageRoot(),
      "rendered",
      "codex-automations",
      "docs-drift-scout",
      "automation.toml"
    );
    await fs.appendFile(automationPath, "\n# local drift\n");

    const report = await runDoctorReport({});
    const render = renderFor(report, skillName);
    expect(render.kind).toBe("error");
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it("flags a deleted render dir as an error even when scoped (entry + symlink survive)", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const install = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(install, install.stderr).toMatchObject({ code: 0 });

    const renderRoot = path.join(
      currentStorageRoot(),
      "rendered",
      "codex-automations",
      "docs-drift-scout"
    );
    // Routine accident: wipe rendered/ but leave the index entry and the live
    // ~/.codex symlink behind. Because the index lives outside rendered/, the
    // evidence survives and the missing rendered files surface as errors.
    await fs.rm(renderRoot, { recursive: true, force: true });

    const report = await runDoctorReport({ skill: skillName });
    expect(renderFor(report, skillName).kind).toBe("error");
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it("flags an orphan symlink (entry deleted, symlink live) as a global error, not skipped", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();

    const installA = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(installA, installA.stderr).toMatchObject({ code: 0 });

    const installB = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot,
      "--automation-id",
      "docs-drift-scout-extra"
    ], { CODEX_HOME: codexHome });
    expect(installB, installB.stderr).toMatchObject({ code: 0 });

    // Delete entry B from the index but leave its ~/.codex symlink live. Entry A
    // keeps the managed link root in the closed set, so the orphan sweep scans
    // ~/.codex/automations and catches the dangling symlink.
    const indexPath = path.join(currentStorageRoot(), "render-index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    index.entries = index.entries.filter(
      (entry: { symlink: string }) => !entry.symlink.endsWith("docs-drift-scout-extra")
    );
    expect(index.entries).toHaveLength(1);
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    const orphanLink = path.join(codexHome, "automations", "docs-drift-scout-extra");
    await expect(fs.lstat(orphanLink)).resolves.toBeTruthy();

    const report = await runDoctorReport({});
    // Entry A is intact, so the skill itself is still ok — the orphan is a
    // report-level error, NOT a per-skill render failure.
    expect(renderFor(report, skillName).kind).toBe("ok");
    expect(report.render.orphans.length).toBeGreaterThan(0);
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it("flags the sole live Codex symlink when the render index is deleted", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const install = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(install, install.stderr).toMatchObject({ code: 0 });

    await fs.rm(path.join(currentStorageRoot(), "render-index.json"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const report = await runDoctorReport({});
      expect(report.render.index).toBe("absent");
      expect(report.render.orphans).toEqual([
        path.join(codexHome, "automations", "docs-drift-scout")
      ]);
      expect(report.summary.errors).toBeGreaterThan(0);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("errors when a template was edited after signing (step 1: template integrity)", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const install = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(install, install.stderr).toMatchObject({ code: 0 });

    // Edit the vaulted template after signing, WITHOUT repair. The signature no
    // longer covers these bytes, so the integrity walk refuses to hand them back.
    const vaultTemplate = path.join(
      currentStorageRoot(),
      "skills",
      skillName,
      "resources",
      "codex",
      "automation.toml.tpl"
    );
    await fs.appendFile(vaultTemplate, "\n# tampered template\n");

    const report = await runDoctorReport({ skill: skillName });
    const render = renderFor(report, skillName);
    expect(render.kind).toBe("error");
    expect(render.kind === "error" && render.problems.join("; ")).toMatch(
      /template integrity check failed/
    );
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it("errors when a template changed since render even after repair re-signs it (step 2: staleness)", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const install = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(install, install.stderr).toMatchObject({ code: 0 });

    // Change the vaulted template (records were taken against the v1 bytes).
    const vaultTemplate = path.join(
      currentStorageRoot(),
      "skills",
      skillName,
      "resources",
      "codex",
      "automation.toml.tpl"
    );
    await fs.appendFile(vaultTemplate, "\n# template moved on, never re-rendered\n");

    // --repair re-signs the CHANGED bytes, so template integrity (step 1) passes
    // again. Render fidelity is checked AFTER repair, so the staleness branch
    // (recorded template hash != current verified template hash) is what fires.
    const report = await runDoctorReport({ skill: skillName, repair: true });
    const skill = report.skills.find((entry) => entry.name === skillName);
    if (!skill) throw new Error("skill missing from report");
    expect(skill.repair_status).toBe("repaired");
    expect(skill.integrity.kind).toBe("ok");
    expect(skill.render.kind).toBe("error");
    expect(skill.render.kind === "error" && skill.render.problems.join("; ")).toMatch(
      /changed since render/
    );
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it("errors when the codex symlink is repointed away from the render root (step 4)", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const install = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(install, install.stderr).toMatchObject({ code: 0 });

    const linkPath = path.join(codexHome, "automations", "docs-drift-scout");
    await fs.unlink(linkPath);
    await fs.symlink(projectRoot, linkPath);

    const report = await runDoctorReport({ skill: skillName });
    const render = renderFor(report, skillName);
    expect(render.kind).toBe("error");
    expect(render.kind === "error" && render.problems.join("; ")).toMatch(/symlink points at/);
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it("surfaces a corrupt render index as a report-level error", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const install = await runBundle(vaultBin, [
      "install",
      "--project-root",
      projectRoot
    ], { CODEX_HOME: codexHome });
    expect(install, install.stderr).toMatchObject({ code: 0 });

    const indexPath = path.join(currentStorageRoot(), "render-index.json");
    await fs.writeFile(indexPath, "{ this is not valid json", "utf8");

    const report = await runDoctorReport({});
    expect(report.render.index).toBe("corrupt");
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it("rejects an existing non-symlink before writing rendered state", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const linkPath = path.join(codexHome, "automations", "docs-drift-scout");
    await fs.mkdir(linkPath);

    const install = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot],
      { CODEX_HOME: codexHome }
    );
    expect(install.code).not.toBe(0);
    expect(install.stderr).toContain("exists and is not a symlink");
    await expect(
      fs.lstat(
        path.join(
          currentStorageRoot(),
          "rendered",
          "codex-automations",
          "docs-drift-scout"
        )
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(currentStorageRoot(), "render-index.json"))).rejects.toMatchObject(
      { code: "ENOENT" }
    );
  });

  it("moves an existing non-symlink aside only with --replace-existing", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const automationRoot = path.join(codexHome, "automations");
    const linkPath = path.join(automationRoot, "docs-drift-scout");
    await fs.mkdir(linkPath);
    await fs.writeFile(path.join(linkPath, "keep.txt"), "existing automation\n", "utf8");

    const install = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot, "--replace-existing"],
      { CODEX_HOME: codexHome }
    );
    expect(install, install.stderr).toMatchObject({ code: 0 });
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

    const backups = (await fs.readdir(automationRoot)).filter((name) =>
      name.startsWith("docs-drift-scout.backup.")
    );
    expect(backups).toHaveLength(1);
    await expect(
      fs.readFile(path.join(automationRoot, backups[0], "keep.txt"), "utf8")
    ).resolves.toBe("existing automation\n");
  });

  it("refuses an unmanaged symlink unless --replace-existing preserves it", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const automationRoot = path.join(codexHome, "automations");
    const linkPath = path.join(automationRoot, "docs-drift-scout");
    const unmanagedTarget = path.join(path.dirname(projectRoot), "unmanaged-automation");
    await fs.mkdir(unmanagedTarget);
    await fs.symlink(unmanagedTarget, linkPath);

    const refused = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot],
      { CODEX_HOME: codexHome }
    );
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("exists and is not managed by AutoVault");
    await expect(fs.readlink(linkPath)).resolves.toBe(unmanagedTarget);
    await expect(fs.lstat(path.join(currentStorageRoot(), "render-index.json"))).rejects.toMatchObject(
      { code: "ENOENT" }
    );

    const replaced = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot, "--replace-existing"],
      { CODEX_HOME: codexHome }
    );
    expect(replaced, replaced.stderr).toMatchObject({ code: 0 });
    const backups = (await fs.readdir(automationRoot)).filter((name) =>
      name.startsWith("docs-drift-scout.backup.")
    );
    expect(backups).toHaveLength(1);
    await expect(fs.readlink(path.join(automationRoot, backups[0]))).resolves.toBe(
      unmanagedTarget
    );
  });

  it("derives a relative AUTOVAULT_STORAGE_PATH from the installed skill", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const installedSkillRoot = path.dirname(path.dirname(vaultBin));

    const install = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot],
      {
        AUTOVAULT_STORAGE_PATH: path.basename(currentStorageRoot()),
        CODEX_HOME: codexHome
      },
      installedSkillRoot
    );

    expect(install, install.stderr).toMatchObject({ code: 0 });
    await expect(fs.lstat(path.join(currentStorageRoot(), "render-index.json"))).resolves.toBeDefined();
    await expect(
      fs.lstat(path.join(installedSkillRoot, path.basename(currentStorageRoot())))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rehomes an automation without leaving a duplicate render entry or old link", async () => {
    const vaultBin = await installVaultSkill();
    const first = await makeScratch();
    const second = await makeScratch();

    const installA = await runBundle(
      vaultBin,
      ["install", "--project-root", first.projectRoot],
      { CODEX_HOME: first.codexHome }
    );
    expect(installA, installA.stderr).toMatchObject({ code: 0 });

    const installB = await runBundle(
      vaultBin,
      ["install", "--project-root", second.projectRoot],
      { CODEX_HOME: second.codexHome }
    );
    expect(installB, installB.stderr).toMatchObject({ code: 0 });

    const index = JSON.parse(
      await fs.readFile(path.join(currentStorageRoot(), "render-index.json"), "utf8")
    );
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].symlink).toBe(
      path.join(second.codexHome, "automations", "docs-drift-scout")
    );
    await expect(
      fs.lstat(path.join(first.codexHome, "automations", "docs-drift-scout"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readlink(path.join(second.codexHome, "automations", "docs-drift-scout"))
    ).resolves.toBe(index.entries[0].renderRoot);
  });

  it("preserves a healthy install when the replacement link cannot be staged", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const automationRoot = path.join(codexHome, "automations");
    const linkPath = path.join(automationRoot, "docs-drift-scout");
    const firstInstall = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot],
      { CODEX_HOME: codexHome }
    );
    expect(firstInstall, firstInstall.stderr).toMatchObject({ code: 0 });

    const indexPath = path.join(currentStorageRoot(), "render-index.json");
    const automationPath = path.join(
      currentStorageRoot(),
      "rendered",
      "codex-automations",
      "docs-drift-scout",
      "automation.toml"
    );
    const originalIndex = await fs.readFile(indexPath, "utf8");
    const originalAutomation = await fs.readFile(automationPath, "utf8");
    const originalTarget = await fs.readlink(linkPath);
    const replacementProject = path.join(path.dirname(projectRoot), "replacement-project");
    await fs.mkdir(replacementProject);

    await fs.chmod(automationRoot, 0o500);
    let replacement;
    try {
      replacement = await runBundle(
        vaultBin,
        ["install", "--project-root", replacementProject],
        { CODEX_HOME: codexHome }
      );
    } finally {
      await fs.chmod(automationRoot, 0o700);
    }

    expect(replacement.code).not.toBe(0);
    await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(originalIndex);
    await expect(fs.readFile(automationPath, "utf8")).resolves.toBe(originalAutomation);
    await expect(fs.readlink(linkPath)).resolves.toBe(originalTarget);
  });

  it("rolls back a rehome when the old managed link cannot be retired", async () => {
    const vaultBin = await installVaultSkill();
    const first = await makeScratch();
    const second = await makeScratch();
    const firstAutomationRoot = path.join(first.codexHome, "automations");
    const firstLink = path.join(firstAutomationRoot, "docs-drift-scout");
    const secondLink = path.join(second.codexHome, "automations", "docs-drift-scout");
    const firstInstall = await runBundle(
      vaultBin,
      ["install", "--project-root", first.projectRoot],
      { CODEX_HOME: first.codexHome }
    );
    expect(firstInstall, firstInstall.stderr).toMatchObject({ code: 0 });

    const indexPath = path.join(currentStorageRoot(), "render-index.json");
    const automationPath = path.join(
      currentStorageRoot(),
      "rendered",
      "codex-automations",
      "docs-drift-scout",
      "automation.toml"
    );
    const originalIndex = await fs.readFile(indexPath, "utf8");
    const originalAutomation = await fs.readFile(automationPath, "utf8");
    const originalTarget = await fs.readlink(firstLink);

    await fs.chmod(firstAutomationRoot, 0o500);
    let rehome;
    try {
      rehome = await runBundle(
        vaultBin,
        ["install", "--project-root", second.projectRoot],
        { CODEX_HOME: second.codexHome }
      );
    } finally {
      await fs.chmod(firstAutomationRoot, 0o700);
    }

    expect(rehome.code).not.toBe(0);
    await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(originalIndex);
    await expect(fs.readFile(automationPath, "utf8")).resolves.toBe(originalAutomation);
    await expect(fs.readlink(firstLink)).resolves.toBe(originalTarget);
    await expect(fs.lstat(secondLink)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("refuses to replace a corrupt render index", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const indexPath = path.join(currentStorageRoot(), "render-index.json");
    const corruptBytes = "{ definitely not valid json\n";
    await fs.writeFile(indexPath, corruptBytes, "utf8");

    const install = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot],
      { CODEX_HOME: codexHome }
    );
    expect(install.code).not.toBe(0);
    expect(install.stderr).toContain("render index is corrupt");
    await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(corruptBytes);
    await expect(
      fs.lstat(
        path.join(
          currentStorageRoot(),
          "rendered",
          "codex-automations",
          "docs-drift-scout"
        )
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(path.join(codexHome, "automations", "docs-drift-scout"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(currentStorageRoot())).filter((name) =>
        name.startsWith(".codex-bundle.docs-drift-scout.")
      )
    ).toEqual([]);
  });

  it("TOML-escapes project paths without recursively substituting their contents", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const quotedProject = path.join(
      projectRoot,
      'project-"quoted"-{{AUTOMATION_ID}}-{{FOO}}'
    );
    await fs.mkdir(quotedProject);

    const install = await runBundle(
      vaultBin,
      ["install", "--project-root", quotedProject],
      { CODEX_HOME: codexHome }
    );
    expect(install, install.stderr).toMatchObject({ code: 0 });

    const resolvedProject = await fs.realpath(quotedProject);
    const automation = await fs.readFile(
      path.join(
        currentStorageRoot(),
        "rendered",
        "codex-automations",
        "docs-drift-scout",
        "automation.toml"
      ),
      "utf8"
    );
    expect(automation).toContain(`project_id = ${JSON.stringify(resolvedProject)}`);
    expect(automation).toContain(`cwds = [${JSON.stringify(resolvedProject)}]`);
  });

  it("refuses to replace an unsupported render index", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const indexPath = path.join(currentStorageRoot(), "render-index.json");
    const unsupportedBytes = `${JSON.stringify({ version: 2, entries: [] }, null, 2)}\n`;
    await fs.writeFile(indexPath, unsupportedBytes, "utf8");

    const install = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot],
      { CODEX_HOME: codexHome }
    );
    expect(install.code).not.toBe(0);
    expect(install.stderr).toContain("render index is corrupt");
    await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(unsupportedBytes);
  });

  it("does not publish rendered state when a rendered template is invalid TOML", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    await fs.writeFile(
      path.join(
        currentStorageRoot(),
        "skills",
        skillName,
        "resources",
        "codex",
        "automation.toml.tpl"
      ),
      "invalid = [\n",
      "utf8"
    );

    const install = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot],
      { CODEX_HOME: codexHome }
    );
    expect(install.code).not.toBe(0);
    expect(install.stderr).toContain("rendered TOML did not parse");
    await expect(
      fs.lstat(
        path.join(
          currentStorageRoot(),
          "rendered",
          "codex-automations",
          "docs-drift-scout"
        )
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(currentStorageRoot(), "render-index.json"))).rejects.toMatchObject(
      { code: "ENOENT" }
    );
    await expect(
      fs.lstat(path.join(codexHome, "automations", "docs-drift-scout"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(currentStorageRoot())).filter(
        (name) =>
          name.startsWith(".codex-bundle.docs-drift-scout.") ||
          name.startsWith(".render-index.docs-drift-scout.")
      )
    ).toEqual([]);
  });

  it("preflights Python tomllib support before writing state", async () => {
    const vaultBin = await installVaultSkill();
    const { projectRoot, codexHome } = await makeScratch();
    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "autovault-python-preflight-"));
    const fakePython = path.join(fakeBin, "python3");
    await fs.writeFile(fakePython, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const install = await runBundle(
      vaultBin,
      ["install", "--project-root", projectRoot],
      {
        CODEX_HOME: codexHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`
      }
    );

    expect(install.code).not.toBe(0);
    expect(install.stderr).toContain("python3 3.11 or newer with tomllib is required");
    await expect(fs.lstat(path.join(currentStorageRoot(), "render-index.json"))).rejects.toMatchObject(
      { code: "ENOENT" }
    );
  });

  it("fails the install when --project-root is omitted (no shipped default)", async () => {
    const result = await runBundle(repoBin, ["install"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--project-root is required");
  });

  it.each(["--codex-home", "--render-root"])("rejects the removed %s option", async (flag) => {
    const { projectRoot, codexHome } = await makeScratch();
    const result = await runBundle(repoBin, [
      "install",
      "--project-root",
      projectRoot,
      flag,
      codexHome
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`unknown argument: ${flag}`);
  });
});
