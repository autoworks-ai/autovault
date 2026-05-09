import { canonicalRelPath } from "./path.js";

const EXACT_IGNORED_ARTIFACT_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini"
]);

export function isIgnoredArtifactPath(inputPath: string): boolean {
  const canonical = canonicalRelPath(inputPath);
  if (canonical.length === 0) return false;
  const leaf = canonical.split("/").pop() ?? "";
  return EXACT_IGNORED_ARTIFACT_NAMES.has(leaf) || leaf.startsWith("._");
}

export function ignoredArtifactNamesDescription(): string {
  return ".DS_Store, Thumbs.db, desktop.ini, and AppleDouble ._* files";
}
