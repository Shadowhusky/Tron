/**
 * Pure helpers that reconstruct logical text from the terminal's visual grid.
 *
 * TUI renderers (Claude Code's ink, aider, etc.) HARD-wrap their output: they
 * write a real newline at the render width and pad lines with literal spaces,
 * so every visual row is a separate buffer line (isWrapped=false). xterm's
 * getSelection() and WebLinksAddon only re-join rows xterm soft-wrapped
 * itself, which makes copied paragraphs break mid-sentence (with trailing
 * padding + indents) and splits wrapped URLs into dead fragments. Upstream:
 * anthropics/claude-code#48037/#18170/#25861, wavetermdev/waveterm#3288.
 *
 * The core heuristic is the word-wrap invariant: a wrapper only breaks a line
 * when the next word would not fit. So row i was wrapped onto row i+1 iff
 *   width(trimEnd(row_i)) + 1 + width(firstToken(row_i+1)) > cols
 * or row i is cut flush at exactly `cols` (mid-word/URL/CJK cut). Everything
 * here is pure and unit-tested.
 */

/** Rough wide-char detection: CJK unified/ext, kana, hangul, fullwidth forms,
 *  CJK punctuation. Enough for width heuristics; not a full wcwidth. */
const WIDE_CHAR_RE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** Visual column width of a string (wide chars count 2). */
export function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return w;
}

/** Visual width of the first non-space token (leading indent ignored). */
export function firstTokenWidth(s: string): number {
  const m = s.match(/^\s*(\S+)/);
  return m ? visualWidth(m[1]) : 0;
}

/** Lines that start a new semantic block must never be merged into the
 *  previous line: bullets, box-drawing, prompts, headers, blanks. */
const BLOCK_START_RE = /^[⏺●○◦•▪‣✓✗✔✘\-*+│┃╭╰╮╯├└┌┐$%>#]/;

export function isBlockStart(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || BLOCK_START_RE.test(t);
}

/** Word-wrap invariant: true when row `line` must have been wrapped onto
 *  `next` by a width-`cols` word-wrapper (next's first word wouldn't fit). */
function wrapInvariant(lineTrimmed: string, next: string, cols: number): boolean {
  const ftw = firstTokenWidth(next);
  if (ftw === 0) return false;
  return visualWidth(lineTrimmed) + 1 + ftw > cols;
}

/** True when the row is cut flush at exactly the terminal width — a mid-word
 *  cut (long URLs, CJK) that must be re-joined without a space. */
function isFlushCut(lineTrimmed: string, cols: number): boolean {
  return visualWidth(lineTrimmed) === cols;
}

/**
 * Clean up a terminal selection for the clipboard:
 *  - strip trailing padding spaces on every line (ink paints them as content)
 *  - re-join hard-wrapped paragraph lines using the word-wrap invariant.
 * Joins are conservative: the continuation must be INDENTED (claude-style
 * gutter alignment) and not a new bullet/box/prompt block — so near-full but
 * independent lines (git log, ls) are never merged. Flush cuts (exactly cols)
 * join without a space and allow unindented continuations.
 */
export function smartUnwrapSelection(text: string, cols: number): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  if (lines.length === 1 || !cols || cols <= 0) return lines.join("\n");

  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.length > 0) {
      if (isFlushCut(prev, cols) && line.trim().length > 0 && !isBlockStart(line)) {
        out[out.length - 1] = prev + line.replace(/^\s+/, "");
        continue;
      }
      const indented = /^\s/.test(line);
      if (indented && !isBlockStart(line) && wrapInvariant(prev, line, cols)) {
        out[out.length - 1] = prev + " " + line.replace(/^\s+/, "");
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

// ── Hard-wrapped URL joining (for the terminal link provider) ──────────────

const URL_START_RE = /https?:\/\/[^\s"'`<>{}|\\^]+/gi;
/** A continuation row's first token must be pure URL-body characters. */
const URL_BODY_TOKEN_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>'"）】〉。，]+$/;
/** Max continuation rows to absorb — bounds work and false-positive damage. */
const MAX_URL_CONTINUATION_ROWS = 4;

export interface WrappedUrlMatch {
  /** The reconstructed, punctuation-trimmed URL. */
  url: string;
  /** Physical rows the URL spans, counting the origin row. */
  rowSpan: number;
  /** 0-based column of the URL start within rows[0]. */
  startCol: number;
  /** 0-based EXCLUSIVE end column within the last spanned row. */
  endColLast: number;
}

/**
 * Reconstruct a URL that a TUI hard-wrapped across physical rows.
 * `rows[0]` must be the (trimmed) text of the row where the URL starts;
 * subsequent entries are the following physical rows. A row is absorbed only
 * when the URL runs to the end of the current row AND the wrap invariant (or
 * a flush cut) says the break was forced AND the next row's first token is
 * pure URL-body charset — so a complete URL followed by prose never extends.
 */
export function joinHardWrappedUrl(rows: string[], cols: number): WrappedUrlMatch | null {
  if (rows.length === 0) return null;
  const row0 = rows[0].replace(/\s+$/, "");
  URL_START_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = URL_START_RE.exec(row0)) !== null) last = m;
  if (!last) return null;

  const startCol = last.index;
  let url = last[0];
  let rowSpan = 1;
  let endColLast = startCol + url.length;

  // Extend across continuation rows while the break was clearly forced.
  let prevTrimmed = row0;
  for (let i = 1; i < rows.length && rowSpan - 1 < MAX_URL_CONTINUATION_ROWS; i++) {
    // URL must run to the very end of the current row to possibly continue.
    if (startCol + url.length !== prevTrimmed.length && rowSpan === 1) break;
    if (rowSpan > 1 && endColLast !== prevTrimmed.length) break;
    const next = rows[i];
    const nextTrimmed = next.replace(/\s+$/, "");
    const indentLen = next.length - next.replace(/^\s+/, "").length;
    const token = nextTrimmed.replace(/^\s+/, "").split(/\s+/)[0] ?? "";
    if (!token || !URL_BODY_TOKEN_RE.test(token)) break;
    if (!isFlushCut(prevTrimmed, cols) && !wrapInvariant(prevTrimmed, next, cols)) break;
    url += token;
    rowSpan = i + 1;
    endColLast = indentLen + token.length;
    prevTrimmed = nextTrimmed;
  }

  // Trim trailing punctuation that's almost never part of the URL.
  const cleaned = url.replace(TRAILING_PUNCT_RE, "");
  endColLast -= url.length - cleaned.length;
  url = cleaned;
  if (url.length < 10) return null; // shorter than "https://x."

  return { url, rowSpan, startCol, endColLast };
}
