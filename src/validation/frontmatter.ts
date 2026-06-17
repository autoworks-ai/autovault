import matter from "gray-matter";

type ParsedFrontmatter = {
  data: Record<string, unknown>;
  content: string;
};

export function parseFrontmatter(skillMd: string): ParsedFrontmatter {
  const parsed = matter(skillMd);
  return {
    data: parsed.data,
    content: parsed.content
  };
}

export function attemptRepair(skillMd: string): { output: string; repaired: boolean } {
  const normalized = normalizeFrontmatterWhitespace(skillMd);
  return { output: normalized, repaired: normalized !== skillMd };
}

function normalizeFrontmatterWhitespace(skillMd: string): string {
  const normalizedTabs = skillMd.split("\t").join("  ");
  const lines = normalizedTabs.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    lines[i] = trimTrailingSpacesAndTabs(lines[i]);
  }
  return lines.join("\n");
}

function trimTrailingSpacesAndTabs(input: string): string {
  let end = input.length;
  while (end > 0) {
    const code = input.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x09) break;
    end -= 1;
  }
  return end === input.length ? input : input.slice(0, end);
}

/**
 * Extract the metadata map (if present) from frontmatter data or raw SKILL.md.
 * Avoids duplicating parse logic; callers can pass an already-parsed data record
 * to skip re-parsing YAML.
 */
export function getMetadata(
  input: string | Record<string, unknown>
): Record<string, unknown> {
  let data: Record<string, unknown>;
  if (typeof input === "string") {
    const { data: parsed } = parseFrontmatter(input);
    data = parsed;
  } else {
    data = input;
  }
  const meta = (data as Record<string, unknown>).metadata;
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    return { ...meta } as Record<string, unknown>;
  }
  return {};
}

export function extractAuthor(input: string | Record<string, unknown>): string | undefined {
  const meta = getMetadata(input);
  const value = meta.author;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function extractSource(input: string | Record<string, unknown>): string | undefined {
  const meta = getMetadata(input);
  const value = meta.source;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
