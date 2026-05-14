import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMcpServerPath, runSetup } from "../src/cli/setup.js";
import { renderCompactScanSummary, renderReviewSkill } from "../src/cli/setup/render.js";
import { scanDrift } from "../src/cli/setup/scan.js";
import { ensureStorage, writeSkill } from "../src/storage/index.js";
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

const skillMd = (name: string, body: string): string => `---
name: ${name}
description: ${name} ${body} description text long enough to satisfy schema constraints.
metadata:
  version: "1.0.0"
---

# ${name}

${body}
`;

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

  it("renders compact first-run scan output without diagnostic details", async () => {
    await ensureStorage();
    await writeSkill("vault-ready", skillMd("vault-ready", "vault only"));

    const nativeRoot = path.join(currentStorageRoot(), "native-root");
    await fs.mkdir(path.join(nativeRoot, "native-only"), { recursive: true });
    await fs.writeFile(
      path.join(nativeRoot, "native-only", "SKILL.md"),
      skillMd("native-only", "native only"),
      "utf-8"
    );
    await fs.mkdir(path.join(nativeRoot, "tiny"), { recursive: true });
    await fs.writeFile(
      path.join(nativeRoot, "tiny", "SKILL.md"),
      "---\nname: tiny\ndescription: too short\n---\n\n# tiny\n",
      "utf-8"
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { codex: nativeRoot },
      discover: false
    });
    const stdout = await captureStdout(async () => {
      renderCompactScanSummary(report);
    });

    expect(stdout).toContain("[skills]");
    expect(stdout).toContain("3 found");
    expect(stdout).toContain("1 ready");
    expect(stdout).toContain("2 need review");
    expect(stdout).not.toContain("native-only");
    expect(stdout).not.toContain(nativeRoot);
    expect(stdout).not.toMatch(/[a-f0-9]{8}/);
  });

  it("explains when setup inferred a missing native agents declaration", async () => {
    await ensureStorage();

    const nativeRoot = path.join(currentStorageRoot(), "native-agentless-root");
    await fs.mkdir(path.join(nativeRoot, "agentless"), { recursive: true });
    await fs.writeFile(
      path.join(nativeRoot, "agentless", "SKILL.md"),
      skillMd("agentless", "native agentless"),
      "utf-8"
    );

    const report = await scanDrift({
      bundledRoot: path.join(currentStorageRoot(), "no-bundled"),
      profileRoots: { "claude-code": nativeRoot },
      discover: false
    });
    const skill = report.skills.find((entry) => entry.name === "agentless");
    expect(skill).toBeDefined();

    const stdout = await captureStdout(async () => {
      renderReviewSkill(skill!);
    });

    expect(stdout).toContain("inferred agent");
    expect(stdout).toContain("claude-code");
    expect(stdout).not.toContain("agents: at least one agent is required");
  });
});
