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

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")
  ) as { version?: string };
  if (!packageJson.version) {
    throw new Error("package.json must declare a version for CLI version tests");
  }
  return packageJson.version;
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
    expect(result.stdout).not.toContain("Update available");
  });

  it("shows a human update notice when a newer stable version exists", async () => {
    const currentVersion = await packageVersion();
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`[update] Update available: AutoVault ${currentVersion} -> 9.9.9`);
    expect(result.stdout).toContain(`${currentVersion} -> 9.9.9`);
    expect(result.stdout).toContain("Run     `autovault update`");
    expect(result.stdout).toContain("Disable `AUTOVAULT_NO_UPDATE_CHECK=1`");
    expect(result.stdout).not.toContain("Release notes:");
  });

  it("shows the passive update notice after successful human command output", async () => {
    const result = await runCli(["sync-profiles"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Profile sync");
    expect(result.stdout.indexOf("Profile sync")).toBeLessThan(
      result.stdout.indexOf("Update available")
    );
    expect(result.stdout).toContain("Run     `autovault update`");
  });

  it("hides the update notice when the installed version is current", async () => {
    const currentVersion = await packageVersion();
    const result = await runCli(["--version"], {
      AUTOVAULT_LATEST_VERSION: currentVersion
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("Update available");
  });

  it("hides the passive update notice when update checks are disabled", async () => {
    const result = await runCli(["--version"], {
      AUTOVAULT_NO_UPDATE_CHECK: "1"
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("Update available");
  });

  it("prints help to stdout and exits 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Update available");
    expect(result.stdout).toContain("autovault --version");
    expect(result.stdout).toContain("autovault update [version|latest|stable|main]");
    expect(result.stdout.indexOf("autovault --version")).toBeLessThan(
      result.stdout.indexOf("Update available")
    );
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
    const currentVersion = await packageVersion();
    const result = await runCli(["update", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Checking for updates");
    expect(result.stdout).toContain(`Current: ${currentVersion}`);
    expect(result.stdout).toContain("Latest:  9.9.9");
    expect(result.stdout).toContain("Target:  v9.9.9");
    expect(result.stdout).toContain("Command: AUTOVAULT_REF=v9.9.9");
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps passive update notices out of JSON and machine-readable outputs", async () => {
    const sync = await runCli(["sync-profiles", "--json"]);
    expect(sync.exitCode).toBe(0);
    expect(sync.stderr).toBe("");
    expect(sync.stdout).not.toContain("Update available");
    expect(() => JSON.parse(sync.stdout)).not.toThrow();

    const repo = path.join(currentStorageRoot(), "audit-json-target");
    await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
    await fs.writeFile(path.join(repo, "scripts", "deploy.js"), "fetch('https://example.com');\n");
    const audit = await runCli(["audit-repo", "--repo", repo, "--format", "json"]);
    expect(audit.exitCode).toBe(0);
    expect(audit.stderr).toBe("");
    expect(audit.stdout).not.toContain("Update available");
    expect(() => JSON.parse(audit.stdout)).not.toThrow();
  });

  it("does not execute updates from non-TTY sessions without --yes", async () => {
    const result = await runCli(["update"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Checking for updates");
    expect(result.stdout).toContain("Run autovault update --yes to apply.");
    expect(result.stdout).not.toContain("Successfully updated");
  });

  it("reports up to date without running an update", async () => {
    const currentVersion = await packageVersion();
    const result = await runCli(["update"], {
      AUTOVAULT_LATEST_VERSION: currentVersion
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Checking for updates");
    expect(result.stdout).toContain("AutoVault is already up to date.");
    expect(result.stdout).not.toContain("--yes to apply");
  });

  it("uses the unreleased changelog section for main-channel notes", async () => {
    const result = await runCli(["update", "main", "--dry-run", "--notes"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Target:  main");
    expect(result.stdout).toContain("AUTOVAULT_REF=main");
    expect(result.stdout).toContain("## [Unreleased]");
  });
});
