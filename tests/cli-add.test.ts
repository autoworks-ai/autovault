import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runAddCommand } from "../src/cli/add.js";
import type { AddSkillInput } from "../src/tools/add-skill.js";
import type { AddLocalSkillResult } from "../src/installer/local.js";
import { readSkillManifest } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type TestIo = {
  stdout: { write: (chunk: string) => void };
  stderr: { write: (chunk: string) => void };
  exit: (code: number) => never;
};

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true",
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

function makeIo(): TestIo & { stdoutText: () => string; stderrText: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(chunk: string): void {
        stdout += chunk;
      }
    },
    stderr: {
      write(chunk: string): void {
        stderr += chunk;
      }
    },
    exit(code: number): never {
      throw new ExitError(code);
    },
    stdoutText: () => stdout,
    stderrText: () => stderr
  };
}

async function writeLocalSkill(root: string, name: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "SKILL.md"),
    `---
name: ${name}
description: A description that is intentionally long enough to satisfy schema checks.
agents: [codex]
metadata:
  version: "1.0.0"
---

# ${name}
`,
    "utf-8"
  );
}

describe("canonical add CLI", () => {
  it("adds a local directory through autovault add with explicit non-TTY confirmation and strict JSON", async () => {
    const sourceDir = path.join(currentStorageRoot(), "canonical-local-dir");
    await writeLocalSkill(sourceDir, "canonical-local-dir");

    const result = await runCli(["add", sourceDir, "--yes", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as AddLocalSkillResult;
    expect(parsed.success).toBe(true);
    expect(parsed.name).toBe("canonical-local-dir");
    expect(parsed.source).toMatchObject({
      source: "local",
      identifier: path.resolve(sourceDir)
    });
    expect(parsed.sourceInferred).toBe(true);
  });

  it("adds a direct SKILL.md path through autovault add", async () => {
    const sourceDir = path.join(currentStorageRoot(), "canonical-skill-md");
    await writeLocalSkill(sourceDir, "canonical-skill-md");

    const result = await runCli(["add", path.join(sourceDir, "SKILL.md"), "--yes", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as AddLocalSkillResult;
    expect(parsed.success).toBe(true);
    expect(parsed.bundleRoot).toBe(path.resolve(sourceDir));
    expect(parsed.source?.identifier).toBe(path.resolve(sourceDir));
  });

  it("routes GitHub repo URLs to addSkill and preserves multiple candidate output", async () => {
    const io = makeIo();
    const addSkill = vi.fn().mockResolvedValue({
      success: false,
      name: "",
      outcome: "multiple_candidates",
      validation: {},
      candidates: [
        {
          name: "alpha-skill",
          description: "Alpha skill description long enough for display.",
          path: "skills/a/SKILL.md",
          identifier: "owner/repo:skills/a/SKILL.md"
        }
      ],
      warnings: ["Found 1 skills in owner/repo; choose one to import."]
    });

    await expect(
      runAddCommand(["https://github.com/owner/repo", "--yes", "--json"], io, { addSkill })
    ).rejects.toMatchObject({ code: 1 });

    expect(addSkill).toHaveBeenCalledWith({
      source: "github",
      identifier: "https://github.com/owner/repo",
      sync_profiles: true,
      discover_profile_roots: false
    } satisfies AddSkillInput);
    expect(io.stderrText()).toBe("");
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      success: false,
      outcome: "multiple_candidates",
      candidates: [{ name: "alpha-skill" }]
    });
  });

  it("routes explicit URL sources to addSkill", async () => {
    const io = makeIo();
    const addSkill = vi.fn().mockResolvedValue({
      success: true,
      name: "url-skill",
      validation: { valid: true, warnings: [], errors: [], securityFlags: [] },
      warnings: [],
      source: { source: "url", identifier: "https://example.com/SKILL.md" }
    });

    await runAddCommand(
      ["https://example.com/SKILL.md", "--source", "url", "--yes", "--json"],
      io,
      {
        addSkill
      }
    );

    expect(addSkill).toHaveBeenCalledWith({
      source: "url",
      identifier: "https://example.com/SKILL.md",
      sync_profiles: true,
      discover_profile_roots: false
    } satisfies AddSkillInput);
    expect(JSON.parse(io.stdoutText())).toMatchObject({ success: true, name: "url-skill" });
  });

  it("passes explicit target agents to remote addSkill inputs", async () => {
    const io = makeIo();
    const addSkill = vi.fn().mockResolvedValue({
      success: true,
      name: "url-skill",
      validation: { valid: true, warnings: [], errors: [], securityFlags: [] },
      warnings: [],
      source: {
        source: "url",
        identifier: "https://example.com/SKILL.md",
        targetAgents: ["codex", "claude-code"]
      }
    });

    await runAddCommand(
      [
        "https://example.com/SKILL.md",
        "--source",
        "url",
        "--agent",
        "codex",
        "--agent",
        "claude-code",
        "--yes",
        "--json"
      ],
      io,
      { addSkill }
    );

    expect(addSkill).toHaveBeenCalledWith({
      source: "url",
      identifier: "https://example.com/SKILL.md",
      sync_profiles: true,
      discover_profile_roots: false,
      target_agents: ["codex", "claude-code"]
    } satisfies AddSkillInput);
    expect(JSON.parse(io.stdoutText())).toMatchObject({ success: true, name: "url-skill" });
  });

  it("routes agentskills slugs when --source agentskills is explicit", async () => {
    const io = makeIo();
    const addSkill = vi.fn().mockResolvedValue({
      success: true,
      name: "registry-skill",
      validation: { valid: true, warnings: [], errors: [], securityFlags: [] },
      warnings: [],
      source: { source: "agentskills", identifier: "registry-skill" }
    });

    await runAddCommand(["registry-skill", "--source", "agentskills", "--yes", "--json"], io, {
      addSkill
    });

    expect(addSkill).toHaveBeenCalledWith({
      source: "agentskills",
      identifier: "registry-skill",
      sync_profiles: true,
      discover_profile_roots: false
    } satisfies AddSkillInput);
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      success: true,
      source: { source: "agentskills" }
    });
  });

  it("prints compact human output for successful remote adds", async () => {
    const io = makeIo();
    const addSkill = vi.fn().mockResolvedValue({
      success: true,
      name: "url-skill",
      validation: { valid: true, warnings: [], errors: [], securityFlags: [] },
      warnings: [],
      source: { source: "url", identifier: "https://example.com/SKILL.md" }
    });

    await runAddCommand(["https://example.com/SKILL.md", "--source", "url", "--yes"], io, {
      addSkill
    });

    expect(io.stderrText()).toBe("");
    expect(io.stdoutText()).toContain("[vault] AutoVault skill adder");
    expect(io.stdoutText()).toContain("+ validate passed");
    expect(io.stdoutText()).toContain("+ install  url-skill");
    expect(io.stdoutText()).toContain("- source   https://example.com/SKILL.md");
    expect(io.stdoutText()).toContain("Skill vaulted");
  });

  it("prints validation errors for blocked remote adds", async () => {
    const io = makeIo();
    const addSkill = vi.fn().mockResolvedValue({
      success: false,
      name: "",
      validation: {
        valid: false,
        warnings: [],
        errors: ["agents: at least one agent is required"],
        securityFlags: []
      },
      warnings: [],
      source: { source: "github", identifier: "owner/repo:skills/foo/SKILL.md" }
    });

    await expect(
      runAddCommand(["owner/repo:skills/foo", "--yes"], io, { addSkill })
    ).rejects.toMatchObject({ code: 1 });

    expect(io.stderrText()).toBe("");
    expect(io.stdoutText()).toContain("Admission blocked");
    expect(io.stdoutText()).toContain("validate failed");
    expect(io.stdoutText()).toContain("agents: at least one agent is required");
  });

  it("prints target-agent recovery commands for remote adds missing agents metadata", async () => {
    const io = makeIo();
    const addSkill = vi.fn().mockResolvedValue({
      success: false,
      name: "remote-skill",
      outcome: "target_agents_required",
      validation: {
        valid: true,
        warnings: [],
        errors: [],
        securityFlags: []
      },
      warnings: [
        "The fetched skill has no agents frontmatter, so profile sync needs an explicit target."
      ],
      source: { source: "github", identifier: "owner/repo:skills/foo/SKILL.md" }
    });

    await expect(
      runAddCommand(["owner/repo:skills/foo", "--yes"], io, { addSkill })
    ).rejects.toMatchObject({ code: 1 });

    expect(io.stdoutText()).toContain("Admission blocked");
    expect(io.stdoutText()).toContain("target agents required");
    expect(io.stdoutText()).toContain("autovault add owner/repo:skills/foo --agent codex --yes");
    expect(io.stdoutText()).toContain("autovault add owner/repo:skills/foo --no-sync-profiles --yes");
  });

  it("dry-runs local JSON without installing", async () => {
    const sourceDir = path.join(currentStorageRoot(), "dry-run-local-dir");
    await writeLocalSkill(sourceDir, "dry-run-local-dir");

    const result = await runCli(["add", sourceDir, "--dry-run", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      success: boolean;
      dryRun: boolean;
      wouldWrite: boolean;
      plan: { source: string; target: string };
      preflight: { name: string; validation: { valid: boolean } };
    };
    expect(parsed).toMatchObject({
      success: true,
      dryRun: true,
      wouldWrite: false,
      plan: { source: "local", target: sourceDir },
      preflight: { name: "dry-run-local-dir", validation: { valid: true } }
    });
    await expect(readSkillManifest("dry-run-local-dir")).resolves.toBeNull();
  });

  it("prints a compact human dry-run plan without installing", async () => {
    const sourceDir = path.join(currentStorageRoot(), "dry-run-human-local");
    await writeLocalSkill(sourceDir, "dry-run-human-local");

    const result = await runCli(["add", sourceDir, "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[vault] AutoVault add plan");
    expect(result.stdout).toContain("write     no (dry run)");
    expect(result.stdout).toContain("validate  passed");
    expect(result.stdout).not.toContain("Skill vaulted");
    await expect(readSkillManifest("dry-run-human-local")).resolves.toBeNull();
  });

  it("does not mutate from a non-TTY human add unless --yes is passed", async () => {
    const sourceDir = path.join(currentStorageRoot(), "non-tty-needs-yes");
    await writeLocalSkill(sourceDir, "non-tty-needs-yes");

    const result = await runCli(["add", sourceDir]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[vault] AutoVault add plan");
    expect(result.stdout).toContain("write     pending confirmation");
    expect(result.stdout).toContain("Run autovault add");
    expect(result.stdout).toContain("--yes to apply");
    await expect(readSkillManifest("non-tty-needs-yes")).resolves.toBeNull();
  });

  it("requires --yes for non-TTY JSON mutation", async () => {
    const sourceDir = path.join(currentStorageRoot(), "json-needs-yes");
    await writeLocalSkill(sourceDir, "json-needs-yes");

    const result = await runCli(["add", sourceDir, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      success: boolean;
      needsConfirmation: boolean;
      wouldWrite: boolean;
      plan: { source: string };
    };
    expect(parsed).toMatchObject({
      success: false,
      needsConfirmation: true,
      wouldWrite: false,
      plan: { source: "local" }
    });
    await expect(readSkillManifest("json-needs-yes")).resolves.toBeNull();
  });

  it("suppresses human success output and update notices in quiet mode", async () => {
    const sourceDir = path.join(currentStorageRoot(), "quiet-local");
    await writeLocalSkill(sourceDir, "quiet-local");

    const result = await runCli(["add", sourceDir, "--yes", "--quiet"], {
      AUTOVAULT_LATEST_VERSION: "999.0.0"
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect(readSkillManifest("quiet-local")).resolves.toBeTruthy();
  });

  it("passes verbose mode through to JSON add results", async () => {
    const io = makeIo();
    const addSkill = vi.fn().mockResolvedValue({
      success: true,
      name: "url-skill",
      validation: { valid: true, warnings: [], errors: [], securityFlags: [] },
      warnings: [],
      source: { source: "url", identifier: "https://example.com/SKILL.md" },
      sync: { profiles: [], warnings: [], linkedRoots: {} }
    });

    await runAddCommand(
      ["https://example.com/SKILL.md", "--source", "url", "--yes", "--verbose", "--json"],
      io,
      { addSkill }
    );

    expect(addSkill).toHaveBeenCalledWith({
      source: "url",
      identifier: "https://example.com/SKILL.md",
      sync_profiles: true,
      discover_profile_roots: false,
      verbose: true
    } satisfies AddSkillInput);
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      success: true,
      sync: { linkedRoots: {} }
    });
  });

  it("dry-runs remote sources without calling addSkill", async () => {
    const io = makeIo();
    const addSkill = vi.fn();

    await runAddCommand(
      ["https://github.com/owner/repo", "--dry-run", "--json"],
      io,
      { addSkill }
    );

    expect(addSkill).not.toHaveBeenCalled();
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      success: true,
      dryRun: true,
      wouldWrite: false,
      plan: {
        source: "github",
        identifier: "https://github.com/owner/repo"
      }
    });
  });

  it("returns strict JSON when add fails before installation", async () => {
    const missingPath = path.join(currentStorageRoot(), "missing-skill");
    const result = await runCli(["add", missingPath, "--source", "local", "--yes", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      error: expect.stringContaining("Local skill path does not exist")
    });
  });
});
