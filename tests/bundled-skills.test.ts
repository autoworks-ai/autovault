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

  it("repo-touching skill bins execute commands from --repo", async () => {
    const repoTouchingBins = [
      "autojack-blog-publisher/bin/autojack-blog",
      "cloudflare-ops/bin/cloudflare-ops",
      "code-review/bin/code-review",
      "home-assistant-operator/bin/home-assistant-operator",
      "mcp-registry-maintainer/bin/mcp-registry-maintainer",
      "raycast-autojack/bin/raycast-autojack"
    ];

    for (const binPath of repoTouchingBins) {
      const content = await fs.readFile(path.join(skillsRoot, binPath), "utf-8");
      expect(
        content,
        `${binPath} must run repo-owned commands with cwd set to --repo`
      ).toContain('(cd "$repo" && "$@")');
    }
  });
});
