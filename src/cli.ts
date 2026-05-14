#!/usr/bin/env node
import { runDoctorCommand } from "./cli/doctor.js";
import { runSkillCommand } from "./cli/skill.js";
import { renderSuccessOutro } from "./cli/ui/brand.js";
import { badge, sectionTitle } from "./cli/ui/messages.js";
import { bulletList, keyValueRows } from "./cli/ui/table.js";
import { makeTheme } from "./cli/ui/theme.js";
import {
  addLocalSkill,
  auditRepo,
  deleteSkill,
  formatAuditRepoMarkdown,
  importAutohubCapabilities,
  listConfiguredProfiles,
  resolveCapabilities,
  syncProfiles,
  type AddLocalSkillResult
} from "./library.js";
import { formatResultSync } from "./util/sync-format.js";

function usage(): never {
  process.stderr.write(`Usage:
  autovault add-local <skill-dir> --source <repo-or-url> [--sync-profiles] [--link agent=/path/to/skills] [--json]
  autovault remove <skill-name> [--discover|--no-discover] [--link agent=/path/to/skills] [--json]
  autovault sync-profiles [--discover] [--link agent=/path/to/skills]
  autovault profiles list [--json]
  autovault setup [--json] [--review] [--advanced]
  autovault doctor [skill-name] [--clean] [--repair] [--json]
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

function formatProfilesList(result: Awaited<ReturnType<typeof listConfiguredProfiles>>): string {
  const theme = makeTheme(process.stdout);
  const lines: string[] = [];
  lines.push("");
  lines.push(`${badge("profiles", theme)} ${theme.style.bold("Configured profiles")}`);
  lines.push(`${theme.style.dim("config")} ${result.configPath}`);
  if (result.profiles.length === 0) {
    lines.push(`  ${theme.style.dim("No named profiles configured.")}`);
    return `${lines.join("\n")}\n`;
  }
  for (const profile of result.profiles) {
    const include =
      profile.include_tags === "*" ? "*" : profile.include_tags.join(", ");
    const exclude =
      profile.exclude_tags.length === 0 ? "none" : profile.exclude_tags.join(", ");
    lines.push(
      `  ${theme.style.green(theme.symbol.check)} ${profile.name} ${theme.style.dim(profile.target)}`
    );
    lines.push(`    agent ${profile.agent}`);
    lines.push(`    include ${include}`);
    lines.push(`    exclude ${exclude}`);
    lines.push(
      `    skills ${profile.skills.length === 0 ? "none" : profile.skills.join(", ")}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatAddLocalResult(result: AddLocalSkillResult, skillDir: string): string {
  const theme = makeTheme(process.stdout);
  const lines: string[] = [];
  lines.push("");
  lines.push(`${badge("vault", theme)} ${theme.style.bold("AutoVault local installer")}`);
  lines.push(sectionTitle(result.success ? "Admission receipt" : "Admission blocked", theme));
  lines.push(
    keyValueRows(
      [
        { label: "scan", value: skillDir, status: "muted" },
        {
          label: "validate",
          value: result.validation.valid ? "passed" : "failed",
          status: result.validation.valid ? "ok" : "error"
        }
      ],
      theme
    )
  );
  if (result.success) {
    lines.push(
      keyValueRows(
        [
          { label: "sign", value: result.name, status: "ok" },
          ...(result.paths ? [{ label: "storage", value: result.paths.skill, status: "ok" as const }] : []),
          ...(result.source
            ? [{ label: "source", value: result.source.identifier, status: "muted" as const }]
            : [])
        ],
        theme
      )
    );
    if (result.sync) {
      lines.push("");
      lines.push(`${badge("sync", theme, "dim")} profile sync`);
      const linkedEntries = Object.entries(result.sync.linkedRoots);
      if (linkedEntries.length === 0) {
        lines.push(`  ${theme.style.dim("No external profile roots linked.")}`);
      } else {
        for (const [agent, root] of linkedEntries) {
          const count = result.sync.profiles[agent]?.length ?? 0;
          lines.push(
            `  ${theme.style.green(theme.symbol.check)} ${agent} ${theme.style.dim(root)} (${count} skill${count === 1 ? "" : "s"})`
          );
        }
      }
    }
    if (result.warnings.length > 0) {
      lines.push("");
      lines.push(`${badge("warn", theme, "warn")} warnings`);
      lines.push(bulletList(result.warnings, theme));
    }
    lines.push(
      renderSuccessOutro(
        "Skill vaulted",
        hostRestartGuidance().map((line) => `${theme.style.dim("next")} ${line}`),
        process.stdout
      ).trimEnd()
    );
  } else {
    lines.push("");
    lines.push(`${badge("error", theme, "warn")} errors`);
    lines.push(bulletList([...result.validation.errors, ...result.warnings], theme));
  }
  return `${lines.join("\n")}\n`;
}

function formatRemoveResult(result: Record<string, unknown>): string {
  const theme = makeTheme(process.stdout);
  const lines: string[] = [];
  const name = typeof result.name === "string" ? result.name : "(unknown)";
  const deleted = result.deleted === true;
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  lines.push("");
  lines.push(`${badge("vault", theme)} ${theme.style.bold("AutoVault remover")}`);
  lines.push(sectionTitle("Removal receipt", theme));
  lines.push(
    keyValueRows(
      [
        { label: "skill", value: name, status: deleted ? "ok" : "warn" },
        { label: "vault", value: deleted ? "removed" : "not installed", status: deleted ? "ok" : "warn" }
      ],
      theme
    )
  );
  if (warnings.length > 0) {
    lines.push("");
    lines.push(`${badge("warn", theme, "warn")} warnings`);
    lines.push(bulletList(warnings, theme));
  }
  lines.push(
    renderSuccessOutro(
      deleted ? "Skill removed" : "Skill was not installed",
      hostRestartGuidance().map((line) => `${theme.style.dim("next")} ${line}`),
      process.stdout
    ).trimEnd()
  );
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

  if (command === "profiles") {
    const [subcommand, ...profileArgs] = args;
    if (subcommand !== "list") usage();
    const result = await listConfiguredProfiles();
    if (hasFlag(profileArgs, "--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatProfilesList(result));
    }
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

  if (command === "remove") {
    let name: string | undefined;
    let discoverProfileRoots = true;
    const profileRoots: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--link") {
        const value = args[i + 1];
        const [agent, root] = parseProfileLink(value);
        profileRoots[agent] = root;
        i += 1;
        continue;
      }
      if (arg === "--discover") {
        discoverProfileRoots = true;
        continue;
      }
      if (arg === "--no-discover") {
        discoverProfileRoots = false;
        continue;
      }
      if (arg === "--json") continue;
      if (arg.startsWith("-")) usage();
      if (name) usage();
      name = arg;
    }
    if (!name) usage();
    const result = await deleteSkill({
      name,
      profile_roots: profileRoots,
      discover_profile_roots: discoverProfileRoots
    });
    const output = formatResultSync(result, false);
    if (hasFlag(args, "--json")) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(formatRemoveResult(output));
    }
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
      await runSetup({
        json: hasFlag(args, "--json"),
        review: hasFlag(args, "--review"),
        advanced: hasFlag(args, "--advanced")
      });
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
