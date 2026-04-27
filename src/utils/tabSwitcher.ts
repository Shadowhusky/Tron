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
