import { loadConfig } from "../config.js";
import type { ValidationResult } from "../types.js";
import { attemptRepair, parseFrontmatter } from "./frontmatter.js";
import { validateSchema } from "./schema.js";
import { runSecurityScan } from "./security.js";

export function validateSkillInput(skillMd: string): ValidationResult {
  const { strictSecurity } = loadConfig();
  const { output, repaired } = attemptRepair(skillMd);
  const warnings: string[] = [];

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
  const securityFlags = runSecurityScan(output);

  if (repaired) {
    warnings.push("Frontmatter formatting was auto-normalized.");
  }

  if (!strictSecurity && securityFlags.length > 0) {
    for (const flag of securityFlags) {
      warnings.push(`Security advisory (non-strict mode): ${flag}`);
    }
  }

  const blockedBySecurity = strictSecurity && securityFlags.length > 0;

  return {
    valid: schemaResult.valid && !blockedBySecurity,
    repaired,
    warnings,
    errors: schemaResult.errors,
    securityFlags
  };
}
