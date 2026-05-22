import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatJson } from "../src/cli/ui/output.js";
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

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true",
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

async function writeJson(fileName: string, value: unknown): Promise<string> {
  const filePath = path.join(currentStorageRoot(), fileName);
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
  return filePath;
}

function startsWithJsonObject(stdout: string): boolean {
  return stdout.trimStart().startsWith("{");
}

function catalogSkill(name: string, tags: string[] = ["cli"]): string {
  return `---
name: ${name}
description: ${name} skill with a long enough description for CLI catalog rendering.
tags: [${tags.join(", ")}]
agents: [codex]
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
    description: Run setup
    requires-tty: false
---

# ${name}
`;
}

describe("standardized CLI output", () => {
  it("serializes non-representable top-level JSON values as null", () => {
    for (const value of [undefined, Symbol("json"), () => undefined]) {
      expect(formatJson(value)).toBe("null");
      expect(JSON.parse(formatJson(value))).toBeNull();
    }
  });

  it("renders skill list as a human catalog by default", async () => {
    await ensureStorage();
    await writeSkill("catalog-alpha", catalogSkill("catalog-alpha", ["alpha", "cli"]), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    await writeSkill("catalog-beta", `---
name: catalog-beta
description: catalog-beta skill with a long enough description for CLI catalog rendering.
tags: [beta]
agents: [codex]
metadata:
  version: "1.0.0"
---

# catalog-beta
`);

    const result = await runCli(["skill", "list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.replaceAll(currentStorageRoot(), "<ROOT>")).toMatchInlineSnapshot(`
"
[vault] AutoVault skill catalog
Inventory --------------------------------------------
  + installed 2 skills
  + runnable  1 skill
  + actions   1
  - agents    codex

Runnable actions --------------------------------------------
  + catalog-alpha  setup

All skills --------------------------------------------
  + catalog-alpha  setup  alpha, cli  catalog-alpha skill with a long enough descri...
  - catalog-beta   none   beta        catalog-beta skill with a long enough descrip...
"
`);
  });

  it("renders skill list JSON only when requested", async () => {
    await ensureStorage();
    await writeSkill("json-alpha", catalogSkill("json-alpha"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);

    const result = await runCli(["skill", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      skills: Array<{ name: string; actions: string[]; tags: string[] }>;
    };
    expect(parsed.skills).toEqual([
      expect.objectContaining({
        name: "json-alpha",
        actions: ["setup"],
        tags: ["cli"]
      })
    ]);
  });

  it("keeps public CLI output free of structured diagnostics", async () => {
    await ensureStorage();
    await writeSkill("legacy-noise", catalogSkill("legacy-noise"), [
      { path: "bin/setup", content: "#!/usr/bin/env bash\nexit 0\n" }
    ]);
    await fs.rm(path.join(currentStorageRoot(), "skills", "legacy-noise", ".autovault-manifest"), {
      force: true
    });

    const env = { AUTOVAULT_LOG_LEVEL: "warn" };
    const list = await runCli(["skill", "list"], env);
    expect(list.exitCode).toBe(0);
    expect(list.stderr).toBe("");
    expect(list.stdout).not.toContain("storage.signature_mismatch");

    const nativeRoot = path.join(currentStorageRoot(), "native-links");
    const sync = await runCli(["sync-profiles", "--link", `codex=${nativeRoot}`], env);
    expect(sync.exitCode).toBe(0);
    expect(sync.stderr).toBe("");
    expect(sync.stdout).not.toContain("storage.signature_mismatch");
  });

  it("renders skill search JSON only when requested", async () => {
    await ensureStorage();
    await writeSkill("search-json", catalogSkill("search-json", ["search"]));

    const human = await runCli(["skill", "search", "search-json"]);
    expect(human.exitCode).toBe(0);
    expect(startsWithJsonObject(human.stdout)).toBe(false);

    const json = await runCli(["skill", "search", "search-json", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    const parsed = JSON.parse(json.stdout) as { matches: Array<{ name: string }> };
    expect(parsed.matches.map((match) => match.name)).toContain("search-json");
  });

  it("uses human defaults and explicit JSON for sync-profiles", async () => {
    await ensureStorage();
    await writeSkill("sync-human", catalogSkill("sync-human"));

    const human = await runCli(["sync-profiles"]);
    expect(human.exitCode).toBe(0);
    expect(startsWithJsonObject(human.stdout)).toBe(false);
    expect(human.stdout).toContain("[sync]");
    expect(human.stdout).toContain("Profile sync");
    expect(human.stdout).not.toContain('"profileStatus"');

    const json = await runCli(["sync-profiles", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as { profiles: Record<string, string[]> };
    expect(parsed.profiles.codex).toContain("sync-human");
  });

  it("uses human defaults and explicit JSON for import-autohub", async () => {
    const toolFiltersPath = await writeJson("tool-filters.json", {
      profiles: {
        auto: { description: "Guest", groups: ["essential"] },
        "owner-auto": { description: "Owner", groups: ["essential"] }
      },
      toolGroups: {
        essential: ["memory.recall_memory"]
      }
    });

    const human = await runCli(["import-autohub", "--tool-filters", toolFiltersPath, "--reset"]);
    expect(human.exitCode).toBe(0);
    expect(startsWithJsonObject(human.stdout)).toBe(false);
    expect(human.stdout).toContain("[capabilities]");
    expect(human.stdout).not.toContain('"toolGroups"');

    const json = await runCli([
      "import-autohub",
      "--tool-filters",
      toolFiltersPath,
      "--reset",
      "--json"
    ]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as { profiles: number; toolGroups: number };
    expect(parsed.profiles).toBe(2);
    expect(parsed.toolGroups).toBeGreaterThanOrEqual(1);
  });

  it("uses human defaults and explicit JSON for resolve", async () => {
    const toolFiltersPath = await writeJson("resolve-tool-filters.json", {
      profiles: {
        auto: { description: "Guest", groups: ["essential"] },
        "owner-auto": { description: "Owner", groups: ["essential"] }
      },
      toolGroups: {
        essential: ["memory.recall_memory"]
      }
    });
    const seed = await runCli(["import-autohub", "--tool-filters", toolFiltersPath, "--reset", "--json"]);
    expect(seed.exitCode).toBe(0);

    const args = ["resolve", "--caller", "guest", "--platform", "cli", "--query", "memory"];
    const human = await runCli(args);
    expect(human.exitCode).toBe(0);
    expect(startsWithJsonObject(human.stdout)).toBe(false);
    expect(human.stdout).toContain("[resolve]");
    expect(human.stdout).not.toContain('"cache_key"');

    const json = await runCli([...args, "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as { matched_groups: string[]; cache_key: string };
    expect(parsed.matched_groups).toContain("essential");
    expect(parsed.cache_key).toMatch(/^[a-f0-9]+$/);
  });

  it("defaults audit-repo to markdown instead of raw JSON", async () => {
    const repo = path.join(currentStorageRoot(), "audit-target");
    await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "scripts", "deploy-pages-site.js"),
      "fetch('https://api.cloudflare.com/client/v4');\n",
      "utf-8"
    );

    const human = await runCli(["audit-repo", "--repo", repo]);
    expect(human.exitCode).toBe(0);
    expect(startsWithJsonObject(human.stdout)).toBe(false);
    expect(human.stdout).toContain("# AutoVault Repo Audit");

    const json = await runCli(["audit-repo", "--repo", repo, "--format", "json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as { item_count: number };
    expect(parsed.item_count).toBeGreaterThan(0);
  });

  it("keeps direct stdout JSON writes inside the approved output helper", async () => {
    const files = [
      path.join(REPO_ROOT, "src", "cli.ts"),
      ...(await fs.readdir(path.join(REPO_ROOT, "src", "cli"), { recursive: true }))
        .filter((entry) => String(entry).endsWith(".ts"))
        .map((entry) => path.join(REPO_ROOT, "src", "cli", String(entry)))
    ];
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(path.join("src", "cli", "ui", "output.ts"))) continue;
      const content = await fs.readFile(file, "utf-8");
      if (/process\.stdout\.write\([^)]*JSON\.stringify/s.test(content)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
