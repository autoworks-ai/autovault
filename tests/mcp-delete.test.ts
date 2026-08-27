import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { syncProfiles } from "../src/profiles/sync.js";
import { writeSkill } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(REPO_ROOT, "src", "index.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function skillMd(name: string): string {
  return `---
name: ${name}
description: A description that is intentionally long enough for MCP deletion tests.
agents: [claude-code, cursor]
metadata:
  version: "1.0.0"
---

# ${name}
`;
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    })
  );
}

describe("delete_skill MCP profile pruning", () => {
  it("discovers consumer roots by default and removes every managed link", async () => {
    const name = "mcp-delete-discovery";
    const fakeHome = path.join(currentStorageRoot(), "home");
    const claudeRoot = path.join(fakeHome, ".claude", "skills");
    const cursorRoot = path.join(fakeHome, ".cursor", "skills");
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.mkdir(cursorRoot, { recursive: true });
    await writeSkill(name, skillMd(name));
    await syncProfiles({
      profileRoots: { "claude-code": claudeRoot, cursor: cursorRoot }
    });

    const claudeLink = path.join(claudeRoot, name);
    const cursorLink = path.join(cursorRoot, name);
    await expect(fs.lstat(claudeLink)).resolves.toBeTruthy();
    await expect(fs.lstat(cursorLink)).resolves.toBeTruthy();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, SERVER_PATH],
      cwd: REPO_ROOT,
      env: {
        ...stringEnvironment(),
        HOME: fakeHome,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true",
        NODE_NO_WARNINGS: "1"
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "delete-skill-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const deleteTool = tools.tools.find((tool) => tool.name === "delete_skill");
      expect(deleteTool?.inputSchema.properties).toMatchObject({
        name: expect.any(Object),
        discover_profile_roots: expect.any(Object),
        profile_roots: expect.any(Object)
      });

      const result = await client.callTool({
        name: "delete_skill",
        arguments: { name }
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }

    await expect(fs.lstat(claudeLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(cursorLink)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
