import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type RawPattern = { id: string; regex: string; flags?: string; reason: string };

type CompiledPattern = { id: string; pattern: RegExp; reason: string };

let compiled: CompiledPattern[] | null = null;

function patternsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../scripts/security/patterns.json");
}

function loadPatterns(): CompiledPattern[] {
  if (compiled) return compiled;
  const raw = fs.readFileSync(patternsPath(), "utf-8");
  const parsed = JSON.parse(raw) as { patterns: RawPattern[] };
  compiled = parsed.patterns.map((entry) => ({
    id: entry.id,
    pattern: new RegExp(entry.regex, entry.flags ?? ""),
    reason: entry.reason
  }));
  return compiled;
}

export function runSecurityScan(content: string): string[] {
  const flags: string[] = [];
  for (const rule of loadPatterns()) {
    if (rule.pattern.test(content)) {
      flags.push(rule.reason);
    }
  }
  return flags;
}

export function resetSecurityCache(): void {
  compiled = null;
}
