import path from "node:path";

// Single canonicalizer for relative resource paths shared across validation,
// storage manifest keys, bundle hashing, and CLI lookup. Inconsistencies
// between local copies of "the same" canonicalizer led to a class of bug where
// validation accepted `./bin/setup`, storage signed it under `./bin/setup`,
// and the CLI looked up `bin/setup` — install succeeded, exec refused.
//
// Full POSIX normalization is required, not a textual prefix strip: an input
// of `bin/./setup` and `bin/setup` resolve to the same on-disk file but
// without normalization they end up as distinct manifest keys, and the
// stale-prune step then deletes the just-written resource. Returns the empty
// string for inputs that do not represent a safe relative file path
// (`.`/`..`/absolute/escaping); callers treat empty as invalid.
export function canonicalRelPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) return "";
  const slashed = input.replace(/\\/g, "/").replace(/\/+/g, "/");
  // Windows drive-qualified paths are absolute (`C:/x`) or drive-relative
  // (`C:x`) on Windows even though path.posix treats them as plain relative
  // strings. Reject them here so every caller that relies on the shared
  // canonicalizer gets the same portability boundary as the storage layer.
  if (/^[a-zA-Z]:/.test(slashed)) return "";
  let normalized = path.posix.normalize(slashed);
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    return "";
  }
  if (normalized.startsWith("/") || normalized.startsWith("../")) return "";
  while (normalized.endsWith("/") && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
