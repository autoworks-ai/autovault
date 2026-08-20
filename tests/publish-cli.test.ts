import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeSkill, type SkillSource } from "../src/storage/index.js";
import { bundleHash } from "../src/util/hash.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_PATH, ...args], {
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        NODE_NO_WARNINGS: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

async function fixture(): Promise<string> {
  const md = `---
name: publishable
description: Use when testing publication commands against a checked-in skill catalog.
license: MIT
agents: [codex]
metadata:
  version: "1.2.3"
---

# Publishable
`;
  const source: SkillSource = {
    source: "local",
    identifier: "fixture:publishable",
    fetchedAt: "2026-08-20T00:00:00.000Z",
    contentHash: bundleHash(md)
  };
  await writeSkill("publishable", md, [], source);
  const target = path.join(currentStorageRoot(), "target");
  await fs.mkdir(path.join(target, "catalog"), { recursive: true });
  await fs.mkdir(path.join(target, "skills", "publishable"), { recursive: true });
  await fs.writeFile(path.join(target, "skills", "publishable", "story.md"), "# Story\n");
  await fs.writeFile(
    path.join(target, "catalog", "autovault-publication.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      target: "skillissue",
      skills: { publishable: { visibility: "public" } }
    })}\n`
  );
  return target;
}

describe("autovault publish CLI", () => {
  it("lists publish commands in top-level usage", async () => {
    const result = await runCli([]);
    expect(result.stderr).toContain("autovault publish status");
    expect(result.stderr).toContain("autovault publish sync");
  });

  it("reports status as JSON", async () => {
    const target = await fixture();
    const result = await runCli(["publish", "status", "--repo", target, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { target: string; eligible: Array<{ name: string }> };
    expect(parsed.target).toBe("skillissue");
    expect(parsed.eligible).toEqual([expect.objectContaining({ name: "publishable" })]);
  });

  it("keeps sync dry-run by default and only writes with --apply", async () => {
    const target = await fixture();
    await fs.writeFile(path.join(target, "skills", "publishable", "SKILL.md"), "old bytes\n");

    const dryRun = await runCli(["publish", "sync", "--repo", target, "--json"]);
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual(
      expect.objectContaining({ applied: false, copy: ["publishable"], remove: [] })
    );
    await expect(fs.readFile(path.join(target, "skills", "publishable", "SKILL.md"), "utf-8")).resolves.toBe("old bytes\n");

    const apply = await runCli(["publish", "sync", "--repo", target, "--apply", "--json"]);
    expect(apply.exitCode).toBe(0);
    expect(JSON.parse(apply.stdout)).toEqual(
      expect.objectContaining({ applied: true, copied: ["publishable"], removed: [] })
    );
    await expect(fs.readFile(path.join(target, "skills", "publishable", "SKILL.md"), "utf-8")).resolves.toContain("name: publishable");
  });
});
