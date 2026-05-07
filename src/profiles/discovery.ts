import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type KnownProfileRoot = {
  agent: string;
  root: string;
};

export const KNOWN_PROFILE_ROOTS: KnownProfileRoot[] = [
  { agent: "claude-code", root: ".claude/skills" },
  { agent: "codex", root: ".codex/skills" },
  { agent: "cursor", root: ".cursor/skills" }
];

export type DiscoverProfileRootsInput = {
  home?: string;
};

export async function discoverProfileRoots(
  input: DiscoverProfileRootsInput = {}
): Promise<Record<string, string>> {
  const home = input.home ?? os.homedir();
  const roots: Record<string, string> = {};

  for (const known of KNOWN_PROFILE_ROOTS) {
    const candidate = path.join(home, known.root);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) roots[known.agent] = candidate;
    } catch {
      // Discovery only reports roots that already exist.
    }
  }

  return roots;
}
