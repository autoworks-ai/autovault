#!/usr/bin/env node
import { runDoctorCommand } from "./cli/doctor.js";
import { runSkillCommand } from "./cli/skill.js";
import {
  addLocalSkill,
  auditRepo,
  formatAuditRepoMarkdown,
  importAutohubCapabilities,
  resolveCapabilities,
  syncProfiles,
  type AddLocalSkillResult
} from "./library.js";

function usage(): never {
  process.stderr.write(`Usage:
  autovault add-local <skill-dir> --source <repo-or-url> [--sync-profiles] [--link agent=/path/to/skills] [--json]
  autovault sync-profiles [--discover] [--link agent=/path/to/skills]
  autovault setup [--json]
  autovault doctor [skill-name] [--clean] [--json]
  autovault audit-repo --repo /path/to/repo [--format json|markdown]
  autovault import-autohub --tool-filters /path/tool-filters.json [--mcp-servers /path/mcp-servers.json] [--reset]
  autovault resolve --caller <id> --platform <name> [--channel <id>] --query <text>
  autovault serve
  autovault skill <action> <name>
  autovault skill list
  autovault skill search <query> [--top-k N]
  autovault skill which <name> [<action>]
`);
  process.exit(1);
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseProfileLink(value: string | undefined): [string, string] {
  if (!value || !value.includes("=")) usage();
  const [agent, root] = value.split("=", 2);
  if (!agent || !root) usage();
  return [agent, root];
}

function hostRestartGuidance(): string[] {
  return [
    "restart Claude Code, Codex, or Cursor if they cache filesystem skills",
    "verify from the host by loading the autovault-skill skill"
  ];
}

function formatAddLocalResult(result: AddLocalSkillResult, skillDir: string): string {
  const lines: string[] = [];
  lines.push("=============================");
  lines.push("AutoVault local installer");
  lines.push("=============================");
  lines.push("");
  lines.push(`scan      ${skillDir}`);
  lines.push(`validate  ${result.validation.valid ? "passed" : "failed"}`);
  if (result.success) {
    lines.push(`sign      ${result.name}`);
    if (result.paths) {
      lines.push(`storage   ${result.paths.skill}`);
    }
    if (result.source) {
      lines.push(`source    ${result.source.identifier}`);
    }
    if (result.sync) {
      lines.push("");
      lines.push("profile sync");
      const linkedEntries = Object.entries(result.sync.linkedRoots);
      if (linkedEntries.length === 0) {
        lines.push("  no external profile roots linked");
      } else {
        for (const [agent, root] of linkedEntries) {
          const count = result.sync.profiles[agent]?.length ?? 0;
          lines.push(`  ${agent}: ${root} (${count} skill${count === 1 ? "" : "s"})`);
        }
      }
    }
    if (result.warnings.length > 0) {
      lines.push("");
      lines.push("warnings");
      for (const warning of result.warnings) lines.push(`  - ${warning}`);
    }
    lines.push("");
    lines.push(...hostRestartGuidance());
  } else {
    lines.push("");
    lines.push("errors");
    for (const error of result.validation.errors) lines.push(`  - ${error}`);
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage();

  if (command === "sync-profiles") {
    const profileRoots: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== "--link") continue;
      const value = args[i + 1];
      const [agent, root] = parseProfileLink(value);
      profileRoots[agent] = root;
      i += 1;
    }
    process.stdout.write(
      `${JSON.stringify(
        await syncProfiles({ profileRoots, discover: hasFlag(args, "--discover") }),
        null,
        2
      )}\n`
    );
    for (const line of hostRestartGuidance()) process.stderr.write(`${line}\n`);
    return;
  }

  if (command === "add-local") {
    let skillDir: string | undefined;
    let source: string | undefined;
    const profileRoots: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--source") {
        source = args[i + 1];
        if (!source) usage();
        i += 1;
        continue;
      }
      if (arg === "--link") {
        const value = args[i + 1];
        const [agent, root] = parseProfileLink(value);
        profileRoots[agent] = root;
        i += 1;
        continue;
      }
      if (arg === "--sync-profiles" || arg === "--json") continue;
      if (arg.startsWith("-")) usage();
      if (skillDir) usage();
      skillDir = arg;
    }
    if (!skillDir || !source) usage();
    const result = await addLocalSkill({
      skillDir,
      source,
      syncProfiles: hasFlag(args, "--sync-profiles"),
      profileRoots,
      discoverProfileRoots: hasFlag(args, "--sync-profiles")
    });
    if (hasFlag(args, "--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatAddLocalResult(result, skillDir));
    }
    if (!result.success) process.exit(1);
    return;
  }

  if (command === "audit-repo") {
    const repo = readFlag(args, "--repo");
    const format = readFlag(args, "--format") ?? "json";
    if (!repo || !["json", "markdown"].includes(format)) usage();
    const result = await auditRepo({ repo });
    if (format === "markdown") {
      process.stdout.write(formatAuditRepoMarkdown(result));
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return;
  }

  if (command === "import-autohub") {
    const toolFiltersPath = readFlag(args, "--tool-filters");
    if (!toolFiltersPath) usage();
    const result = await importAutohubCapabilities({
      toolFiltersPath,
      mcpServersPath: readFlag(args, "--mcp-servers"),
      reset: hasFlag(args, "--reset")
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "skill") {
    await runSkillCommand(args);
    return;
  }

  if (command === "doctor") {
    await runDoctorCommand(args);
    return;
  }

  if (command === "resolve") {
    const caller_id = readFlag(args, "--caller");
    const platform = readFlag(args, "--platform");
    const query = readFlag(args, "--query");
    if (!caller_id || !platform || !query) usage();
    const result = await resolveCapabilities({
      caller_id,
      platform,
      query,
      channel: readFlag(args, "--channel")
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "setup") {
    const { runSetup } = await import("./cli/setup.js");
    try {
      await runSetup({ json: hasFlag(args, "--json") });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "NoTtyError") {
        process.stderr.write(`${(error as Error).message}\n`);
        process.exit(2);
      }
      throw error;
    }
    return;
  }

  if (command === "serve") {
    process.env.AUTOVAULT_MODE ??= "remote";
    const { startRemoteServer } = await import("./remote/server.js");
    await startRemoteServer();
    return;
  }

  usage();
}

main().catch((error) => {
  process.stderr.write(`autovault failed: ${String(error)}\n`);
  process.exit(1);
});
