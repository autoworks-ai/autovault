import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const INSTALL_SH = path.join(REPO_ROOT, "scripts", "install.sh");

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  home: string;
  binDir: string;
};

async function createFakeArchive(root: string): Promise<string> {
  const packageRoot = path.join(root, "autovault-main");
  await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: "fake-autovault",
        version: "0.0.0",
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
            version: "0.0.0"
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

async function runInstaller(extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autovault-install-test-"));
  const home = path.join(root, "home");
  const avHome = path.join(home, ".autovault");
  const binDir = path.join(avHome, "bin");
  await fs.mkdir(home, { recursive: true });
  const tarball = await createFakeArchive(root);

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn("sh", [INSTALL_SH], {
      env: {
        ...process.env,
        HOME: home,
        AUTOVAULT_HOME: avHome,
        AUTOVAULT_BIN_DIR: binDir,
        AUTOVAULT_TARBALL_URL: `file://${tarball}`,
        AUTOVAULT_YES: "1",
        PATH: process.env.PATH ?? "",
        ...extraEnv
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
      resolve({ code: code ?? -1, stdout, stderr, home: avHome, binDir });
    });
    child.stdin.end();
  });
}

describe("install.sh", () => {
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
    expect(result.stdout).not.toContain("Install plan");
    expect(result.stdout).not.toContain("stdout noise");
    expect(result.stderr).not.toContain("stderr noise");
    await expect(fs.access(path.join(result.binDir, "autovault"))).resolves.toBeUndefined();
  });

  it("shows install details and captured logs only in verbose mode", async () => {
    const result = await runInstaller({
      AUTOVAULT_NO_SETUP: "1",
      AUTOVAULT_VERBOSE: "1"
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Install plan");
    expect(result.stdout).toContain("Seeding bundled skills... log tail");
    expect(result.stdout).toContain("stdout noise");
    expect(result.stdout).toContain("stderr noise");
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
  });
});
