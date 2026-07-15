import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateSkillInput } from "../src/validation/index.js";

// Lock in the invariant that every bundled skill (and its template/example
// content where applicable) actually passes the live validator. Without this
// regression, drift between author-facing guidance and the validator (e.g.
// the round-16 case where skill-author said "bin scripts are exempt from the
// capability cross-check" while the validator scanned them) silently breaks
// the documented contract — authors follow the docs, build a skill that
// looks valid by the doc, and get rejected at install time.
const here = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.resolve(here, "..", "skills");

async function listBundledSkills(): Promise<string[]> {
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function readSkillBundle(name: string): Promise<{
  skillMd: string;
  resources: Array<{ path: string; content: string }>;
}> {
  const root = path.join(skillsRoot, name);
  const skillMd = await fs.readFile(path.join(root, "SKILL.md"), "utf-8");
  const resources: Array<{ path: string; content: string }> = [];
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (
        entry.name !== "SKILL.md" &&
        !entry.name.startsWith(".autovault-")
      ) {
        const content = await fs.readFile(abs, "utf-8");
        resources.push({ path: rel, content });
      }
    }
  }
  await walk(root, "");
  return { skillMd, resources };
}

describe("bundled skills pass validation", () => {
  it("every directory under skills/ validates clean", async () => {
    const names = await listBundledSkills();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const bundle = await readSkillBundle(name);
      const result = validateSkillInput(bundle.skillMd, bundle.resources);
      // Under strict mode (test setup default), security flags fail the
      // install. valid:true means no schema/uniqueness/reserved/bin/security
      // violation — i.e. the bundled bytes match every rule the docs claim.
      expect(
        result.valid,
        `bundled skill "${name}" failed validation: errors=${JSON.stringify(
          result.errors
        )}, securityFlags=${JSON.stringify(result.securityFlags)}`
      ).toBe(true);
    }
  });

  it("documents only MCP tool names registered by the compatibility server", async () => {
    const serverSource = await fs.readFile(
      path.resolve(here, "..", "src", "mcp", "server.ts"),
      "utf-8"
    );
    const registered = new Set(
      [...serverSource.matchAll(/server\.tool\(\s*"([a-z][a-z0-9_]*)"/g)].map(
        (match) => match[1]
      )
    );
    const documented = new Set<string>();

    for (const name of ["autovault-skill", "skill-author"]) {
      const skillMd = await fs.readFile(path.join(skillsRoot, name, "SKILL.md"), "utf-8");
      for (const match of skillMd.matchAll(/\b([a-z][a-z0-9_]+)\(\{/g)) {
        documented.add(match[1]);
      }
      expect(skillMd).not.toMatch(/\bsearch_skills\b/);
    }

    expect([...documented].sort()).toEqual(
      [...documented].filter((name) => registered.has(name)).sort()
    );
  });

  it("keeps skill-author focused on AutoVault packaging rather than general skill design", async () => {
    const skillMd = await fs.readFile(
      path.join(skillsRoot, "skill-author", "SKILL.md"),
      "utf-8"
    );

    expect(skillMd).toMatch(/AutoVault packaging/i);
    expect(skillMd).toMatch(/host-native.*skill-creator/i);
    expect(skillMd).toMatch(/get_skill\(\{query/i);
    expect(skillMd).not.toContain("demo");
  });

});
