import { loadConfig } from "../config.js";
import { isReservedResourcePath } from "../storage/index.js";
import type { ValidationResult } from "../types.js";
import { checkBundleLimits } from "../util/limits.js";
import { canonicalRelPath } from "../util/path.js";
import { checkCapabilityDeclaration } from "./capability.js";
import { attemptRepair, parseFrontmatter } from "./frontmatter.js";
import { validateSchema } from "./schema.js";
import { runSecurityScan, scanResource } from "./security.js";

export type ValidationResource = { path: string; content: string };

function isUnsafeBinPath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return true;
  if (/^\//.test(p) || /^[a-zA-Z]:/.test(p)) return true;
  if (p.split(/[\\/]+/).some((segment) => segment === "..")) return true;
  return false;
}

// Reject duplicate canonical resource paths so an install cannot ship
// `./bin/setup` AND `bin/setup` (which collapse to the same on-disk file but
// different manifest keys depending on which canonicalizer ran), and also
// cannot ship two literally-identical `bin/setup` entries. Without the
// identical-path check, writeSkill writes the LAST entry while bundleHash
// hashes both — source metadata + dedup describe bytes that aren't actually
// installed. Reject any repeat regardless of how it spelled the path.
function checkResourceUniqueness(resources: ValidationResource[]): string[] {
  // Key duplicates by lowercased canonical path. macOS APFS and Windows NTFS
  // default to case-insensitive but case-preserving — `bin/setup` and
  // `BIN/setup` address the same on-disk file, so writeSkill collapses them to
  // one while the manifest signs two. The result is either a missing-file
  // mismatch at exec time or a bundle hash that describes bytes that cannot
  // coexist on disk. Reject case-only collisions uniformly across platforms;
  // a skill author writing both is almost always a mistake regardless of FS.
  const seen = new Map<string, string>();
  const errors: string[] = [];
  for (const resource of resources) {
    const canonical = canonicalRelPath(resource.path);
    if (canonical.length === 0) {
      errors.push(`Resource path is empty after canonicalization: ${resource.path}`);
      continue;
    }
    const key = canonical.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      errors.push(
        `Duplicate resource path after canonicalization: '${previous}' and '${resource.path}' both resolve to '${canonical}' (case-insensitive)`
      );
    } else {
      seen.set(key, resource.path);
    }
  }
  return errors;
}

// Reject resource paths that collide with the reserved files writeSkill manages
// itself: SKILL.md, .autovault-manifest, .autovault-signature, .autovault-source.json.
// Without this, a caller-supplied resource named `SKILL.md` would overwrite the
// already-validated SKILL.md in the staging dir — and the manifest would be
// re-signed over the overwritten bytes, so the install ships an attacker-
// controlled SKILL.md (different bin block, different capabilities) that was
// never validated. Same hazard for any `.autovault-*` metadata file.
// Comparison is case-insensitive because macOS APFS/HFS+ defaults are
// case-preserving but case-insensitive — `skill.md` overwrites `SKILL.md`.
function checkResourceReservedPaths(resources: ValidationResource[]): string[] {
  const errors: string[] = [];
  for (const resource of resources) {
    const canonical = canonicalRelPath(resource.path);
    if (canonical.length === 0) continue; // already flagged by uniqueness check
    if (isReservedResourcePath(canonical)) {
      errors.push(
        `Reserved resource path: '${resource.path}' canonicalizes to '${canonical}', which is managed by AutoVault and may not be supplied as a resource.`
      );
    }
  }
  return errors;
}

// Cross-check declared frontmatter resources against the actual bundle. The
// adapter contract is "the source delivers SKILL.md + every resource path it
// declares" — when an adapter (URL/agentskills) can fetch only SKILL.md, an
// install with `resources:` in the frontmatter would otherwise succeed with
// an empty bundle, get_skill would advertise paths that don't exist on disk,
// and read_skill_resource would 404. Same fix as bin mapping: refuse the
// install when the declaration and the bundle diverge.
function checkFrontmatterResourcesMapping(
  data: Record<string, unknown> | undefined,
  resources: ValidationResource[]
): string[] {
  const errors: string[] = [];
  if (!data || !Array.isArray(data.resources)) return errors;

  const bundlePaths = new Set(resources.map((r) => canonicalRelPath(r.path)));

  for (const [i, raw] of (data.resources as unknown[]).entries()) {
    if (typeof raw !== "object" || raw === null) continue;
    const path = (raw as Record<string, unknown>).path;
    if (typeof path !== "string" || path.length === 0) continue; // schema errored

    if (isUnsafeBinPath(path)) {
      errors.push(`resources[${i}].path is unsafe: ${path}`);
      continue;
    }
    const normalized = canonicalRelPath(path);
    if (!bundlePaths.has(normalized)) {
      errors.push(
        `resources[${i}].path refers to a missing bundle file: ${path} (the install/propose payload must include this file)`
      );
    }
  }
  return errors;
}

// Reverse mapping: every supplied bundle file must be referenced by EITHER
// frontmatter `resources[].path` OR a `bin.<action>.command`. Without this
// gate, an inline/propose payload can ship "hidden" files that:
//   1. get written to disk and signed in `.autovault-manifest`
//   2. are NOT advertised by `readSkill` (which only returns
//      data.resources from frontmatter), so an operator running
//      `get_skill` cannot see them, and
//   3. CAN be read back by a declared bin script (which sees the whole
//      skill directory as the user) or by anyone walking the storage tree.
// That's a real disclosure-bypass: undisclosed payloads with the same
// signature trust as declared ones. Reject any extra bundle file at
// validation so the bundle == declarations identity holds.
function checkBundleHasNoUndisclosedResources(
  data: Record<string, unknown> | undefined,
  resources: ValidationResource[]
): string[] {
  const errors: string[] = [];
  if (!data) return errors;

  const declared = new Set<string>();
  if (Array.isArray(data.resources)) {
    for (const raw of data.resources as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const p = (raw as Record<string, unknown>).path;
      if (typeof p === "string" && p.length > 0 && !isUnsafeBinPath(p)) {
        declared.add(canonicalRelPath(p));
      }
    }
  }
  if (typeof data.bin === "object" && data.bin !== null) {
    for (const raw of Object.values(data.bin as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const cmd = (raw as Record<string, unknown>).command;
      if (typeof cmd === "string" && cmd.length > 0 && !isUnsafeBinPath(cmd)) {
        declared.add(canonicalRelPath(cmd));
      }
    }
  }
  // Empty declared set means "no resources declared anywhere" — every supplied
  // file is undisclosed by definition. Don't short-circuit; iterate so the
  // error message names the offending path.
  for (const resource of resources) {
    const canonical = canonicalRelPath(resource.path);
    if (canonical.length === 0) continue; // upstream check will flag this
    if (!declared.has(canonical)) {
      errors.push(
        `Bundle includes undisclosed file '${resource.path}' (canonical '${canonical}'): every supplied resource must be referenced by frontmatter resources[] or bin.<action>.command. Add it to resources[] or remove it from the bundle.`
      );
    }
  }
  return errors;
}

// Cross-check declared bin commands against the resources that ship with the
// skill. Without this gate, a SKILL.md can declare bin.setup.command: bin/setup
// without supplying bin/setup — the install succeeds, gets a signed manifest,
// then exec fails at runtime ("not covered by manifest"). That's a successful
// install of an unusable artifact. Path safety is enforced here too so the
// validation gate (rather than only the storage layer) refuses traversal.
function checkBinResourceMapping(
  data: Record<string, unknown> | undefined,
  resources: ValidationResource[]
): string[] {
  const errors: string[] = [];
  if (!data || typeof data.bin !== "object" || data.bin === null) return errors;

  const resourceKeys = new Set(resources.map((r) => canonicalRelPath(r.path)));

  for (const [action, raw] of Object.entries(data.bin as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const command = (raw as Record<string, unknown>).command;
    if (typeof command !== "string" || command.length === 0) continue; // schema already errored

    if (isUnsafeBinPath(command)) {
      errors.push(`bin.${action}.command path is unsafe: ${command}`);
      continue;
    }
    const normalized = canonicalRelPath(command);
    if (!resourceKeys.has(normalized)) {
      errors.push(
        `bin.${action}.command refers to a missing resource: ${command} (declare it in resources[])`
      );
    }
  }
  return errors;
}

export function validateSkillInput(
  skillMd: string,
  resources: ValidationResource[] = []
): ValidationResult {
  const { strictSecurity } = loadConfig();
  const warnings: string[] = [];

  // Bound the bundle before ANY scan/parse/repair work runs. attemptRepair
  // performs full-string replacements, so feeding it a 100 MiB SKILL.md forces
  // multiple O(n) passes before the size cap rejects it — that defeats the DoS
  // protection the caps were meant to provide on inline tool paths. Check raw
  // input first; only then repair/parse.
  const limitErrors = checkBundleLimits(skillMd, resources);
  if (limitErrors.length > 0) {
    return {
      valid: false,
      repaired: false,
      warnings,
      errors: limitErrors,
      securityFlags: []
    };
  }

  const { output, repaired } = attemptRepair(skillMd);

  let parsed;
  try {
    parsed = parseFrontmatter(output);
  } catch (error) {
    return {
      valid: false,
      repaired,
      warnings,
      errors: [`Frontmatter parsing failed: ${String(error)}`],
      securityFlags: []
    };
  }

  const schemaResult = validateSchema(parsed.data);
  const resourceUniquenessErrors = checkResourceUniqueness(resources);
  const reservedPathErrors = checkResourceReservedPaths(resources);
  const frontmatterResourceErrors = checkFrontmatterResourcesMapping(parsed.data, resources);
  const binMappingErrors = checkBinResourceMapping(parsed.data, resources);
  const undisclosedResourceErrors = checkBundleHasNoUndisclosedResources(parsed.data, resources);
  const denylistFlags = runSecurityScan(output);
  const capabilityFlags = checkCapabilityDeclaration(output, parsed.data, resources);
  const resourceFlags: string[] = [];
  for (const resource of resources) {
    resourceFlags.push(...scanResource(resource.path, resource.content));
  }
  const securityFlags = [...denylistFlags, ...capabilityFlags, ...resourceFlags];

  if (repaired) {
    warnings.push("Frontmatter formatting was auto-normalized.");
  }

  if (!strictSecurity && securityFlags.length > 0) {
    for (const flag of securityFlags) {
      warnings.push(`Security advisory (non-strict mode): ${flag}`);
    }
  }

  const blockedBySecurity = strictSecurity && securityFlags.length > 0;
  const errors = [
    ...schemaResult.errors,
    ...resourceUniquenessErrors,
    ...reservedPathErrors,
    ...frontmatterResourceErrors,
    ...binMappingErrors,
    ...undisclosedResourceErrors
  ];

  return {
    valid:
      schemaResult.valid &&
      resourceUniquenessErrors.length === 0 &&
      reservedPathErrors.length === 0 &&
      frontmatterResourceErrors.length === 0 &&
      binMappingErrors.length === 0 &&
      undisclosedResourceErrors.length === 0 &&
      !blockedBySecurity,
    repaired,
    warnings,
    errors,
    securityFlags
  };
}
