/**
 * Pure helpers that reconstruct logical text from the terminal's visual grid.
 *
 * TUI renderers (Claude Code's ink, aider, etc.) HARD-wrap their output: they
 * write a real newline at the render width and pad lines with literal spaces,
 * so every visual row is a separate buffer line (isWrapped=false). xterm's
 * getSelection() and link detection only re-join rows xterm soft-wrapped
 * itself, which makes copied paragraphs break mid-sentence (with trailing
 * padding + indents) and splits wrapped URLs/paths into dead fragments. Upstream:
 * anthropics/claude-code#48037/#18170/#25861, wavetermdev/waveterm#3288.
 *
 * The core heuristic is the word-wrap invariant: a wrapper only breaks a line
 * when the next word would not fit. So row i was wrapped onto row i+1 iff
 *   width(trimEnd(row_i)) + 1 + width(firstToken(row_i+1)) > cols
 * or row i is cut flush at exactly `cols` (mid-word/URL/CJK cut). Everything
 * here is pure and unit-tested.
 */
import { findLinks, type LinkMatch } from "./terminalLinks";

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

// ── Hard-wrapped link joining (for the terminal link provider) ─────────────

/** A continuation row's first token must be pure URL/path-body characters. */
const LINK_BODY_TOKEN_RE = /^[\p{L}\p{N}\-._~:/?#[\]@!$&'()*+,;=%\\]+$/u;
/** Max continuation rows to absorb — bounds work and false-positive damage. */
const MAX_CONTINUATION_ROWS = 4;
/** A row that starts like a fresh link (`~/`, `./`, `C:\`, `scheme://`) is a new entry, not a continuation. */
const NEW_LINK_START_RE = /^(~\/|\.{1,2}\/|[A-Za-z]:[\\/]|[a-z][\w+.-]*:\/\/)/i;
/** The previous row's token already ends like a whole file name. */
const COMPLETE_FILE_END_RE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Whether `token` on the next row continues the link at the end of `prevToken`.
 * Without these checks a narrow pane listing paths (`rg -l`, `find`) passes
 * the word-wrap length rule and fuses separate entries into one bad link. A
 * leading `/` only continues on a flush cut — TUIs may break right before it.
 */
function continuesLink(prevToken: string, token: string, flush: boolean): boolean {
  if (NEW_LINK_START_RE.test(token)) return false;
  if (token.startsWith("/") && !flush) return false;
  if (COMPLETE_FILE_END_RE.test(prevToken) && !/^[?#&]/.test(token)) return false;
  return true;
}

export interface WrappedLinkMatch {
  /** The reconstructed link; its offsets index the joined text. */
  link: LinkMatch;
  /** Physical rows the link spans, counting the origin row (always ≥ 2). */
  rowSpan: number;
  /** 0-based string offset of the link start within rows[0]. */
  startCol: number;
  /** 0-based EXCLUSIVE string offset of the link end within the last row. */
  endColLast: number;
}

/**
 * Reconstruct a URL or file path that a TUI hard-wrapped across physical rows.
 * `rows[0]` is the row where the link starts; later entries are the following
 * physical rows. A row is absorbed only when the link runs to the end of the
 * current row AND the wrap invariant (or a flush cut) says the break was
 * forced AND the next row's first token is pure link-body charset — so a
 * complete link followed by prose never extends. Returns null unless the
 * final link really spans more than one row (single rows are findLinks' job).
 */
export function joinHardWrappedLink(rows: string[], cols: number): WrappedLinkMatch | null {
  if (rows.length < 2 || !cols) return null;
  const row0 = rows[0].replace(/\s+$/, "");
  const lastToken = /\S+$/.exec(row0)?.[0] ?? "";
  if (!/[/\\]/.test(lastToken)) return null; // URLs and paths both contain a separator

  let joined = row0;
  const rowStarts = [0];
  const indents = [0];
  let prev = row0;
  for (let i = 1; i < rows.length && i <= MAX_CONTINUATION_ROWS; i++) {
    const next = rows[i];
    const nextTrimmed = next.replace(/\s+$/, "");
    const indent = next.length - next.replace(/^\s+/, "").length;
    const token = nextTrimmed.replace(/^\s+/, "").split(/\s+/)[0] ?? "";
    if (!token || !LINK_BODY_TOKEN_RE.test(token)) break;
    const flush = isFlushCut(prev, cols);
    if (!flush && !wrapInvariant(prev, next, cols)) break;
    if (!continuesLink(/\S+$/.exec(prev)?.[0] ?? "", token, flush)) break;
    rowStarts.push(joined.length);
    indents.push(indent);
    joined += token;
    // Prose after the token means the link ended on this row.
    if (indent + token.length !== nextTrimmed.length) break;
    prev = nextTrimmed;
  }
  if (rowStarts.length < 2) return null;

  const link = findLinks(joined).find((l) => l.start < row0.length && l.end > row0.length);
  if (!link) return null;
  let lastRow = rowStarts.length - 1;
  while (lastRow > 0 && rowStarts[lastRow] >= link.end) lastRow--;
  return {
    link,
    rowSpan: lastRow + 1,
    startCol: link.start,
    endColLast: indents[lastRow] + (link.end - rowStarts[lastRow]),
  };
}
