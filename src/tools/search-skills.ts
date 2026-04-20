import MiniSearch from "minisearch";
import { loadConfig } from "../config.js";
import { listInstalledSkillNames, readSkillSummary } from "../storage/index.js";

type SearchResult = {
  name: string;
  description: string;
  score: number;
  reason: string;
};

export async function searchSkills(query: string, topK = 5): Promise<{ matches: SearchResult[] }> {
  const { searchMode } = loadConfig();
  const names = await listInstalledSkillNames();

  const documents = [];
  for (const name of names) {
    const summary = await readSkillSummary(name);
    documents.push({
      id: name,
      name,
      description: summary?.description ?? name.replace(/-/g, " "),
      tags: (summary?.tags ?? []).join(" "),
      category: summary?.category ?? ""
    });
  }

  const search = new MiniSearch({
    fields: ["name", "description", "tags", "category"],
    storeFields: ["name", "description"]
  });
  search.addAll(documents);

  const matches = search.search(query, { prefix: true, fuzzy: 0.2 }).slice(0, topK);
  const reason = searchMode === "text" ? "Text match (name/description/tags)" : "Text match";

  return {
    matches: matches.map((match) => ({
      name: String(match.name),
      description: String(match.description),
      score: match.score,
      reason
    }))
  };
}
