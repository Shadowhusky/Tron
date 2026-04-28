/**
 * Tolerant search-and-replace for file edits.
 *
 * The strict `content.includes(search)` approach fails far too often when
 * an LLM produces near-correct output: typographic curly quotes vs ASCII
 * quotes, NBSP vs space, CRLF vs LF. This module mirrors the pattern used
 * by Anthropic Claude Code's FileEditTool — try exact first, then a
 * normalized match, then preserve the *file's* original style in the
 * substituted text so output doesn't drift.
 *
 * Pure (no fs / IPC) so it can be reused by both the Electron main process
 * and the standalone server handler, and so it can be unit-tested.
 */

export interface EditMatch {
  mode: "exact" | "normalized";
  /** Number of (non-overlapping) occurrences in `content`. */
  count: number;
}

export interface EditApply {
  content: string;
  replacements: number;
}

/**
 * Map every codepoint that LLMs commonly substitute for an ASCII equivalent
 * to a canonical form. Order matters only insofar as longer sequences (CRLF)
 * must be reduced before single chars.
 */
function normalize(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    // Curly double quotes → straight
    .replace(/[“”‟″❝❞＂]/g, '"')
    // Curly single quotes / typographic apostrophes → straight
    .replace(/[‘’‚‛′❛❜＇]/g, "'")
    // Non-breaking, narrow no-break, figure spaces → ASCII space
    .replace(/[   ]/g, " ")
    // En/em dashes — left alone (semantic difference)
    ;
}

/** Find every non-overlapping start index of `needle` in `hay`. */
function indexOfAll(hay: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let i = 0;
  while (i <= hay.length - needle.length) {
    const j = hay.indexOf(needle, i);
    if (j < 0) break;
    out.push(j);
    i = j + needle.length;
  }
  return out;
}

/**
 * Locate `search` within `content`. Returns null if nothing matches under
 * any tolerance. Exact mode is preferred (and counted) over normalized so
 * a search that only hits the file's idiosyncratic typography doesn't
 * silently overcount when there are also exact hits elsewhere.
 */
export function findEditableMatch(content: string, search: string): EditMatch | null {
  if (!search) return null;
  const exact = indexOfAll(content, search);
  if (exact.length > 0) {
    return { mode: "exact", count: exact.length };
  }
  // Normalize both sides equally so the comparison is symmetric — handles
  // the common cases where either the file or the search uses fancy chars.
  const nContent = normalize(content);
  const nSearch = normalize(search);
  if (nSearch === search && nContent === content) return null;
  const norm = indexOfAll(nContent, nSearch);
  if (norm.length === 0) return null;
  return { mode: "normalized", count: norm.length };
}

/**
 * Restyle `replace` to match the typographic flavour of the matched span:
 *   - if the span had curly double quotes, alternate `"` in `replace` as
 *     `“` then `”` (open/close pairs)
 *   - same for single quotes (`'` → `‘`/`’`)
 *   - if the span had CRLF, convert `\n` in `replace` to `\r\n`
 * Other characters are left alone — NBSP and friends are too ambiguous to
 * synthesise reliably, and the caller's intent is clearer if we trust the
 * model's choice for everything but quotes and line endings.
 */
function restyle(replace: string, originalSpan: string): string {
  const hasCurlyDouble = /[“”]/.test(originalSpan);
  const hasCurlySingle = /[‘’]/.test(originalSpan);
  const hasCRLF = originalSpan.includes("\r\n");

  let out = replace;

  if (hasCurlyDouble) {
    let openNext = true;
    out = out.replace(/"/g, () => {
      const ch = openNext ? "“" : "”";
      openNext = !openNext;
      return ch;
    });
  }
  if (hasCurlySingle) {
    let openNext = true;
    out = out.replace(/'/g, () => {
      const ch = openNext ? "‘" : "’";
      openNext = !openNext;
      return ch;
    });
  }
  if (hasCRLF) {
    // Convert any LF that isn't already part of a CRLF pair.
    out = out.replace(/\r?\n/g, "\r\n");
  }

  return out;
}

/**
 * Apply the substitution. Tries exact match first, then falls back to a
 * normalized match (curly quotes, CRLF, NBSP). On the normalized path the
 * substituted text is *restyled* to match the file's original quote and
 * line-ending flavour, so editing a file written with curly quotes
 * doesn't accidentally introduce ASCII quotes.
 *
 * Returns null if no match exists under any tolerance.
 */
export function applyEdit(content: string, search: string, replace: string): EditApply | null {
  if (!search) return null;
  const exact = indexOfAll(content, search);
  if (exact.length > 0) {
    let updated = "";
    let cursor = 0;
    for (const idx of exact) {
      updated += content.slice(cursor, idx) + replace;
      cursor = idx + search.length;
    }
    updated += content.slice(cursor);
    return { content: updated, replacements: exact.length };
  }

  // Normalized fallback: walk the normalized strings to find match positions,
  // then map each match span back onto the *original* content (whose length
  // may differ if CRLF→LF collapsed bytes). Strategy: maintain parallel
  // cursors; advance the original cursor one char per normalized char,
  // skipping the dropped CR bytes from CRLF.
  const nContent = normalize(content);
  const nSearch = normalize(search);
  if (nSearch === search && nContent === content) return null;
  const matches = indexOfAll(nContent, nSearch);
  if (matches.length === 0) return null;

  // Build a lookup from normalized index → original index. We walk content
  // once and emit the original index every time we'd emit a normalized char.
  const map: number[] = new Array(nContent.length);
  let oi = 0;
  let ni = 0;
  while (oi < content.length && ni < nContent.length) {
    if (content[oi] === "\r" && content[oi + 1] === "\n") {
      map[ni] = oi + 1;
      oi += 2;
      ni += 1;
      continue;
    }
    map[ni] = oi;
    oi += 1;
    ni += 1;
  }

  let updated = "";
  let cursor = 0;
  for (const nIdx of matches) {
    const startOrig = map[nIdx];
    const endOrigInclusive = map[nIdx + nSearch.length - 1];
    if (startOrig == null || endOrigInclusive == null) continue;
    const endOrig = endOrigInclusive + 1;
    const span = content.slice(startOrig, endOrig);
    updated += content.slice(cursor, startOrig) + restyle(replace, span);
    cursor = endOrig;
  }
  updated += content.slice(cursor);
  return { content: updated, replacements: matches.length };
}
