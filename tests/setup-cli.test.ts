import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMcpServerPath, runSetup } from "../src/cli/setup.js";
import { currentStorageRoot } from "./setup.js";

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return stdout;
}

describe("setup CLI", () => {
  it("prints clean JSON in --json mode", async () => {
    const stdout = await captureStdout(() =>
      runSetup({
        bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
        discover: false,
        json: true
      })
    );

    expect(stdout.trimStart().startsWith("{")).toBe(true);
    const parsed = JSON.parse(stdout);
    expect(parsed.storagePath).toBe(currentStorageRoot());
    expect(parsed.skills).toEqual([]);
  });

  it("points MCP config at the installed dist server from dist/cli", () => {
    const moduleUrl = pathToFileURL(
      path.join(path.sep, "tmp", "autovault", "app", "dist", "cli", "setup.js")
    ).href;

    expect(resolveMcpServerPath(moduleUrl, path.join(path.sep, "repo"))).toBe(
      path.join(path.sep, "tmp", "autovault", "app", "dist", "index.js")
    );
  });

  it("falls back to cwd dist server when running from source", () => {
    const moduleUrl = pathToFileURL(
      path.join(path.sep, "repo", "src", "cli", "setup.ts")
    ).href;

    expect(resolveMcpServerPath(moduleUrl, path.join(path.sep, "repo"))).toBe(
      path.join(path.sep, "repo", "dist", "index.js")
    );
  });
});
