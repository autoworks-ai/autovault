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
  const normalized = skillMd.replace(/\t/g, "  ").replace(/[ \t]+$/gm, "");
  return { output: normalized, repaired: normalized !== skillMd };
}
