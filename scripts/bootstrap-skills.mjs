import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const bundledSkillsDir = path.join(repoRoot, "skills");

function unwrap(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return { _isError: Boolean(result?.isError), text };
  }
}

async function listBundledSkills() {
  const entries = await fs.readdir(bundledSkillsDir, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(bundledSkillsDir, entry.name, "SKILL.md");
    try {
      await fs.access(skillPath);
      skills.push({ dir: entry.name });
    } catch {
      // skip directories without SKILL.md
    }
  }
  return skills;
}

async function main() {
  const storagePath = process.env.AUTOVAULT_STORAGE_PATH ?? path.join(os.homedir(), ".autovault");

  const skills = await listBundledSkills();
  if (skills.length === 0) {
    process.stdout.write("No bundled skills found in skills/.\n");
    return;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(repoRoot, "dist/index.js")],
    env: {
      ...process.env,
      AUTOVAULT_STORAGE_PATH: storagePath,
      AUTOVAULT_LOG_LEVEL: "info"
    },
    stderr: "inherit"
  });
  const client = new Client({ name: "autovault-bootstrap", version: "1.0.0" });
  await client.connect(transport);

  process.stdout.write(`Bootstrapping ${skills.length} skill(s) into ${storagePath} and syncing profiles\n`);

  for (const skill of skills) {
    process.stdout.write(`\n--- installing ${skill.dir} ---\n`);
    const result = unwrap(
      await client.callTool({
        name: "add_skill",
        arguments: {
          source: "local",
          identifier: skill.dir,
          skill_dir: path.join(bundledSkillsDir, skill.dir),
          sync_profiles: true,
          discover_profile_roots: true
        }
      })
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  process.stdout.write("\n--- get_skill query ---\n");
  const list = unwrap(await client.callTool({ name: "get_skill", arguments: { query: "skill", top_k: 20 } }));
  process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);

  await client.close();
}

main().catch((error) => {
  process.stderr.write(`Bootstrap failed: ${String(error)}\n`);
  process.exit(1);
});
