import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

describe("autovault ui CLI", () => {
  let child: ChildProcessWithoutNullStreams | null = null;

  afterEach(async () => {
    if (!child || child.killed) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      child = null;
      return;
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
    child = null;
  });

  it("starts a loopback UI server with --no-open --port 0", async () => {
    child = spawn(TSX_BIN, [CLI_PATH, "ui", "--no-open", "--offline", "--port", "0"], {
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true",
        AUTOVAULT_NO_UPDATE_CHECK: "1",
        NODE_NO_WARNINGS: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end();

    const ready = await waitForReady(child);
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+$/);
    expect(ready.stderr).toBe("");

    const healthUrl = new URL("/healthz", ready.url);
    const response = await fetch(healthUrl);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      name: "autovault",
      mode: "ui"
    });
  });
});

function waitForReady(
  proc: ChildProcessWithoutNullStreams
): Promise<{ url: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for UI server.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 12_000);

    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ url: match[1], stderr });
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`UI process exited before ready: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}
