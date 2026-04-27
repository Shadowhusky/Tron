import type { Tab, TerminalSession, LayoutNode } from "../types";

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

// ---------------------------------------------------------------------------
// Context extraction — searchable text gathered from a tab's sessions
// ---------------------------------------------------------------------------

const MAX_INTERACTIONS_PER_SESSION = 8;
const DEFAULT_SCROLLBACK_LINES = 200;

/**
 * Reader that returns the most recent N rendered (no-ANSI) lines of a
 * session's terminal scrollback, or null if none is available. The
 * production implementation is `readScreenBuffer` from terminalBuffer.ts;
 * tests pass a stub.
 */
export type ScrollbackReader = (sessionId: string, lines?: number) => string | null;

/**
 * Gather all searchable text for a tab into one string. Walks the layout
 * tree so split-pane tabs include every leaf's context. Cheap: all data
 * is in renderer state or comes from the synchronous xterm buffer reader.
 *
 * Includes (per session in the tab):
 *  - session.title (skipped if it's still the default "Terminal")
 *  - session.cwd
 *  - last N agent/user interactions (capped to {@link MAX_INTERACTIONS_PER_SESSION})
 *  - last N lines of terminal scrollback via the provided reader
 */
export function getTabContext(
  tab: Tab,
  sessions: Map<string, TerminalSession>,
  readScrollback: ScrollbackReader,
  opts: { scrollbackLines?: number; maxInteractions?: number } = {},
): string {
  const lines: string[] = [];
  const scrollLines = opts.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
  const maxInteractions = opts.maxInteractions ?? MAX_INTERACTIONS_PER_SESSION;

  const walk = (node: LayoutNode): void => {
    if (node.type === "leaf") {
      // Skip non-PTY leaves (settings, browser, editor, ssh-connect)
      if (node.contentType && node.contentType !== "terminal") return;
      const sid = node.sessionId;
      if (!sid) return;
      const s = sessions.get(sid);
      if (s) {
        if (s.title && s.title !== "Terminal") lines.push(s.title);
        if (s.cwd) lines.push(s.cwd);
        if (s.interactions && s.interactions.length > 0) {
          const recent = s.interactions.slice(-maxInteractions);
          for (const it of recent) {
            if (it.content) lines.push(it.content);
          }
        }
      }
      const buf = readScrollback(sid, scrollLines);
      if (buf) lines.push(buf);
    } else {
      for (const child of node.children) walk(child);
    }
  };

  walk(tab.root);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Filtering & ranking
// ---------------------------------------------------------------------------

const SCORE_TITLE_PREFIX = 30;
const SCORE_TITLE_WORD_START = 20;
const SCORE_TITLE_SUBSTRING = 10;
const SCORE_CONTEXT_MATCH = 5;

/**
 * Filter + rank tabs by query. Titles win over context. Title scoring:
 * prefix > word-start > substring; within a band, shorter titles win;
 * stable on ties.
 *
 * When `opts.contextMap` is supplied, tabs whose title doesn't match are
 * rescued if the query appears anywhere in their context — preserving
 * input order across context-only matches.
 *
 * Word boundaries: whitespace, '-', '_', '.', '/'.
 *
 * Returns a new array; empty/whitespace query returns all tabs unchanged.
 */
export function filterTabs(
  tabs: Tab[],
  query: string,
  opts: { contextMap?: Map<string, string> } = {},
): Tab[] {
  const q = query.trim().toLowerCase();
  if (!q) return tabs.slice();

  const WORD_BOUNDARY = /[\s\-_./]/;
  const contextMap = opts.contextMap;

  const scored = tabs
    .map((tab, idx) => {
      const title = (tab.title || "").toLowerCase();
      let score = 0;
      let matchSource: "title" | "context" | null = null;

      if (title.includes(q)) {
        matchSource = "title";
        if (title.startsWith(q)) {
          score = SCORE_TITLE_PREFIX;
        } else {
          const pos = title.indexOf(q);
          if (pos > 0 && WORD_BOUNDARY.test(title[pos - 1])) {
            score = SCORE_TITLE_WORD_START;
          } else {
            score = SCORE_TITLE_SUBSTRING;
          }
        }
      } else if (contextMap) {
        const ctx = contextMap.get(tab.id);
        if (ctx && ctx.toLowerCase().includes(q)) {
          score = SCORE_CONTEXT_MATCH;
          matchSource = "context";
        }
      }

      if (score === 0) return null;
      return { tab, idx, score, len: title.length, matchSource };
    })
    .filter(
      (
        x,
      ): x is {
        tab: Tab;
        idx: number;
        score: number;
        len: number;
        matchSource: "title" | "context";
      } => x !== null,
    );

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // Length tiebreaker only makes sense for title matches — context
    // matches care about input order, not title length.
    if (a.matchSource === "title" && b.matchSource === "title" && a.len !== b.len) {
      return a.len - b.len;
    }
    return a.idx - b.idx;
  });

  return scored.map((s) => s.tab);
}

// ---------------------------------------------------------------------------
// Snippet extraction — concise preview of where a query matched
// ---------------------------------------------------------------------------

export interface ContextSnippet {
  /** Whitespace-collapsed text BEFORE the match (may include leading "…"). */
  prefix: string;
  /** The matched substring, original casing preserved. */
  match: string;
  /** Whitespace-collapsed text AFTER the match (may include trailing "…"). */
  suffix: string;
  /** True if the prefix was truncated and starts with "…". */
  prefixTruncated: boolean;
  /** True if the suffix was truncated and ends with "…". */
  suffixTruncated: boolean;
}

/**
 * Locate a query inside `text` and return a short, human-readable preview
 * centred on the match. Collapses runs of whitespace and newlines so the
 * snippet renders as a single line.
 *
 * @param text  source text (e.g. tab context)
 * @param query the substring to highlight; case-insensitive locate, but
 *              the original casing of the matched span is preserved
 * @param opts.window  total character budget for the prefix + match + suffix
 *                     (excluding ellipses). Default 80.
 *
 * Returns `null` if `text` or `query` is empty, or if the query isn't found.
 */
export function extractContextSnippet(
  text: string,
  query: string,
  opts: { window?: number } = {},
): ContextSnippet | null {
  if (!text || !query) return null;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return null;

  const window = opts.window ?? 80;
  const matchEnd = idx + query.length;
  // Keep room for the match itself plus ~equal padding on either side.
  const pad = Math.max(0, Math.floor((window - query.length) / 2));

  let prefixStart = Math.max(0, idx - pad);
  let suffixEnd = Math.min(text.length, matchEnd + pad);

  const prefixTruncated = prefixStart > 0;
  const suffixTruncated = suffixEnd < text.length;

  // Try to start the prefix at a word boundary so we don't slice mid-word.
  if (prefixTruncated) {
    const slice = text.slice(prefixStart, idx);
    const ws = slice.search(/\S/); // first non-whitespace
    if (ws > 0) prefixStart += ws;
    // If we landed mid-word, walk forward to the next whitespace
    const beforeChar = text[prefixStart - 1];
    if (beforeChar && /\S/.test(beforeChar)) {
      const fwd = text.slice(prefixStart, idx).search(/\s/);
      if (fwd >= 0 && fwd < pad / 2) prefixStart += fwd + 1;
    }
  }
  if (suffixTruncated) {
    const slice = text.slice(matchEnd, suffixEnd);
    const back = slice.search(/\s\S*$/);
    if (back > 0) suffixEnd = matchEnd + back;
  }

  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

  const rawPrefix = text.slice(prefixStart, idx);
  const rawSuffix = text.slice(matchEnd, suffixEnd);
  const matchText = text.slice(idx, matchEnd);

  let prefix = collapse(rawPrefix);
  let suffix = collapse(rawSuffix);
  // Preserve a single space between prefix/match and match/suffix when the
  // raw text had any whitespace there (so the rendered snippet isn't glued).
  if (rawPrefix.length > 0 && /\s$/.test(rawPrefix) && prefix.length > 0) {
    prefix = prefix + " ";
  }
  if (rawSuffix.length > 0 && /^\s/.test(rawSuffix) && suffix.length > 0) {
    suffix = " " + suffix;
  }

  if (prefixTruncated && prefix.length > 0) prefix = "…" + prefix;
  if (suffixTruncated && suffix.length > 0) suffix = suffix + "…";

  return { prefix, match: matchText, suffix, prefixTruncated, suffixTruncated };
}

/**
 * Like {@link filterTabs} but also returns the match source per tab, so
 * callers can render a small "context" badge on context-only matches.
 */
export function filterTabsAnnotated(
  tabs: Tab[],
  query: string,
  opts: { contextMap?: Map<string, string> } = {},
): Array<{ tab: Tab; matchSource: "title" | "context" }> {
  const q = query.trim().toLowerCase();
  if (!q) return tabs.map((tab) => ({ tab, matchSource: "title" as const }));

  const WORD_BOUNDARY = /[\s\-_./]/;
  const contextMap = opts.contextMap;

  const scored = tabs
    .map((tab, idx) => {
      const title = (tab.title || "").toLowerCase();
      let score = 0;
      let matchSource: "title" | "context" | null = null;

      if (title.includes(q)) {
        matchSource = "title";
        if (title.startsWith(q)) score = SCORE_TITLE_PREFIX;
        else {
          const pos = title.indexOf(q);
          score =
            pos > 0 && WORD_BOUNDARY.test(title[pos - 1])
              ? SCORE_TITLE_WORD_START
              : SCORE_TITLE_SUBSTRING;
        }
      } else if (contextMap) {
        const ctx = contextMap.get(tab.id);
        if (ctx && ctx.toLowerCase().includes(q)) {
          score = SCORE_CONTEXT_MATCH;
          matchSource = "context";
        }
      }

      if (score === 0 || matchSource === null) return null;
      return { tab, idx, score, len: title.length, matchSource };
    })
    .filter(
      (
        x,
      ): x is {
        tab: Tab;
        idx: number;
        score: number;
        len: number;
        matchSource: "title" | "context";
      } => x !== null,
    );

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.matchSource === "title" && b.matchSource === "title" && a.len !== b.len) {
      return a.len - b.len;
    }
    return a.idx - b.idx;
  });

  return scored.map((s) => ({ tab: s.tab, matchSource: s.matchSource }));
}
