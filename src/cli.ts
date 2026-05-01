#!/usr/bin/env node
import { importAutohubCapabilities, resolveCapabilities, syncProfiles } from "./library.js";

function usage(): never {
  process.stderr.write(`Usage:
  autovault sync-profiles [--link agent=/path/to/skills]
  autovault import-autohub --tool-filters /path/tool-filters.json [--mcp-servers /path/mcp-servers.json] [--reset]
  autovault resolve --caller <id> --platform <name> [--channel <id>] --query <text>
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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage();

  if (command === "sync-profiles") {
    const profileRoots: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== "--link") continue;
      const value = args[i + 1];
      if (!value || !value.includes("=")) usage();
      const [agent, root] = value.split("=", 2);
      profileRoots[agent] = root;
      i += 1;
    }
    process.stdout.write(`${JSON.stringify(await syncProfiles({ profileRoots }), null, 2)}\n`);
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

  usage();
}

main().catch((error) => {
  process.stderr.write(`autovault failed: ${String(error)}\n`);
  process.exit(1);
});
