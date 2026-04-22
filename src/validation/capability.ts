const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\s+[^|]/i,
  /\bwget\s+/i,
  /\bfetch\s*\(/i,
  /\bhttps?\.(?:get|request|post|put)\s*\(/i,
  /\baxios\./i
];

const NON_BASH_INTERPRETERS: RegExp[] = [
  /(?:^|\s|`)python3?\s+\S/i,
  /(?:^|\s|`)node\s+\S/i,
  /(?:^|\s|`)ruby\s+\S/i,
  /(?:^|\s|`)perl\s+\S/i,
  /(?:^|\s|`)php\s+\S/i
];

const EXTERNAL_WRITE_PATTERNS: RegExp[] = [
  />\s*~\/[^\s)"`]/,
  />>\s*~\/[^\s)"`]/,
  />\s*\/etc\//,
  />>\s*\/etc\//,
  />\s*\/tmp\//,
  />>\s*\/tmp\//
];

function matchesAny(content: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}

function asToolSet(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tools = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase());
  return tools.length > 0 ? tools : null;
}

export function checkCapabilityDeclaration(
  content: string,
  frontmatter: Record<string, unknown>
): string[] {
  const flags: string[] = [];
  const capsRaw = frontmatter.capabilities;
  if (typeof capsRaw !== "object" || capsRaw === null) return flags;
  const caps = capsRaw as Record<string, unknown>;

  if (caps.network === false && matchesAny(content, NETWORK_PATTERNS)) {
    flags.push("Capability mismatch: capabilities.network=false but network call detected");
  }

  const tools = asToolSet(caps.tools);
  if (tools && !tools.includes("bash") && !tools.includes("*")) {
    // A declared allowlist that excludes Bash is rare; skip this subcheck.
  }
  if (tools && tools.includes("bash") && tools.length === 1) {
    if (matchesAny(content, NON_BASH_INTERPRETERS)) {
      flags.push(
        "Capability mismatch: capabilities.tools=[Bash] but non-Bash interpreter usage detected"
      );
    }
  }

  if (caps.filesystem === "readonly" && matchesAny(content, EXTERNAL_WRITE_PATTERNS)) {
    flags.push(
      "Capability mismatch: capabilities.filesystem=readonly but external write detected"
    );
  }

  return flags;
}
