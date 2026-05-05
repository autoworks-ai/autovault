import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp/server.js";
import { ensureStorage, recoverOrphanBackups } from "./storage/index.js";
import { loadConfig } from "./config.js";
import { log } from "./util/log.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureStorage();
  // Run crash recovery exactly once at boot — not from ensureStorage. Recovery
  // touches `.tmp.*` and `.bak.*` siblings that writeSkill creates transiently,
  // so calling it from any tool path would race concurrent installs. The
  // server is single-process / single-spawn, so once-per-boot is sufficient.
  await recoverOrphanBackups();
  log.info("autovault.starting", {
    mode: config.mode,
    storagePath: config.storagePath,
    strictSecurity: config.strictSecurity,
    searchMode: config.searchMode,
    transport: "stdio"
  });
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("autovault.ready");
}

main().catch((error) => {
  log.error("autovault.fatal", { error: String(error) });
  process.exit(1);
});
