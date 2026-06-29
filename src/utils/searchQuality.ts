/**
 * Pure helpers that make the agent's web_search smarter without changing the
 * underlying engine. The `web.search` IPC is a keyword HTML scraper (Brave →
 * DuckDuckGo → Startpage), so chat-style or repeated queries return junk and
 * the agent grinds (observed in 88ab9361f7.json: dozens of near-identical,
 * irrelevant searches). These functions detect two failure shapes —
 * near-duplicate queries and off-topic result sets — so the harness can nudge
 * the agent to reformulate instead of re-running or fetching noise. Kept pure
 * so they're unit-tested.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "of", "for", "to", "in", "on", "at", "by", "with", "from", "as", "into",
  "and", "or", "but", "not", "no", "do", "does", "did", "how", "what", "why",
  "when", "where", "which", "who", "whom", "this", "that", "these", "those",
  "it", "its", "i", "you", "me", "my", "we", "our", "can", "could", "should",
  "would", "will", "about", "any", "some", "get", "got", "use", "using",
]);

/** Tokenise a query into meaningful, de-duplicated lowercase terms (stopwords
 *  and pure punctuation removed). Quoted phrases and operators degrade to their
 *  word content, which is fine for the overlap heuristics below. */
export function queryTerms(query: string | null | undefined): string[] {
  const raw = (query ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(raw)];
}

/** Jaccard threshold above which two queries are "basically the same search". */
export const REDUNDANT_JACCARD = 0.8;
/** Fraction of query terms that must appear in the results before they count
 *  as on-topic. Below this the result set is treated as off-topic noise. */
export const LOW_RELEVANCE = 0.34;

/** True when `query` is a near-duplicate of one already run this task — running
 *  it again returns the same results and makes no progress. */
export function isRedundantQuery(query: string, recentQueries: string[]): boolean {
  const a = new Set(queryTerms(query));
  if (a.size === 0) return false;
  return recentQueries.some((r) => {
    const b = new Set(queryTerms(r));
    if (b.size === 0) return false;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union > 0 && inter / union >= REDUNDANT_JACCARD;
  });
}

/** Fraction (0..1) of the query's meaningful terms that appear anywhere in the
 *  result titles/snippets — a cheap proxy for "are these results relevant". */
export function scoreResultRelevance(
  query: string,
  results: { title?: string; snippet?: string }[],
): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 1;
  if (results.length === 0) return 0;
  const haystack = results
    .map((r) => `${r.title ?? ""} ${r.snippet ?? ""}`)
    .join(" ")
    .toLowerCase();
  const matched = terms.filter((t) => haystack.includes(t)).length;
  return matched / terms.length;
}

/**
 * Returns a reformulation hint to append to the search results, or null when
 * the search looks healthy. Order matters: a redundant query is flagged before
 * relevance (re-running the same search is the more wasteful mistake).
 */
export function searchQualityHint(
  query: string,
  results: { title?: string; snippet?: string }[],
  recentQueries: string[],
): string | null {
  if (queryTerms(query).length === 0) return null;
  if (isRedundantQuery(query, recentQueries)) {
    return "⚠ This query is nearly identical to one you already ran — it returns the same results and makes no progress. Either use the results you already have, or reformulate from a genuinely different angle (different keywords, a site: filter, or exact-phrase quotes).";
  }
  if (scoreResultRelevance(query, results) < LOW_RELEVANCE) {
    return "⚠ These results look off-topic for your query — don't fetch them blindly. Search like a search engine, not a chatbot: use specific keywords (not a full question), quote exact phrases, add a site: filter for an authoritative source, or include a distinguishing term. Reformulate and search again.";
  }
  return null;
}
