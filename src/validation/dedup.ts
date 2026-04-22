export type DedupTier = "exact" | "near_exact" | "functional" | "novel";

export type DedupCandidate = {
  name: string;
  contentHash: string;
  content: string;
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

export function classifyDedup(
  candidateHash: string,
  candidateContent: string,
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
    const score = scoreSimilarity(candidateContent, entry.content);
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
