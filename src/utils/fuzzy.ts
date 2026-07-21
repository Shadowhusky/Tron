/**
 * Tiny fuzzy matcher for the command palette and history search.
 * Subsequence match with a simple quality score: consecutive-run bonuses,
 * word/segment-start bonuses, and a gap penalty. Case-insensitive.
 * Returns null when `query` is not a subsequence of `text`.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === " ") continue; // spaces in the query are separators, not literals
    const found = t.indexOf(c, ti);
    if (found === -1) return null;
    // Bonuses: consecutive with previous match; start of text; after separator
    if (found === lastMatch + 1) score += 3;
    if (found === 0) score += 4;
    else if (/[\s\-_/.:]/.test(t[found - 1])) score += 2;
    score -= Math.min(3, found - ti) * 0.1; // small gap penalty
    lastMatch = found;
    ti = found + 1;
  }
  // Prefer shorter targets when scores tie
  return score - t.length * 0.01;
}

/** Rank `items` by fuzzy match against `query`; non-matches are dropped.
 *  Stable for equal scores (keeps input order). */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
): T[] {
  if (!query.trim()) return items;
  const scored: Array<{ item: T; score: number; idx: number }> = [];
  items.forEach((item, idx) => {
    const s = fuzzyScore(query, getText(item));
    if (s !== null) scored.push({ item, score: s, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((s) => s.item);
}
