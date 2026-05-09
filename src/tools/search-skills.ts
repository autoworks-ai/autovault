import MiniSearch from "minisearch";
import { loadConfig } from "../config.js";
import { listInstalledSkillNames, readSkillSummary } from "../storage/index.js";
import type { SkillSummary } from "../types.js";

type SearchReason =
  | { kind: "name_match"; matched: string[] }
  | { kind: "title_match"; matched: string[] }
  | { kind: "description_match"; matched: string[] }
  | { kind: "tag_match"; matched: string[] }
  | { kind: "category_match"; matched: string[] };

type SearchResult = {
  name: string;
  title?: string;
  description: string;
  tags: string[];
  category?: string;
  score: number;
  reason: string;
  reasons: SearchReason[];
  search_type: "metadata_text";
};

export async function searchSkills(query: string, topK = 5): Promise<{ matches: SearchResult[] }> {
  const { searchMode } = loadConfig();
  const names = await listInstalledSkillNames();

  const documents = [];
  for (const name of names) {
    const summary = await readSkillSummary(name);
    if (!summary) continue;
    documents.push({
      id: name,
      name,
      title: summary.title ?? "",
      description: summary?.description ?? name.replace(/-/g, " "),
      tags: (summary?.tags ?? []).join(" "),
      category: summary?.category ?? "",
      when_to_use: summary.when_to_use ?? "",
      summary
    });
  }
  const documentsById = new Map(documents.map((document) => [document.id, document]));

  const search = new MiniSearch({
    fields: ["name", "title", "description", "tags", "category", "when_to_use"],
    storeFields: ["name", "title", "description", "tags", "category"]
  });
  search.addAll(documents);

  const matches = search.search(query, { prefix: true, fuzzy: 0.2 }).slice(0, topK);
  const fallbackReason =
    searchMode === "text"
      ? "Metadata text match (name/title/description/tags/category)"
      : "Metadata text match";

  return {
    matches: matches.map((match) => {
      const document = documentsById.get(String(match.id));
      const summary = document?.summary;
      const reasons = summary ? explainMetadataMatch(query, summary) : [];
      return {
        name: String(match.name),
        title: stringOrUndefined(match.title),
        description: String(match.description),
        tags: summary?.tags ?? splitStoredTags(match.tags),
        category: stringOrUndefined(match.category),
        score: match.score,
        reason: formatReasons(reasons) || fallbackReason,
        reasons,
        search_type: "metadata_text"
      };
    })
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function splitStoredTags(value: unknown): string[] {
  return typeof value === "string" && value.length > 0 ? value.split(/\s+/).filter(Boolean) : [];
}

function queryTokens(query: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "by",
    "for",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with"
  ]);
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopwords.has(token));
  return [...new Set(tokens)];
}

function matchedTokens(value: string | undefined, tokens: string[]): string[] {
  if (!value) return [];
  const normalized = value.toLowerCase();
  return tokens.filter((token) => normalized.includes(token));
}

function matchedTags(tags: string[], tokens: string[]): string[] {
  const lowerTags = tags.map((tag) => tag.toLowerCase());
  const matched = tags.filter((tag, index) =>
    tokens.some((token) => lowerTags[index]?.includes(token) || token.includes(lowerTags[index] ?? ""))
  );
  return [...new Set(matched)];
}

function explainMetadataMatch(query: string, summary: SkillSummary): SearchReason[] {
  const tokens = queryTokens(query);
  const reasons: SearchReason[] = [];
  const name = matchedTokens(summary.name, tokens);
  if (name.length > 0) reasons.push({ kind: "name_match", matched: name });
  const title = matchedTokens(summary.title, tokens);
  if (title.length > 0) reasons.push({ kind: "title_match", matched: title });
  const tags = matchedTags(summary.tags, tokens);
  if (tags.length > 0) reasons.push({ kind: "tag_match", matched: tags });
  const category = matchedTokens(summary.category, tokens);
  if (category.length > 0) reasons.push({ kind: "category_match", matched: category });
  const description = matchedTokens(summary.description, tokens);
  const whenToUse = matchedTokens(summary.when_to_use, tokens);
  const descriptionMatched = [...new Set([...description, ...whenToUse])];
  if (descriptionMatched.length > 0) {
    reasons.push({ kind: "description_match", matched: descriptionMatched });
  }
  return reasons;
}

function formatReasons(reasons: SearchReason[]): string {
  if (reasons.length === 0) return "";
  const labels = reasons.map((reason) => {
    switch (reason.kind) {
      case "name_match":
        return `matched name: ${reason.matched.join(", ")}`;
      case "title_match":
        return `matched title: ${reason.matched.join(", ")}`;
      case "description_match":
        return `matched description: ${reason.matched.join(", ")}`;
      case "tag_match":
        return `matched tags: ${reason.matched.join(", ")}`;
      case "category_match":
        return `matched category: ${reason.matched.join(", ")}`;
    }
  });
  return labels.join("; ");
}
