// Generic, domain-agnostic text relevance: shared-word overlap between a task's free-text
// objective (plus optional journeyType hint) and a candidate anchor's visible/accessible
// text. Deliberately contains no automotive/CTA/brand vocabulary -- it is pure token
// overlap over whatever text the caller and the page happen to provide, per CLAUDE.md's
// non-negotiable design rule that the core/discovery layer never encodes domain knowledge.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "this",
  "that", "from", "by", "at", "as", "be", "it", "its", "into", "then", "than", "your", "you",
  "will", "can", "should", "which", "each", "any", "all", "not",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Fraction of the candidate's distinct tokens that also appear in the objective/journeyType
 * token set. 0 when either side tokenizes to nothing, or when there is no overlap at all.
 */
export function objectiveRelevanceScore(objectiveText: string, candidateText: string): number {
  const objectiveTokens = new Set(tokenize(objectiveText));
  if (objectiveTokens.size === 0) {
    return 0;
  }
  const candidateTokens = new Set(tokenize(candidateText));
  if (candidateTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of candidateTokens) {
    if (objectiveTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / candidateTokens.size;
}

export function rankByObjectiveRelevance<T>(
  items: T[],
  objectiveText: string,
  getText: (item: T) => string,
  limit: number,
): T[] {
  return items
    .map((item) => ({ item, score: objectiveRelevanceScore(objectiveText, getText(item)) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((scored) => scored.item);
}
