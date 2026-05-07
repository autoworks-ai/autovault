#!/usr/bin/env node
import { startRemoteServer } from "./remote/server.js";
import { log } from "./util/log.js";

process.env.AUTOVAULT_MODE ??= "remote";

startRemoteServer().catch((error) => {
  log.error("autovault.remote_fatal", { error: String(error) });
  process.exit(1);
});
