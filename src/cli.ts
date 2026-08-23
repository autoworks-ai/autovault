#!/usr/bin/env node
import { runDoctorCommand } from "./cli/doctor.js";
import { runSkillCommand } from "./cli/skill.js";
import {
  printVersion,
  runUpdateCommand,
  writeOptionalUpdateNotice,
} from "./cli/update.js";
import { formatCliError } from "./cli/ui/errors.js";
import { renderSuccessOutro } from "./cli/ui/brand.js";
import { badge, sectionTitle } from "./cli/ui/messages.js";
import { bulletList, keyValueRows } from "./cli/ui/table.js";
import { makeTheme } from "./cli/ui/theme.js";
import { joinCliList, truncateCliText, writeJson } from "./cli/ui/output.js";
import { withSuppressedLogs } from "./util/log.js";
import {
  auditRepo,
  deleteSkill,
  formatAuditRepoMarkdown,
  importAutohubCapabilities,
  listConfiguredProfiles,
  resolveCapabilities,
  syncProfiles,
  type AuditRepoResult,
  type ImportAutohubResult,
  type ResolveCapabilitiesResult,
  type SyncProfilesResult,
} from "./library.js";
import { compactSyncResult, formatResultSync } from "./util/sync-format.js";

function usageText(): string {
  return `Usage:
  autovault --version
  autovault add <source-or-path> [--source github|agentskills|url|local] [--provenance <value>] [--version <v>] [--agent <agent>] [--sync-profiles|--no-sync-profiles] [--discover|--no-discover] [--link agent=/path/to/skills] [--dry-run] [--yes] [--quiet] [--verbose] [--json]
  autovault add-local <path> [--source <provenance>] [--sync-profiles] [--link agent=/path/to/skills] [--json]
  autovault remove <skill-name> [--discover|--no-discover] [--link agent=/path/to/skills] [--json]
  autovault sync-profiles [--discover] [--link agent=/path/to/skills] [--json]
  autovault profiles list [--json]
  autovault setup [--json] [--review] [--advanced]
  autovault doctor [skill-name] [--clean] [--repair] [--json]
  autovault audit-repo --repo /path/to/repo [--format json|markdown]
  autovault import-autohub --tool-filters /path/tool-filters.json [--mcp-servers /path/mcp-servers.json] [--reset] [--json]
  autovault link <slug|catalog-url|directory> [--json]
  autovault resolve --caller <id> --platform <name> [--channel <id>] --query <text> [--json]
  autovault serve [--help]
  autovault ui [--port <n>] [--no-open]
  autovault update [version|latest|stable|main] [--dry-run] [--notes] [--yes]
  autovault version [--json]
  autovault skill <action> <name>
  autovault skill list [--json]
  autovault skill search <query> [--top-k N] [--json]
  autovault skill which <name> [<action>]
`;
}

function printUsage(exitCode: number, stream: NodeJS.WriteStream): never {
  stream.write(usageText());
  if (exitCode === 0) writeOptionalUpdateNotice({ stdout: stream });
  process.exit(exitCode);
}

function usage(): never {
  return printUsage(1, process.stderr);
}

function serveHelp(): string {
  return `Usage:
  autovault serve

Starts the remote AutoVault service: an OAuth-protected Streamable HTTP MCP
server for shared or deployed vaults. This is not the local first-run setup
path; for local installation and native skill intake, run:

  autovault setup

Required before first remote boot:
  AUTOVAULT_PUBLIC_URL=http://localhost:3000
  AUTOVAULT_ADMIN_EMAIL=admin@example.com
  AUTOVAULT_ADMIN_PASSWORD=<long random password, min 12 chars>

Endpoints:
  /mcp      Streamable HTTP MCP endpoint
  /healthz  service health check

Local remote test:
  AUTOVAULT_PUBLIC_URL=http://localhost:3000 \\
  AUTOVAULT_ADMIN_EMAIL=admin@example.com \\
  AUTOVAULT_ADMIN_PASSWORD=replace-with-a-long-random-password \\
  autovault serve

Production example:
  AUTOVAULT_PUBLIC_URL=https://<service>.up.railway.app autovault serve
`;
}

function uiHelp(): string {
  return `Usage:
  autovault ui [--port <n>] [--no-open] [--offline]

Starts the local AutoVault management dashboard on 127.0.0.1 and protects the
session with a generated browser token.

Options:
  --port <n>             Bind to a specific local port. Use 0 to ask the OS for one.
  --no-open              Print the dashboard URL without opening a browser.
  --offline              Skip signed remote UI bundle checks.
  --ui-bundle-url <url>  Fetch a signed UI bundle manifest from this URL.
  --ui-channel <name>    Select the UI bundle channel. Defaults to stable.
`;
}

function missingPublicUrlMessage(): string {
  return `AutoVault remote serve needs a public URL.

autovault serve starts the OAuth-protected Streamable HTTP MCP service at /mcp.
It is for remote/shared deployments, not local first-run setup.

For local setup, run:
  autovault setup

For a local remote test, run:
  AUTOVAULT_PUBLIC_URL=http://localhost:3000 \\
  AUTOVAULT_ADMIN_EMAIL=admin@example.com \\
  AUTOVAULT_ADMIN_PASSWORD=replace-with-a-long-random-password \\
  autovault serve

For production, set the externally reachable origin, for example:
  AUTOVAULT_PUBLIC_URL=https://<service>.up.railway.app
`;
}

function missingAdminCredentialsMessage(missing: string[]): string {
  return `AutoVault remote serve needs first-owner credentials.

No owner account exists yet, so AutoVault must seed the first owner account on
remote boot. Set the missing variable${missing.length === 1 ? "" : "s"}:
  ${missing.join("\n  ")}

Example:
  AUTOVAULT_PUBLIC_URL=http://localhost:3000 \\
  AUTOVAULT_ADMIN_EMAIL=admin@example.com \\
  AUTOVAULT_ADMIN_PASSWORD=replace-with-a-long-random-password \\
  autovault serve
`;
}

async function remoteOwnerExists(): Promise<boolean> {
  const { openCapabilityDb } = await import("./capabilities/db.js");
  const row = openCapabilityDb()
    .prepare("SELECT id FROM remote_users WHERE role = 'owner' LIMIT 1")
    .get() as { id: string } | undefined;
  return Boolean(row);
}

async function runServeCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(serveHelp());
    return;
  }
  if (args.length > 0) usage();

  process.env.AUTOVAULT_MODE = "remote";

  if (!process.env.AUTOVAULT_PUBLIC_URL) {
    process.stderr.write(missingPublicUrlMessage());
    process.exit(2);
  }

  const ownerExists = await remoteOwnerExists();
  const missingAdmin = [
    !process.env.AUTOVAULT_ADMIN_EMAIL
      ? "AUTOVAULT_ADMIN_EMAIL=admin@example.com"
      : "",
    !process.env.AUTOVAULT_ADMIN_PASSWORD
      ? "AUTOVAULT_ADMIN_PASSWORD=<long random password, min 12 chars>"
      : "",
  ].filter((value) => value.length > 0);
  if (!ownerExists && missingAdmin.length > 0) {
    process.stderr.write(missingAdminCredentialsMessage(missingAdmin));
    process.exit(2);
  }

  process.stderr.write(
    "Starting AutoVault remote service (OAuth-protected Streamable HTTP MCP at /mcp). For local first-run setup, use `autovault setup`.\n",
  );
  const { startRemoteServer } = await import("./remote/server.js");
  await startRemoteServer();
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

const TOP_LEVEL_COMMANDS = [
  "add",
  "add-local",
  "audit-repo",
  "doctor",
  "import-autohub",
  "init",
  "link",
  "profiles",
  "remove",
  "resolve",
  "serve",
  "setup",
  "skill",
  "sync-profiles",
  "ui",
  "update",
  "version",
];

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1][j - 1]
          : Math.min(rows[i - 1][j - 1], rows[i - 1][j], rows[i][j - 1]) + 1;
    }
  }
  return rows[a.length][b.length];
}

function unknownCommand(command: string): never {
  process.stderr.write(`Unknown command: ${command}\n`);
  const suggestion = TOP_LEVEL_COMMANDS.map((candidate) => ({
    candidate,
    distance: editDistance(command, candidate),
  })).sort((a, b) => a.distance - b.distance)[0];
  if (suggestion && suggestion.distance <= 2) {
    process.stderr.write(`Did you mean autovault ${suggestion.candidate}?\n`);
  }
  process.stderr.write("\n");
  usage();
}

function hostRestartGuidance(): string[] {
  return [
    "restart Claude Code, Codex, or Cursor if they cache filesystem skills",
    "verify from the host by loading the autovault-skill skill",
  ];
}

function formatProfilesList(
  result: Awaited<ReturnType<typeof listConfiguredProfiles>>,
): string {
  const theme = makeTheme(process.stdout);
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${badge("profiles", theme)} ${theme.style.bold("Configured profiles")}`,
  );
  lines.push(`${theme.style.dim("config")} ${result.configPath}`);
  if (result.profiles.length === 0) {
    lines.push(`  ${theme.style.dim("No named profiles configured.")}`);
    return `${lines.join("\n")}\n`;
  }
  for (const profile of result.profiles) {
    const include =
      profile.include_tags === "*" ? "*" : profile.include_tags.join(", ");
    const exclude =
      profile.exclude_tags.length === 0
        ? "none"
        : profile.exclude_tags.join(", ");
    lines.push(
      `  ${theme.style.green(theme.symbol.check)} ${profile.name} ${theme.style.dim(profile.target)}`,
    );
    lines.push(`    agent ${profile.agent}`);
    lines.push(`    include ${include}`);
    lines.push(`    exclude ${exclude}`);
    lines.push(
      `    skills ${profile.skills.length === 0 ? "none" : profile.skills.join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatRemoveResult(result: Record<string, unknown>): string {
  const theme = makeTheme(process.stdout);
  const lines: string[] = [];
  const name = typeof result.name === "string" ? result.name : "(unknown)";
  const deleted = result.deleted === true;
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter(
        (warning): warning is string => typeof warning === "string",
      )
    : [];
  lines.push("");
  lines.push(
    `${badge("vault", theme)} ${theme.style.bold("AutoVault remover")}`,
  );
  lines.push(sectionTitle("Removal receipt", theme));
  lines.push(
    keyValueRows(
      [
        { label: "skill", value: name, status: deleted ? "ok" : "warn" },
        {
          label: "vault",
          value: deleted ? "removed" : "not installed",
          status: deleted ? "ok" : "warn",
        },
      ],
      theme,
    ),
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
      process.stdout,
    ).trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}

function formatSyncProfilesResult(result: SyncProfilesResult): string {
  const theme = makeTheme(process.stdout);
  const compact = compactSyncResult(result);
  const profileEntries = Object.entries(compact.profiles).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const linkedEntries = Object.entries(compact.linkedRoots).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const lines: string[] = [];
  const totalSkills = Object.values(compact.profiles).reduce(
    (sum, count) => sum + count,
    0,
  );
  lines.push("");
  lines.push(`${badge("sync", theme)} ${theme.style.bold("Profile sync")}`);
  lines.push(sectionTitle("Summary", theme));
  lines.push(
    keyValueRows(
      [
        {
          label: "profiles",
          value: String(profileEntries.length),
          status: "ok",
        },
        {
          label: "skills",
          value: String(totalSkills),
          status: totalSkills > 0 ? "ok" : "muted",
        },
        {
          label: "warnings",
          value: String(compact.warningCount),
          status: compact.warningCount > 0 ? "warn" : "muted",
        },
      ],
      theme,
    ),
  );
  if (linkedEntries.length > 0) {
    lines.push("");
    lines.push(`${badge("links", theme, "dim")} linked roots`);
    for (const [profile, root] of linkedEntries) {
      const count = compact.profiles[profile] ?? 0;
      const statusCounts = compact.statusCounts[profile] ?? {};
      const statuses = Object.entries(statusCounts)
        .filter(([, countValue]) => countValue && countValue > 0)
        .map(([status, countValue]) => `${status}:${countValue}`)
        .join(", ");
      lines.push(
        `  ${theme.style.green(theme.symbol.check)} ${truncateCliText(profile, 48)} ${theme.style.dim(root)} (${count} skill${count === 1 ? "" : "s"}${statuses ? `; ${statuses}` : ""})`,
      );
    }
  }
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`${badge("warn", theme, "warn")} warnings`);
    lines.push(
      bulletList(
        result.warnings.map((warning) => truncateCliText(warning, 160)),
        theme,
      ),
    );
  }
  lines.push("");
  lines.push(`${theme.style.dim("next")} ${hostRestartGuidance()[0]}`);
  lines.push(`${theme.style.dim("next")} ${hostRestartGuidance()[1]}`);
  return `${lines.join("\n")}\n`;
}

function formatImportAutohubResult(result: ImportAutohubResult): string {
  const theme = makeTheme(process.stdout);
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${badge("capabilities", theme)} ${theme.style.bold("AutoHub capability import")}`,
  );
  lines.push(sectionTitle("Import receipt", theme));
  lines.push(
    keyValueRows(
      [
        { label: "profiles", value: String(result.profiles), status: "ok" },
        {
          label: "tool groups",
          value: String(result.toolGroups),
          status: "ok",
        },
        {
          label: "context rules",
          value: String(result.contextRules),
          status: "ok",
        },
        {
          label: "mcp servers",
          value: String(result.mcpServers),
          status: "muted",
        },
        {
          label: "warnings",
          value: String(result.warnings.length),
          status: result.warnings.length > 0 ? "warn" : "muted",
        },
      ],
      theme,
    ),
  );
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`${badge("warn", theme, "warn")} warnings`);
    lines.push(
      bulletList(
        result.warnings.map((warning) => truncateCliText(warning, 160)),
        theme,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatResolveResult(result: ResolveCapabilitiesResult): string {
  const theme = makeTheme(process.stdout);
  const lines: string[] = [];
  const toolNames = result.tools.map((tool) => tool.pattern);
  const skillNames = result.skills.map((skill) => skill.name);
  const serverNames = result.mcp_servers.map((server) => {
    const env =
      server.env_required.length > 0
        ? ` env:${server.env_required.join(",")}`
        : "";
    return `${server.name}${env}`;
  });
  lines.push("");
  lines.push(
    `${badge("resolve", theme)} ${theme.style.bold("Capability resolution")}`,
  );
  lines.push(sectionTitle("Matches", theme));
  lines.push(
    keyValueRows(
      [
        {
          label: "groups",
          value: joinCliList(result.matched_groups, {
            maxItemLength: 48,
            maxItems: 10,
          }),
          status: result.matched_groups.length > 0 ? "ok" : "muted",
        },
        {
          label: "tools",
          value: joinCliList(toolNames, { maxItemLength: 64, maxItems: 8 }),
          status: toolNames.length > 0 ? "ok" : "muted",
        },
        {
          label: "skills",
          value: joinCliList(skillNames, { maxItemLength: 48, maxItems: 8 }),
          status: skillNames.length > 0 ? "ok" : "muted",
        },
        {
          label: "servers",
          value: joinCliList(serverNames, { maxItemLength: 80, maxItems: 6 }),
          status: serverNames.length > 0 ? "ok" : "muted",
        },
        {
          label: "cache",
          value: result.cache_key.slice(0, 12),
          status: "muted",
        },
      ],
      theme,
    ),
  );
  return `${lines.join("\n")}\n`;
}

function formatAuditRepoResult(result: AuditRepoResult): string {
  return formatAuditRepoMarkdown(result);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  if (command === "--help" || command === "-h") printUsage(0, process.stdout);
  if (command === "--version" || command === "-v" || command === "--v") {
    printVersion([]);
    return;
  }
  if (command === "version") {
    printVersion(args);
    return;
  }
  if (command === "update") {
    const code = await runUpdateCommand(args);
    if (code !== 0) process.exit(code);
    return;
  }

  if (command === "sync-profiles") {
    const profileRoots: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== "--link") continue;
      const value = args[i + 1];
      const [agent, root] = parseProfileLink(value);
      profileRoots[agent] = root;
      i += 1;
    }
    const result = await withSuppressedLogs(() =>
      syncProfiles({ profileRoots, discover: hasFlag(args, "--discover") }),
    );
    if (hasFlag(args, "--json")) {
      writeJson(result);
    } else {
      process.stdout.write(formatSyncProfilesResult(result));
      writeOptionalUpdateNotice();
    }
    return;
  }

  if (command === "profiles") {
    const [subcommand, ...profileArgs] = args;
    if (subcommand !== "list") usage();
    const result = await withSuppressedLogs(() => listConfiguredProfiles());
    if (hasFlag(profileArgs, "--json")) {
      writeJson(result);
    } else {
      process.stdout.write(formatProfilesList(result));
      writeOptionalUpdateNotice();
    }
    return;
  }

  if (command === "add") {
    const { runAddCommand } = await import("./cli/add.js");
    const outcome = await runAddCommand(args);
    if (outcome.shouldWriteUpdateNotice) writeOptionalUpdateNotice();
    return;
  }

  if (command === "add-local") {
    const { runAddLocalCommand } = await import("./cli/add-local.js");
    const outcome = await runAddLocalCommand(args);
    if (outcome.shouldWriteUpdateNotice) writeOptionalUpdateNotice();
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
    const result = await withSuppressedLogs(() =>
      deleteSkill({
        name,
        profile_roots: profileRoots,
        discover_profile_roots: discoverProfileRoots,
      }),
    );
    const output = formatResultSync(result, false);
    if (hasFlag(args, "--json")) {
      writeJson(output);
    } else {
      process.stdout.write(formatRemoveResult(output));
      writeOptionalUpdateNotice();
    }
    return;
  }

  if (command === "audit-repo") {
    const repo = readFlag(args, "--repo");
    const format = readFlag(args, "--format") ?? "markdown";
    if (!repo || !["json", "markdown"].includes(format)) usage();
    const result = await auditRepo({ repo });
    if (format === "json") writeJson(result);
    else {
      process.stdout.write(formatAuditRepoResult(result));
      writeOptionalUpdateNotice();
    }
    return;
  }

  if (command === "import-autohub") {
    const toolFiltersPath = readFlag(args, "--tool-filters");
    if (!toolFiltersPath) usage();
    const result = await importAutohubCapabilities({
      toolFiltersPath,
      mcpServersPath: readFlag(args, "--mcp-servers"),
      reset: hasFlag(args, "--reset"),
    });
    if (hasFlag(args, "--json")) writeJson(result);
    else {
      process.stdout.write(formatImportAutohubResult(result));
      writeOptionalUpdateNotice();
    }
    return;
  }

  if (command === "link" || command === "init") {
    const { runLinkCommand } = await import("./cli/link.js");
    await runLinkCommand(args);
    return;
  }

  if (command === "skill") {
    await withSuppressedLogs(() => runSkillCommand(args));
    if (
      ["list", "search", "which"].includes(args[0] ?? "") &&
      !hasFlag(args, "--json")
    ) {
      writeOptionalUpdateNotice();
    }
    return;
  }

  if (command === "doctor") {
    await withSuppressedLogs(() => runDoctorCommand(args));
    if (!hasFlag(args, "--json")) writeOptionalUpdateNotice();
    return;
  }

  if (command === "resolve") {
    const caller_id = readFlag(args, "--caller");
    const platform = readFlag(args, "--platform");
    const query = readFlag(args, "--query");
    if (!caller_id || !platform || !query) usage();
    const result = await withSuppressedLogs(() =>
      resolveCapabilities({
        caller_id,
        platform,
        query,
        channel: readFlag(args, "--channel"),
      }),
    );
    if (hasFlag(args, "--json")) writeJson(result);
    else {
      process.stdout.write(formatResolveResult(result));
      writeOptionalUpdateNotice();
    }
    return;
  }

  if (command === "setup") {
    const { runSetup } = await import("./cli/setup.js");
    try {
      await withSuppressedLogs(() =>
        runSetup({
          json: hasFlag(args, "--json"),
          review: hasFlag(args, "--review"),
          advanced: hasFlag(args, "--advanced"),
        }),
      );
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "NoTtyError") {
        process.stderr.write(`${(error as Error).message}\n`);
        process.exit(2);
      }
      throw error;
    }
    if (!hasFlag(args, "--json")) writeOptionalUpdateNotice();
    return;
  }

  if (command === "serve") {
    await runServeCommand(args);
    return;
  }

  if (command === "ui") {
    await runUiCommand(args);
    return;
  }

  unknownCommand(command);
}

async function runUiCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(uiHelp());
    return;
  }
  let port = 0;
  let open = true;
  let offline = false;
  let uiBundleManifestUrl: string | undefined;
  let uiChannel: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    if (arg === "--offline") {
      offline = true;
      continue;
    }
    if (arg === "--port") {
      const raw = args[i + 1];
      if (!raw || raw.startsWith("-")) usage();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) usage();
      port = parsed;
      i += 1;
      continue;
    }
    if (arg === "--ui-bundle-url") {
      const raw = args[i + 1];
      if (!raw || raw.startsWith("-")) usage();
      try {
        new URL(raw);
      } catch {
        usage();
      }
      uiBundleManifestUrl = raw;
      i += 1;
      continue;
    }
    if (arg === "--ui-channel") {
      const raw = args[i + 1];
      if (
        !raw ||
        raw.startsWith("-") ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(raw)
      )
        usage();
      uiChannel = raw;
      i += 1;
      continue;
    }
    usage();
  }

  const { startLocalUiServer } = await import("./ui/local-server.js");
  const handle = await startLocalUiServer({
    port,
    open,
    offline,
    uiBundleManifestUrl,
    uiChannel,
  });
  process.stdout.write(`AutoVault UI ready: ${handle.browserUrl}\n`);

  const shutdown = (signal: NodeJS.Signals): void => {
    void handle.close().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(formatCliError(error));
  process.exit(1);
});
