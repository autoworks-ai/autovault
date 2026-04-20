import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function header(text) {
  process.stdout.write(`\n--- ${text} ---\n`);
}

function unwrap(result) {
  const text = result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : result;
}

async function probeFailFast() {
  header("Fail-fast config probe (AUTOVAULT_SEARCH_MODE=embeddings)");
  const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
    env: { ...process.env, AUTOVAULT_SEARCH_MODE: "embeddings" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const stderr = Buffer.concat(stderrChunks).toString("utf-8");
  process.stdout.write(`exit_code=${code}\n`);
  process.stdout.write(stderr);
  if (code === 0) throw new Error("Expected non-zero exit on invalid config");
  if (!/Invalid AutoVault configuration/.test(stderr)) {
    throw new Error("Expected fail-fast error message in stderr");
  }
}

async function probeMcpSecurityBoundary() {
  const tempStorage = await fs.mkdtemp(path.join(os.tmpdir(), "autovault-probe-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/index.js")],
    env: {
      ...process.env,
      AUTOVAULT_STORAGE_PATH: tempStorage,
      AUTOVAULT_LOG_LEVEL: "error"
    },
    stderr: "ignore"
  });
  const client = new Client({ name: "autovault-probe", version: "1.0.0" });
  await client.connect(transport);

  header("Install a benign skill to probe against");
  const md = `---
name: probe-skill
description: Probe skill used to verify boundary checks. Long enough to satisfy schema length requirements.
metadata:
  version: "0.0.1"
---

# Body
`;
  const installed = unwrap(
    await client.callTool({
      name: "install_skill",
      arguments: { source: "url", identifier: "https://example.com/x", skill_md: md }
    })
  );
  process.stdout.write(`installed: ${installed.success}\n`);

  async function expectToolError(label, args, pattern) {
    header(label);
    let response;
    try {
      response = await client.callTool(args);
    } catch (error) {
      const msg = String(error?.message ?? error);
      process.stdout.write(`rejected (throw): ${msg}\n`);
      if (!pattern.test(msg)) throw new Error(`${label}: error did not match ${pattern}`);
      return;
    }
    const errorText = response?.content?.[0]?.text ?? "";
    if (!response?.isError) {
      throw new Error(`${label}: expected isError=true, got ${JSON.stringify(response)}`);
    }
    process.stdout.write(`rejected (isError): ${errorText}\n`);
    if (!pattern.test(errorText)) {
      throw new Error(`${label}: error text did not match ${pattern}`);
    }
  }

  await expectToolError(
    "read_skill_resource path traversal must error",
    {
      name: "read_skill_resource",
      arguments: { skill_name: "probe-skill", resource_path: "../../etc/passwd" }
    },
    /Invalid resource path/
  );

  await expectToolError(
    "read_skill_resource invalid skill name must error",
    { name: "read_skill_resource", arguments: { skill_name: "../escape", resource_path: "x" } },
    /Invalid skill name/
  );

  await expectToolError(
    "get_skill on unknown skill must error",
    { name: "get_skill", arguments: { name: "does-not-exist" } },
    /not found/
  );

  await client.close();
  await fs.rm(tempStorage, { recursive: true, force: true });
}

async function main() {
  await probeFailFast();
  await probeMcpSecurityBoundary();
  header("All probes passed");
}

main().catch((error) => {
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exit(1);
});
