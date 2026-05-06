import { canonicalRelPath } from "../util/path.js";

export type DedupTier = "exact" | "near_exact" | "functional" | "novel";

export type DedupCandidate = {
  name: string;
  contentHash: string;
  // Pre-built similarity corpus: SKILL.md text concatenated with each resource
  // file's canonicalized path + content, sorted by path. The corpus — not bare
  // SKILL.md — is what `scoreSimilarity` tokenizes. Without resources in the
  // corpus a proposal that keeps SKILL.md identical but rewrites `bin/setup`
  // (e.g. a security fix) trips near_exact at 1.0 Jaccard and surfaces as a
  // duplicate, even though `contentHash` already proved the bytes differ.
  similarityCorpus: string;
};

export type DedupResult = {
  tier: DedupTier;
  similarity: number;
  existingName?: string;
};

export const NEAR_EXACT_THRESHOLD = 0.9;
export const FUNCTIONAL_THRESHOLD = 0.75;

export function scoreSimilarity(a: string, b: string): number {
  const aTerms = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const bTerms = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = [...aTerms].filter((term) => bTerms.has(term)).length;
  const union = new Set([...aTerms, ...bTerms]).size;
  return union === 0 ? 0 : intersection / union;
}

// Build the corpus that scoreSimilarity tokenizes. SKILL.md goes first; each
// resource is appended as `path\ncontent` and the resource list is path-sorted
// so two callers that pass the same set in different order produce the same
// corpus. Path tokens participate in the Jaccard set, so a renamed resource
// (e.g. bin/setup → scripts/install) reduces similarity even when the bytes
// inside are the same.
export function buildSimilarityCorpus(
  skillMd: string,
  resources: Array<{ path: string; content: string }> = []
): string {
  if (resources.length === 0) return skillMd;
  const sorted = resources
    .map((resource) => ({
      path: canonicalRelPath(resource.path),
      content: resource.content
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const parts = [skillMd];
  for (const resource of sorted) {
    parts.push(resource.path, resource.content);
  }
  return parts.join("\n");
}

export function classifyDedup(
  candidateHash: string,
  candidateCorpus: string,
  existing: DedupCandidate[]
): DedupResult {
  for (const entry of existing) {
    if (entry.contentHash === candidateHash) {
      return { tier: "exact", similarity: 1, existingName: entry.name };
    }
  }

  let bestName: string | undefined;
  let bestScore = 0;
  for (const entry of existing) {
    const score = scoreSimilarity(candidateCorpus, entry.similarityCorpus);
    if (score > bestScore) {
      bestScore = score;
      bestName = entry.name;
    }
  }

  if (bestScore >= NEAR_EXACT_THRESHOLD) {
    return { tier: "near_exact", similarity: bestScore, existingName: bestName };
  }
  if (bestScore >= FUNCTIONAL_THRESHOLD) {
    return { tier: "functional", similarity: bestScore, existingName: bestName };
  }
  return { tier: "novel", similarity: bestScore, existingName: bestName };
}
