import { createHash } from "node:crypto";
import { canonicalRelPath } from "./path.js";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type HashedResource = { path: string; content: string };

// Bundle hash covers SKILL.md plus every resource (sorted by canonical POSIX
// path). Used as the artifact identity for drift detection and provenance, so a
// change to bin/setup is just as visible as a change to SKILL.md. Backward
// compatible: a bundle with zero resources hashes identically to sha256(skillMd).
export function bundleHash(skillMd: string, resources: HashedResource[] = []): string {
  if (resources.length === 0) return sha256(skillMd);
  const normalized = resources
    .map((r) => ({ path: canonicalRelPath(r.path), content: r.content }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const lines = [`SKILL.md\t${sha256(skillMd)}`];
  for (const r of normalized) {
    lines.push(`${r.path}\t${sha256(r.content)}`);
  }
  return sha256(lines.join("\n"));
}
