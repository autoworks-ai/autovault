// Shared upper bounds for skill bundles. Enforced uniformly across every write
// path (inline, propose, github, url) so a single buggy or adversarial caller
// cannot DoS the validator/signer by shipping an unbounded resources array or
// multi-megabyte content blobs. These caps are intentionally generous — real
// skills are well under 100 KiB total.
export const MAX_RESOURCES = 50;
export const MAX_RESOURCE_BYTES = 1 * 1024 * 1024; // 1 MiB per resource
export const MAX_SKILL_MD_BYTES = 256 * 1024; // 256 KiB SKILL.md
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MiB across all resources

// Round-50 fix: short-circuit on cardinality + cumulative byte caps. The
// previous implementation kept iterating a hostile resources array even after
// the count cap fired, doing Buffer.byteLength (O(N) per element) on every
// entry — a free DoS lever for a caller shipping 10k tiny strings, since
// the array itself was already in memory by the time we got here. Reject on
// count first, then break out of the byte loop once the cumulative cap
// trips. We still report SKILL.md size and per-resource oversize for entries
// scanned before the trip, so legitimate edits get useful diagnostics.
export function checkBundleLimits(
  skillMd: string,
  resources: Array<{ path: string; content: string }>
): string[] {
  const errors: string[] = [];
  const skillMdBytes = Buffer.byteLength(skillMd, "utf-8");
  if (skillMdBytes > MAX_SKILL_MD_BYTES) {
    errors.push(`SKILL.md is ${skillMdBytes} bytes (> ${MAX_SKILL_MD_BYTES})`);
  }
  if (resources.length > MAX_RESOURCES) {
    errors.push(`Too many resources: ${resources.length} > ${MAX_RESOURCES}`);
    return errors;
  }
  let total = skillMdBytes;
  for (const resource of resources) {
    const size = Buffer.byteLength(resource.content, "utf-8");
    if (size > MAX_RESOURCE_BYTES) {
      errors.push(`Resource '${resource.path}' is ${size} bytes (> ${MAX_RESOURCE_BYTES})`);
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      errors.push(`Bundle total bytes ${total} > ${MAX_TOTAL_BYTES}`);
      return errors;
    }
  }
  return errors;
}
