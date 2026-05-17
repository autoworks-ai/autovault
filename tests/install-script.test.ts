import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SH = path.join(REPO_ROOT, "scripts", "install.sh");

const activeChildren = new Set<ChildProcess>();

function killChildGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already dead or pgid gone — nothing to do
  }
}

process.once("exit", () => {
  for (const child of activeChildren) killChildGroup(child);
});

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  home: string;
  binDir: string;
};

async function createFakeArchive(root: string, version = "0.0.0"): Promise<string> {
  const packageRoot = path.join(root, "autovault-main");
  await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: "fake-autovault",
        version,
        type: "module",
        scripts: { build: "node scripts/build.mjs" }
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(packageRoot, "package-lock.json"),
    JSON.stringify(
      {
        name: "fake-autovault",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "fake-autovault",
            version
          }
        }
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(packageRoot, "cli.js"),
    [
      "if (process.argv[2] === 'setup') {",
      "  console.log('fake setup ran');",
      "  process.exit(0);",
      "}",
      "if (process.argv[2] === 'doctor') console.log('fake doctor');"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(packageRoot, "scripts", "build.mjs"),
    [
      "import fs from 'node:fs/promises';",
      "await fs.mkdir('dist', { recursive: true });",
      "await fs.copyFile('cli.js', 'dist/cli.js');"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(packageRoot, "scripts", "bootstrap-skills.mjs"),
    [
      "console.log('{\"level\":\"info\",\"msg\":\"stdout noise\"}');",
      "console.error('{\"level\":\"warn\",\"msg\":\"stderr noise\"}');",
      "process.exit(Number(process.env.FAKE_BOOTSTRAP_STATUS ?? 0));"
    ].join("\n")
  );

  const tarball = path.join(root, "autovault.tgz");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-czf", tarball, "-C", root, "autovault-main"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
  return tarball;
}

type InstallerFixtureOptions = {
  args?: string[];
  archiveVersion?: string;
  beforeRun?: (paths: { home: string; avHome: string; binDir: string }) => Promise<void>;
};

async function runInstaller(
  extraEnv: Record<string, string> = {},
  options: InstallerFixtureOptions = {}
): Promise<RunResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autovault-install-test-"));
  const home = path.join(root, "home");
  const avHome = path.join(home, ".autovault");
  const binDir = path.join(avHome, "bin");
  await fs.mkdir(home, { recursive: true });
  const tarball = await createFakeArchive(root, options.archiveVersion);
  await options.beforeRun?.({ home, avHome, binDir });

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn("sh", [INSTALL_SH, ...(options.args ?? [])], {
      env: {
        ...process.env,
        HOME: home,
        AUTOVAULT_HOME: avHome,
        AUTOVAULT_BIN_DIR: binDir,
        AUTOVAULT_STORAGE_PATH: avHome,
        AUTOVAULT_TARBALL_URL: `file://${tarball}`,
        AUTOVAULT_LATEST_VERSION: options.archiveVersion ?? "0.0.0",
        AUTOVAULT_YES: "1",
        PATH: process.env.PATH ?? "",
        ...extraEnv
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      activeChildren.delete(child);
      reject(err);
    });
    child.on("exit", (code) => {
      activeChildren.delete(child);
      resolve({ code: code ?? -1, stdout, stderr, home: avHome, binDir });
    });
    child.stdin.end();
  });
}

describe("install.sh", () => {
  afterEach(() => {
    for (const child of activeChildren) killChildGroup(child);
    activeChildren.clear();
  });

  it("supports AUTOVAULT_YES with setup skipped", async () => {
    const result = await runInstaller({ AUTOVAULT_NO_SETUP: "1" });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("AutoVault");
    expect(result.stdout).toMatch(/validate\s+(→|->)\s+sign\s+(→|->)\s+vault/);
    expect(result.stdout).toMatch(/stage 1\/6\s+detect\s+checking prerequisites and platform/);
    expect(result.stdout).toMatch(/stage 5\/6\s+path\s+installing the autovault shim/);
    expect(result.stdout).toMatch(/stage 6\/6\s+setup\s+skipped by AUTOVAULT_NO_SETUP=1/);
    expect(result.stdout).not.toContain("[1/6]");
    expect(result.stdout).toContain("Install plan");
    expect(result.stdout).toContain("platform");
    expect(result.stdout).toContain("node");
    expect(result.stdout).toContain(path.join(result.home, "app"));
    expect(result.stdout).toContain(`storage  ${result.home}`);
    expect(result.stdout).toContain("state    fresh install");
    expect(result.stdout).toContain("target   v0.0.0");
    expect(result.stdout).not.toContain("stdout noise");
    expect(result.stderr).not.toContain("stderr noise");
    await expect(fs.access(path.join(result.binDir, "autovault"))).resolves.toBeUndefined();
  });

  it("classifies upgrades, reinstalls, downgrades, and storage adoption before writing", async () => {
    const upgrade = await runInstaller(
      { AUTOVAULT_NO_SETUP: "1" },
      {
        archiveVersion: "2.0.0",
        beforeRun: async ({ avHome }) => {
          await fs.mkdir(path.join(avHome, "app"), { recursive: true });
          await fs.writeFile(
            path.join(avHome, "app", "package.json"),
            JSON.stringify({ version: "1.0.0" })
          );
        }
      }
    );
    expect(upgrade.stdout).toContain("state    upgrade");
    expect(upgrade.stdout).toContain("current  1.0.0");
    expect(upgrade.stdout).toContain("target   v2.0.0");

    const reinstall = await runInstaller(
      { AUTOVAULT_NO_SETUP: "1" },
      {
        archiveVersion: "2.0.0",
        beforeRun: async ({ avHome }) => {
          await fs.mkdir(path.join(avHome, "app"), { recursive: true });
          await fs.writeFile(
            path.join(avHome, "app", "package.json"),
            JSON.stringify({ version: "2.0.0" })
          );
        }
      }
    );
    expect(reinstall.stdout).toContain("state    reinstall");

    const downgrade = await runInstaller(
      { AUTOVAULT_NO_SETUP: "1" },
      {
        archiveVersion: "1.0.0",
        beforeRun: async ({ avHome }) => {
          await fs.mkdir(path.join(avHome, "app"), { recursive: true });
          await fs.writeFile(
            path.join(avHome, "app", "package.json"),
            JSON.stringify({ version: "2.0.0" })
          );
        }
      }
    );
    expect(downgrade.stdout).toContain("state    downgrade");

    const adoption = await runInstaller(
      { AUTOVAULT_NO_SETUP: "1" },
      {
        beforeRun: async ({ avHome }) => {
          await fs.mkdir(path.join(avHome, "skills", "existing"), { recursive: true });
        }
      }
    );
    expect(adoption.stdout).toContain("state    repair/adopt existing storage");
  });

  it("supports dry-run without writing the app, shim, or profile files", async () => {
    const result = await runInstaller(
      { AUTOVAULT_NO_SETUP: "1" },
      { args: ["--dry-run"] }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Dry run only; no changes made.");
    await expect(fs.access(path.join(result.home, "app"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(result.binDir, "autovault"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("supports quiet non-interactive installs", async () => {
    const result = await runInstaller(
      { AUTOVAULT_NO_SETUP: "1" },
      { args: ["--yes", "--quiet"] }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect(fs.access(path.join(result.binDir, "autovault"))).resolves.toBeUndefined();
  });

  it("hides successful bootstrap logs even in verbose mode", async () => {
    const result = await runInstaller({
      AUTOVAULT_NO_SETUP: "1",
      AUTOVAULT_VERBOSE: "1"
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Install plan");
    expect(result.stdout).not.toContain("Seeding bundled skills... log tail");
    expect(result.stdout).not.toContain("stdout noise");
    expect(result.stdout).not.toContain("stderr noise");
  });

  it("keeps bootstrap failure logs visible", async () => {
    const result = await runInstaller({
      AUTOVAULT_NO_SETUP: "1",
      AUTOVAULT_VERBOSE: "1",
      FAKE_BOOTSTRAP_STATUS: "1"
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Seeding bundled skills... failed");
    expect(result.stderr).toContain("stdout noise");
    expect(result.stderr).toContain("stderr noise");
  });

  it("rejects Node builds below the package engine floor", async () => {
    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "autovault-node-test-"));
    await fs.writeFile(
      path.join(fakeBin, "node"),
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  --version) printf 'v20.18.0\\n'; exit 0 ;;",
        "  -p)",
        "    case \"$2\" in",
        "      *\\[0\\]*) printf '20\\n' ;;",
        "      *\\[1\\]*) printf '18\\n' ;;",
        "      *\\[2\\]*) printf '0\\n' ;;",
        "      *) printf '0\\n' ;;",
        "    esac",
        "    exit 0",
        "    ;;",
        "esac",
        "exit 1"
      ].join("\n"),
      { mode: 0o755 }
    );

    const result = await runInstaller({
      AUTOVAULT_NO_SETUP: "1",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Node.js >= 22.0.0 is required");
    expect(result.stderr).toContain("v20.18.0");
  });

  it("reports when the shim directory is already on PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autovault-path-test-"));
    const binDir = path.join(root, "bin");
    const result = await runInstaller({
      AUTOVAULT_BIN_DIR: binDir,
      AUTOVAULT_NO_SETUP: "1",
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("autovault is already on your PATH");
  });

  it("prints manual profile guidance when profile updates are disabled", async () => {
    const result = await runInstaller({
      AUTOVAULT_NO_PROFILE_UPDATE: "1",
      AUTOVAULT_NO_SETUP: "1"
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Could not update your shell profile automatically.");
    expect(result.stdout).toContain("[ shell ]");
    expect(result.stdout).toContain("Run this once in this session:");
  });

  it("defers setup in a non-interactive shell", async () => {
    const result = await runInstaller();

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/stage 6\/6\s+setup\s+deferred for non-interactive shell/);
    expect(result.stdout).not.toContain("fake setup ran");
    expect(result.stdout).toContain("autovault setup");
  });

  it("auto-confirms without AUTOVAULT_YES when CLAUDE_CODE is set", async () => {
    const result = await runInstaller({
      AUTOVAULT_NO_SETUP: "1",
      AUTOVAULT_YES: "",
      CLAUDE_CODE: "1"
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Headless environment detected");
  });

  it("auto-confirms without AUTOVAULT_YES when CI is set", async () => {
    const result = await runInstaller({
      AUTOVAULT_NO_SETUP: "1",
      AUTOVAULT_YES: "",
      CI: "true"
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Headless environment detected");
  });
});
