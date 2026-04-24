import type { Tab } from "../types";

/**
 * Select a tab by 1-based index, with digit 0 mapping to the last tab
 * (matches browser Cmd+9 "last tab" convention but extended so that
 * the dedicated Cmd+0 slot always lands on the final tab regardless of
 * how many tabs are open). Returns null for empty input, negative or
 * >9 indices, or when the requested slot is past the end.
 */
export function selectTabByIndex(tabs: Tab[], digit: number): Tab | null {
  if (tabs.length === 0) return null;
  if (digit === 0) return tabs[tabs.length - 1];
  if (digit < 1 || digit > 9) return null;
  return tabs[digit - 1] ?? null;
}

/**
 * Filter + rank tabs by query. Scoring prioritises prefix match, then
 * word-start match, then any substring match. Within a score band,
 * shorter titles win; ties fall back to original order (stable sort).
 *
 * Word boundaries: whitespace, '-', '_', '.', '/'.
 *
 * Returns a new array; empty/whitespace query returns all tabs unchanged.
 */
export function filterTabs(tabs: Tab[], query: string): Tab[] {
  const q = query.trim().toLowerCase();
  if (!q) return tabs.slice();

  const WORD_BOUNDARY = /[\s\-_./]/;

  // Higher score = better match. Non-matches get score 0 and are dropped.
  const scored = tabs
    .map((tab, idx) => {
      const title = (tab.title || "").toLowerCase();
      if (!title.includes(q)) return null;

      let score = 1; // base substring match
      if (title.startsWith(q)) {
        score = 3; // prefix match of the whole title
      } else {
        // Check for word-start match
        const pos = title.indexOf(q);
        if (pos > 0 && WORD_BOUNDARY.test(title[pos - 1])) {
          score = 2;
        }
      }
      return { tab, idx, score, len: title.length };
    })
    .filter((x): x is { tab: Tab; idx: number; score: number; len: number } => x !== null);

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.len !== b.len) return a.len - b.len;
    return a.idx - b.idx;
  });

  return scored.map((s) => s.tab);
}
