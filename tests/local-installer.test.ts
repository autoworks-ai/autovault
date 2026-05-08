import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { addLocalSkill } from "../src/installer/local.js";
import {
  normalizeSkillInstallMode,
  skillInstallSteps
} from "../src/installer/routing.js";
import { syncProfiles } from "../src/profiles/sync.js";
import { readSkillManifest, readSkillSource, writeSkill } from "../src/storage/index.js";
import { addSkill } from "../src/tools/add-skill.js";
import { checkUpdates } from "../src/tools/check-updates.js";
import { MAX_RESOURCE_BYTES } from "../src/util/limits.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true",
        ...env
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
    child.stdin.end();
  });
}

function runShell(script: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", script], {
      env: {
        ...process.env,
        ...env
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
    child.stdin.end();
  });
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeLocalSkill(
  root: string,
  input: { name: string; agents?: string[]; resources?: Record<string, string> }
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const agents = input.agents ? `agents: [${input.agents.join(", ")}]\n` : "";
  const resourcePaths = Object.keys(input.resources ?? {});
  const resources = resourcePaths.length > 0
    ? `resources:\n${resourcePaths.map((resource) => `  - path: ${resource}`).join("\n")}\n`
    : "";
  await fs.writeFile(
    path.join(root, "SKILL.md"),
    `---
name: ${input.name}
description: A description that is intentionally long enough to satisfy schema checks.
${agents}metadata:
  version: "1.0.0"
${resources}
---

# ${input.name}
`,
    "utf-8"
  );
  for (const [resourcePath, content] of Object.entries(input.resources ?? {})) {
    const absolute = path.join(root, resourcePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf-8");
  }
}

describe("local installer", () => {
  it("installs a local bundle with resources and signs the manifest", async () => {
    const sourceDir = path.join(currentStorageRoot(), "source-bundle");
    await writeLocalSkill(sourceDir, {
      name: "local-bundle",
      resources: {
        "references/setup.md": "Local setup reference.\n"
      }
    });

    const result = await addLocalSkill({
      skillDir: sourceDir,
      source: "vendor/repo"
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("local-bundle");
    const manifest = await readSkillManifest("local-bundle");
    expect(manifest?.files["SKILL.md"]).toBeDefined();
    expect(manifest?.files["references/setup.md"]).toBeDefined();
    expect(manifest?.files[".autovault-source.json"]).toBeDefined();
    const source = await readSkillSource("local-bundle");
    expect(source?.source).toBe("local");
    expect(source?.identifier).toBe("vendor/repo");
  });

  it("reinstall replaces removed and changed local resources", async () => {
    const sourceDir = path.join(currentStorageRoot(), "replace-bundle");
    await writeLocalSkill(sourceDir, {
      name: "replace-local",
      resources: {
        "references/old.md": "old\n"
      }
    });
    await addLocalSkill({ skillDir: sourceDir, source: "vendor/repo" });

    await fs.rm(path.join(sourceDir, "references"), { recursive: true, force: true });
    await writeLocalSkill(sourceDir, {
      name: "replace-local",
      resources: {
        "references/new.md": "new\n"
      }
    });
    const result = await addLocalSkill({ skillDir: sourceDir, source: "vendor/repo" });

    expect(result.success).toBe(true);
    await expect(
      fs.access(path.join(currentStorageRoot(), "skills", "replace-local", "references", "old.md"))
    ).rejects.toBeDefined();
    await expect(
      fs.readFile(path.join(currentStorageRoot(), "skills", "replace-local", "references", "new.md"), "utf-8")
    ).resolves.toBe("new\n");
  });

  it("reports local installs as unchecked for updates", async () => {
    const sourceDir = path.join(currentStorageRoot(), "unchecked-bundle");
    await writeLocalSkill(sourceDir, {
      name: "unchecked-local"
    });
    await addLocalSkill({ skillDir: sourceDir, source: "vendor/repo" });

    const result = await checkUpdates("unchecked-local");

    expect(result.unchecked).toEqual([
      {
        name: "unchecked-local",
        source: "local",
        identifier: "vendor/repo",
        reason: "local bundle install has no checkable upstream; rerun the vendor installer to update"
      }
    ]);
  });

  it("add-local --sync-profiles discovers native profile roots", async () => {
    const fakeHome = path.join(currentStorageRoot(), "home");
    const codexRoot = path.join(fakeHome, ".codex", "skills");
    await fs.mkdir(codexRoot, { recursive: true });
    const sourceDir = path.join(currentStorageRoot(), "codex-bundle");
    await writeLocalSkill(sourceDir, {
      name: "codex-local",
      agents: ["codex"]
    });

    const result = await runCli(
      ["add-local", sourceDir, "--source", "vendor/repo", "--sync-profiles", "--json"],
      { HOME: fakeHome }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { success: boolean; sync?: { linkedRoots: Record<string, string> } };
    expect(parsed.success).toBe(true);
    expect(parsed.sync?.linkedRoots.codex).toBe(codexRoot);
    await expect(fs.readlink(path.join(codexRoot, "codex-local"))).resolves.toContain(
      path.join("profiles", "codex", "codex-local")
    );
  });

  it("MCP local add syncs configured profile roots by default", async () => {
    const externalRoot = path.join(currentStorageRoot(), "external-codex-skills");
    const previousProfileLinks = process.env.AUTOVAULT_PROFILE_LINKS;
    process.env.AUTOVAULT_PROFILE_LINKS = `codex=${externalRoot}`;
    resetConfigCache();
    try {
      const sourceDir = path.join(currentStorageRoot(), "mcp-local-bundle");
      await writeLocalSkill(sourceDir, {
        name: "mcp-local-default-sync",
        agents: ["codex"]
      });

      const result = await addSkill({
        source: "local",
        identifier: "vendor/repo",
        skill_dir: sourceDir
      });

      expect(result.success).toBe(true);
      await expect(fs.readlink(path.join(externalRoot, "mcp-local-default-sync"))).resolves.toContain(
        path.join("profiles", "codex", "mcp-local-default-sync")
      );
    } finally {
      if (previousProfileLinks === undefined) {
        delete process.env.AUTOVAULT_PROFILE_LINKS;
      } else {
        process.env.AUTOVAULT_PROFILE_LINKS = previousProfileLinks;
      }
      resetConfigCache();
    }
  });

  it("preserves external native directory conflicts with warnings", async () => {
    await writeSkill(
      "native-conflict",
      `---
name: native-conflict
description: A description that is intentionally long enough to satisfy schema checks.
agents: [codex]
metadata:
  version: "1.0.0"
---

# native-conflict
`
    );
    const externalRoot = path.join(currentStorageRoot(), "external-codex");
    await fs.mkdir(path.join(externalRoot, "native-conflict"), { recursive: true });

    const result = await syncProfiles({
      profileRoots: { codex: externalRoot }
    });

    expect(result.warnings.join("\n")).toMatch(/user-managed path already exists/);
    await expect(fs.stat(path.join(externalRoot, "native-conflict"))).resolves.toBeTruthy();
  });

  it("normalizes AUTOVAULT_SKILL_INSTALL modes into installer steps", () => {
    expect(normalizeSkillInstallMode(undefined)).toBe("prefer-autovault");
    expect(normalizeSkillInstallMode("prefer")).toBe("prefer-autovault");
    expect(skillInstallSteps("prefer-autovault", { autovaultAvailable: true })).toEqual(["autovault"]);
    expect(skillInstallSteps("prefer-autovault", { autovaultAvailable: false })).toEqual(["native"]);
    expect(skillInstallSteps("both", { autovaultAvailable: true })).toEqual(["autovault", "native"]);
    expect(skillInstallSteps("native", { autovaultAvailable: true })).toEqual(["native", "autovault"]);
    expect(skillInstallSteps("native-only", { autovaultAvailable: true })).toEqual(["native"]);
    expect(skillInstallSteps("off", { autovaultAvailable: true })).toEqual([]);
    expect(() => normalizeSkillInstallMode("wat")).toThrow(/Invalid AUTOVAULT_SKILL_INSTALL mode/);
  });

  it("preflights local resource size before reading resource bytes", async () => {
    const sourceDir = path.join(currentStorageRoot(), "oversized-resource-bundle");
    await writeLocalSkill(sourceDir, {
      name: "oversized-local"
    });
    const oversizedPath = path.join(sourceDir, "huge.txt");
    await fs.writeFile(oversizedPath, "x".repeat(MAX_RESOURCE_BYTES + 1), "utf-8");

    const readFileSpy = vi.spyOn(fs, "readFile");
    try {
      const result = await addLocalSkill({ skillDir: sourceDir, source: "vendor/repo" });

      expect(result.success).toBe(false);
      expect(result.validation.errors.join("\n")).toMatch(/Resource 'huge\.txt' is/);
      expect(
        readFileSpy.mock.calls.some((call) => call[0] === oversizedPath)
      ).toBe(false);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("root symlink rejection names the input path and canonical target", async () => {
    const targetDir = path.join(currentStorageRoot(), "root-symlink-target");
    await writeLocalSkill(targetDir, {
      name: "root-symlink-local"
    });
    const linkDir = path.join(currentStorageRoot(), "root-symlink-link");
    await fs.symlink(targetDir, linkDir, "dir");
    const realTarget = await fs.realpath(targetDir);

    let error: unknown;
    try {
      await addLocalSkill({ skillDir: linkDir, source: "vendor/repo" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(linkDir);
    expect(message).toContain(realTarget);
    expect(message).toContain("Use the canonical target path instead.");
  });

  it("resource symlink rejection names the resource and canonical target", async () => {
    const sourceDir = path.join(currentStorageRoot(), "resource-symlink-bundle");
    await writeLocalSkill(sourceDir, {
      name: "resource-symlink-local"
    });
    const targetPath = path.join(sourceDir, "SKILL.md");
    await fs.symlink(targetPath, path.join(sourceDir, "linked.md"));
    const realTarget = await fs.realpath(targetPath);

    let error: unknown;
    try {
      await addLocalSkill({ skillDir: sourceDir, source: "vendor/repo" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("linked.md");
    expect(message).toContain(realTarget);
  });

  it("ignores known OS metadata files in local bundles", async () => {
    const sourceDir = path.join(currentStorageRoot(), "metadata-bundle");
    await writeLocalSkill(sourceDir, {
      name: "metadata-local",
      resources: {
        "references/setup.md": "Local setup reference.\n"
      }
    });
    await fs.writeFile(path.join(sourceDir, ".DS_Store"), "finder\n", "utf-8");
    await fs.writeFile(path.join(sourceDir, "Thumbs.db"), "thumbs\n", "utf-8");
    await fs.writeFile(path.join(sourceDir, "references", ".DS_Store"), "nested finder\n", "utf-8");
    await fs.writeFile(path.join(sourceDir, "references", "Thumbs.db"), "nested thumbs\n", "utf-8");

    const result = await addLocalSkill({
      skillDir: sourceDir,
      source: "vendor/repo"
    });

    expect(result.success).toBe(true);
    const manifest = await readSkillManifest("metadata-local");
    expect(manifest?.files["references/setup.md"]).toBeDefined();
    const manifestFiles = Object.keys(manifest?.files ?? {});
    expect(manifestFiles).not.toContain(".DS_Store");
    expect(manifestFiles).not.toContain("Thumbs.db");
    expect(manifestFiles).not.toContain("references/.DS_Store");
    expect(manifestFiles).not.toContain("references/Thumbs.db");
    await expect(
      fs.access(path.join(currentStorageRoot(), "skills", "metadata-local", ".DS_Store"))
    ).rejects.toBeDefined();
    await expect(
      fs.access(path.join(currentStorageRoot(), "skills", "metadata-local", "Thumbs.db"))
    ).rejects.toBeDefined();
    await expect(
      fs.access(path.join(currentStorageRoot(), "skills", "metadata-local", "references", ".DS_Store"))
    ).rejects.toBeDefined();
    await expect(
      fs.access(path.join(currentStorageRoot(), "skills", "metadata-local", "references", "Thumbs.db"))
    ).rejects.toBeDefined();
  });

  it("still treats normal hidden files as local resources", async () => {
    const sourceDir = path.join(currentStorageRoot(), "hidden-resource-bundle");
    await writeLocalSkill(sourceDir, {
      name: "hidden-resource-local"
    });
    await fs.writeFile(path.join(sourceDir, ".hidden-resource"), "hidden\n", "utf-8");

    const result = await addLocalSkill({
      skillDir: sourceDir,
      source: "vendor/repo"
    });

    expect(result.success).toBe(false);
    expect(result.validation.errors.join("\n")).toMatch(
      /Bundle includes undisclosed file '\.hidden-resource'/
    );
  });

  it("vendor helper both mode falls back to native when autovault is unavailable", async () => {
    const scriptPath = path.join(REPO_ROOT, "scripts", "vendor-autovault-install.sh");
    const result = await runShell(
      `. "${scriptPath}"
install_native() { printf 'native\\n'; }
autovault_install_skill_bundle "/tmp/source" "vendor/repo" install_native`,
      {
        AUTOVAULT_SKILL_INSTALL: "both",
        PATH: "/usr/bin:/bin"
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("native\n");
  });

  it("prints deterministic non-json terminal output", async () => {
    const sourceDir = path.join(currentStorageRoot(), "terminal-bundle");
    await writeLocalSkill(sourceDir, {
      name: "terminal-local"
    });

    const result = await runCli(["add-local", sourceDir, "--source", "vendor/repo"]);

    expect(result.exitCode).toBe(0);
    const normalized = result.stdout
      .replaceAll(sourceDir, "<SOURCE>")
      .replaceAll(currentStorageRoot(), "<ROOT>");
    expect(normalized).toMatchInlineSnapshot(`
"=============================
AutoVault local installer
=============================

scan      <SOURCE>
validate  passed
sign      terminal-local
storage   <ROOT>/skills/terminal-local
source    vendor/repo

restart any agent host that caches filesystem skills
"
`);
  });

  it("refuses root symlinks with the symlink input and canonical target", async () => {
    const sourceDir = path.join(currentStorageRoot(), "root-symlink-target");
    await writeLocalSkill(sourceDir, {
      name: "root-symlink-local"
    });
    const linkDir = path.join(currentStorageRoot(), "root-symlink-link");
    await fs.symlink(sourceDir, linkDir);
    const canonicalTarget = await fs.realpath(sourceDir);

    await expect(addLocalSkill({ skillDir: linkDir, source: "vendor/repo" })).rejects.toThrow(
      new RegExp(`${escapeRegExp(linkDir)} -> ${escapeRegExp(canonicalTarget)}`)
    );
  });

  it("refuses symlinks in local bundles", async () => {
    const sourceDir = path.join(currentStorageRoot(), "symlink-bundle");
    await writeLocalSkill(sourceDir, {
      name: "symlink-local"
    });
    const targetPath = path.join(sourceDir, "target.md");
    await fs.writeFile(targetPath, "target\n", "utf-8");
    await fs.mkdir(path.join(sourceDir, "references"), { recursive: true });
    await fs.symlink(targetPath, path.join(sourceDir, "references", "linked.md"));
    const canonicalTarget = await fs.realpath(targetPath);

    await expect(addLocalSkill({ skillDir: sourceDir, source: "vendor/repo" })).rejects.toThrow(
      new RegExp(`symlink resource: references/linked\\.md -> ${escapeRegExp(canonicalTarget)}`)
    );
  });

  it("ignores known OS metadata files at any bundle depth", async () => {
    const sourceDir = path.join(currentStorageRoot(), "metadata-bundle");
    await writeLocalSkill(sourceDir, {
      name: "metadata-local",
      resources: {
        "references/setup.md": "Local setup reference.\n"
      }
    });
    await fs.writeFile(path.join(sourceDir, ".DS_Store"), "finder\n", "utf-8");
    await fs.writeFile(path.join(sourceDir, "Thumbs.db"), "thumbs\n", "utf-8");
    await fs.writeFile(path.join(sourceDir, "references", ".DS_Store"), "nested finder\n", "utf-8");
    await fs.writeFile(path.join(sourceDir, "references", "Thumbs.db"), "nested thumbs\n", "utf-8");

    const result = await addLocalSkill({ skillDir: sourceDir, source: "vendor/repo" });

    expect(result.success).toBe(true);
    const manifest = await readSkillManifest("metadata-local");
    expect(manifest?.files["references/setup.md"]).toBeDefined();
    expect(manifest?.files[".DS_Store"]).toBeUndefined();
    expect(manifest?.files["Thumbs.db"]).toBeUndefined();
    expect(manifest?.files["references/.DS_Store"]).toBeUndefined();
    expect(manifest?.files["references/Thumbs.db"]).toBeUndefined();
    await expect(fs.access(path.join(currentStorageRoot(), "skills", "metadata-local", ".DS_Store"))).rejects.toBeDefined();
    await expect(fs.access(path.join(currentStorageRoot(), "skills", "metadata-local", "Thumbs.db"))).rejects.toBeDefined();
    await expect(
      fs.access(path.join(currentStorageRoot(), "skills", "metadata-local", "references", ".DS_Store"))
    ).rejects.toBeDefined();
    await expect(
      fs.access(path.join(currentStorageRoot(), "skills", "metadata-local", "references", "Thumbs.db"))
    ).rejects.toBeDefined();
  });

  it("treats normal hidden non-metadata files as resources that must be disclosed", async () => {
    const sourceDir = path.join(currentStorageRoot(), "hidden-resource-bundle");
    await writeLocalSkill(sourceDir, {
      name: "hidden-resource-local"
    });
    await fs.writeFile(path.join(sourceDir, ".hidden-notes"), "not metadata\n", "utf-8");

    const result = await addLocalSkill({ skillDir: sourceDir, source: "vendor/repo" });

    expect(result.success).toBe(false);
    expect(result.validation.errors.join("\n")).toMatch(/undisclosed file '\.hidden-notes'/);
  });
});
