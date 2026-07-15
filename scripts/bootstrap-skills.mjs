import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installBundledSkill } from "../dist/library.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const bundledSkillsDir = path.join(repoRoot, "skills");

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
  return skills.sort((a, b) => a.dir.localeCompare(b.dir));
}

async function main() {
  const storagePath = process.env.AUTOVAULT_STORAGE_PATH ?? path.join(os.homedir(), ".autovault");

  const skills = await listBundledSkills();
  if (skills.length === 0) {
    process.stdout.write("No bundled skills found in skills/.\n");
    return;
  }

  process.stdout.write(`Bootstrapping ${skills.length} skill(s) into ${storagePath} and syncing profiles\n`);

  for (const skill of skills) {
    process.stdout.write(`\n--- installing ${skill.dir} ---\n`);
    const result = await installBundledSkill(skill.dir, {
      bundledSkillsDir,
      syncProfiles: true,
      discoverProfileRoots: true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Bootstrap failed: ${String(error)}\n`);
  process.exit(1);
});
