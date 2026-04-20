export function scoreSimilarity(a: string, b: string): number {
  const aTerms = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const bTerms = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = [...aTerms].filter((term) => bTerms.has(term)).length;
  const union = new Set([...aTerms, ...bTerms]).size;
  return union === 0 ? 0 : intersection / union;
}
