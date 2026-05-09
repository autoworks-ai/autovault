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
