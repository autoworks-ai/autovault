import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureStorage, writeSkill } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true"
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

const skill = (name: string, tags: string[]): string => `---
name: ${name}
description: ${name} test skill with enough description text.
tags: [${tags.join(", ")}]
agents: [codex]
metadata:
  version: "1.0.0"
---

# ${name}
`;

describe("autovault profiles CLI", () => {
  it("profiles list --json reports configured filters and computed membership", async () => {
    await ensureStorage();
    await writeSkill("autohub-one", skill("autohub-one", ["autohub"]));
    await writeSkill("commerce-one", skill("commerce-one", ["autohub", "commerce"]));
    const target = path.join(currentStorageRoot(), "project-skills");
    await fs.writeFile(
      path.join(currentStorageRoot(), "profiles.config.json"),
      JSON.stringify({
        profiles: [
          {
            name: "codex-autohub",
            agent: "codex",
            target,
            include_tags: ["autohub"],
            exclude_tags: ["commerce"]
          }
        ]
      }),
      "utf-8"
    );

    const result = await runCli(["profiles", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      profiles: Array<{
        name: string;
        agent: string;
        target: string;
        include_tags: string[] | "*";
        exclude_tags: string[];
        skills: string[];
      }>;
    };
    expect(parsed.profiles).toEqual([
      {
        name: "codex-autohub",
        agent: "codex",
        target,
        include_tags: ["autohub"],
        exclude_tags: ["commerce"],
        skills: ["autohub-one"]
      }
    ]);
  });
});
