export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\./g, "_");
}

export function wildcardMatches(pattern: string, value: string): boolean {
  const normalizedPattern = normalizeName(pattern);
  const normalizedValue = normalizeName(value);
  if (!normalizedPattern.includes("*")) {
    return normalizedPattern === normalizedValue;
  }
  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(normalizedValue);
}

export function matchesAny(value: string, patterns: Iterable<string>): boolean {
  for (const pattern of patterns) {
    if (wildcardMatches(pattern, value)) return true;
  }
  return false;
}

export function parseContextPattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function serverFromToolPattern(pattern: string): string | undefined {
  const clean = pattern.replace(/\*/g, "");
  if (!clean.includes(".")) return undefined;
  const server = clean.split(".")[0]?.trim();
  return server || undefined;
}
