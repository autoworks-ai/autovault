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
      const body = await fs.readFile(skillPath, "utf-8");
      skills.push({ dir: entry.name, body });
    } catch {
      // skip directories without SKILL.md
    }
  }
  return skills;
}

async function bundledResources(skillDir) {
  const root = path.join(bundledSkillsDir, skillDir);
  const resources = [];
  async function walk(current, relative) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.name !== "SKILL.md") {
        const content = await fs.readFile(abs, "utf-8");
        resources.push({ path: rel, content });
      }
    }
  }
  await walk(root, ".");
  return resources.map((item) => ({
    path: item.path.startsWith("./") ? item.path.slice(2) : item.path,
    content: item.content
  }));
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

  process.stdout.write(`Bootstrapping ${skills.length} skill(s) into ${storagePath}\n`);

  for (const skill of skills) {
    const resources = await bundledResources(skill.dir);
    process.stdout.write(`\n--- installing ${skill.dir} ---\n`);
    const result = unwrap(
      await client.callTool({
        name: "install_skill",
        arguments: {
          source: "url",
          identifier: `bundled:${skill.dir}`,
          skill_md: skill.body
        }
      })
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    if (resources.length > 0 && result.success) {
      process.stdout.write(
        `note: ${resources.length} resource file(s) detected for ${skill.dir}; they are not uploaded via install_skill. ` +
          `Use propose_skill for resource bundling, or copy them manually if needed.\n`
      );
    }
  }

  process.stdout.write("\n--- list_skills ---\n");
  const list = unwrap(await client.callTool({ name: "list_skills", arguments: {} }));
  process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);

  await client.close();
}

main().catch((error) => {
  process.stderr.write(`Bootstrap failed: ${String(error)}\n`);
  process.exit(1);
});
