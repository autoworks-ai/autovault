import { spawn } from "node:child_process";
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

function runCli(
  args: string[],
  options: { env?: Record<string, string>; deleteEnv?: string[] } = {}
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
      AUTOVAULT_LOG_LEVEL: "error",
      AUTOVAULT_SECURITY_STRICT: "true",
      ...(options.env ?? {})
    };
    for (const key of options.deleteEnv ?? []) delete env[key];
    const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
      env,
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

describe("autovault serve CLI", () => {
  it("explains remote serve requirements when AUTOVAULT_PUBLIC_URL is missing", async () => {
    const result = await runCli(["serve"], {
      deleteEnv: ["AUTOVAULT_PUBLIC_URL", "AUTOVAULT_ADMIN_EMAIL", "AUTOVAULT_ADMIN_PASSWORD"]
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("autovault failed");
    expect(result.stderr).toContain("OAuth-protected Streamable HTTP MCP service");
    expect(result.stderr).toContain("AUTOVAULT_PUBLIC_URL=http://localhost:3000");
    expect(result.stderr).toContain("autovault setup");
  });

  it("explains first-owner credentials before remote boot", async () => {
    const result = await runCli(["serve"], {
      env: { AUTOVAULT_PUBLIC_URL: "http://localhost:3000" },
      deleteEnv: ["AUTOVAULT_ADMIN_EMAIL", "AUTOVAULT_ADMIN_PASSWORD"]
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("autovault failed");
    expect(result.stderr).toContain("first owner account");
    expect(result.stderr).toContain("AUTOVAULT_ADMIN_EMAIL=admin@example.com");
    expect(result.stderr).toContain("AUTOVAULT_ADMIN_PASSWORD=");
  });

  it("prints serve help with remote endpoint guidance", async () => {
    const result = await runCli(["serve", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("autovault serve");
    expect(result.stdout).toContain("/mcp");
    expect(result.stdout).toContain("/healthz");
    expect(result.stdout).toContain("autovault setup");
  });
});
