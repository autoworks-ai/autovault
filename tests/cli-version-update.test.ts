import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
        AUTOVAULT_LATEST_VERSION: "9.9.9",
        NODE_NO_WARNINGS: "1",
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

describe("autovault top-level CLI UX", () => {
  it.each([["--version"], ["-v"], ["--v"], ["version"]])(
    "prints the CLI version for %s",
    async (arg) => {
      const result = await runCli([arg]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toMatch(/^autovault \d+\.\d+\.\d+/);
    }
  );

  it("prints structured version details as JSON", async () => {
    const result = await runCli(["version", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      version: string;
      node: string;
      installPath: string;
      storagePath: string;
      installMethod: string;
    };
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.node).toBe(process.version);
    expect(parsed.installPath).toBe(REPO_ROOT);
    expect(parsed.storagePath).toBe(currentStorageRoot());
    expect(parsed.installMethod).toBe("source-tree");
  });

  it("prints help to stdout and exits 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("autovault --version");
    expect(result.stdout).toContain("autovault update [version|latest|stable|main]");
  });

  it("suggests close command names on typo", async () => {
    const result = await runCli(["udpate"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown command: udpate");
    expect(result.stderr).toContain("Did you mean autovault update?");
  });

  it("shows a dry-run source update plan without mutating files", async () => {
    const marker = path.join(currentStorageRoot(), "update-marker");
    const result = await runCli(["update", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("AutoVault update plan");
    expect(result.stdout).toContain("current 0.3.0");
    expect(result.stdout).toContain("target  v9.9.9");
    expect(result.stdout).toContain("sh ");
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the unreleased changelog section for main-channel notes", async () => {
    const result = await runCli(["update", "main", "--dry-run", "--notes"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("target  main");
    expect(result.stdout).toContain("AUTOVAULT_REF=main");
    expect(result.stdout).toContain("## [Unreleased]");
  });
});
