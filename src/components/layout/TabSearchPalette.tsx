import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useLayout } from "../../contexts/LayoutContext";
import { useTheme } from "../../contexts/ThemeContext";
import { getTheme } from "../../utils/theme";
import {
  filterTabsAnnotated,
  getTabContext,
  extractContextSnippet,
} from "../../utils/tabSwitcher";
import { readScreenBuffer } from "../../services/terminalBuffer";

/**
 * Floating palette for quick tab navigation. Matches by tab title first,
 * then falls back to per-tab context (session titles, cwd, recent agent
 * interactions, terminal scrollback) — useful when tabs aren't named well
 * but you remember what you ran or asked. Context is gathered once when
 * the palette opens to keep keystrokes instant.
 *
 * Hotkey "tron:openTabSearch" event opens it. Type to filter, Left/Right
 * (or Up/Down) to move, Enter to activate, Esc or click-outside to close.
 */
const TabSearchPalette: React.FC = () => {
  const { tabs, sessions, selectTab } = useLayout();
  const { resolvedTheme } = useTheme();
  const t = getTheme(resolvedTheme);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusRafRef = useRef<number | null>(null);

  // Per-tab context, built once each time the palette opens. Snapshotting
  // here (rather than on every keystroke) keeps filtering O(query.len * sum
  // of context bytes) per keystroke without re-walking layouts or hitting
  // the xterm buffer reader more than once. ~5–15ms typical, even for
  // 20 tabs with splits.
  const [contextMap, setContextMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const focusInputSoon = () => {
      if (focusRafRef.current !== null) cancelAnimationFrame(focusRafRef.current);
      focusRafRef.current = requestAnimationFrame(() => {
        focusRafRef.current = null;
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    const onOpen = () => {
      setQuery("");
      setHighlight(0);
      const next = new Map<string, string>();
      const reader = (sid: string, lines?: number) =>
        readScreenBuffer(sid, lines ?? 200);
      for (const tab of tabs) {
        next.set(tab.id, getTabContext(tab, sessions, reader));
      }
      setContextMap(next);
      setOpen(true);
      // Always re-focus on the open event — handles re-firing while open
      // (state setters above are no-ops when palette was already open).
      focusInputSoon();
    };
    window.addEventListener("tron:openTabSearch", onOpen);
    return () => {
      window.removeEventListener("tron:openTabSearch", onOpen);
      if (focusRafRef.current !== null) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = null;
      }
    };
  }, [tabs, sessions]);

  const filtered = useMemo(
    () => filterTabsAnnotated(tabs, query, { contextMap }),
    [tabs, query, contextMap],
  );

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered.length, highlight]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const pill = listRef.current.querySelector<HTMLButtonElement>(
      `[data-tab-idx="${highlight}"]`,
    );
    pill?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [highlight, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    // Drop the snapshot so we don't hold scrollback strings between sessions.
    setContextMap(new Map());
  };

  const confirm = (tabId?: string) => {
    const target = tabId ?? filtered[highlight]?.tab.id;
    if (target) selectTab(target);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered.length > 0) confirm();
      return;
    }
    if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown"
    ) {
      e.preventDefault();
      if (filtered.length === 0) return;
      const dir =
        e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      setHighlight((h) => (h + dir + filtered.length) % filtered.length);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="tab-search-backdrop"
          className="fixed inset-0 z-[100] flex items-start justify-center pt-14"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
          data-testid="tab-search-backdrop"
        >
          <motion.div
            key="tab-search-panel"
            className={`w-[520px] max-w-[90vw] rounded-2xl border shadow-2xl ${t.surfaceOverlay} ${t.border}`}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            role="dialog"
            aria-label="Tab search"
            data-testid="tab-search-palette"
          >
            <div className={`px-3 py-2.5 border-b ${t.borderSubtle}`}>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={`Search tabs (${tabs.length})…`}
                spellCheck={false}
                autoComplete="off"
                className={`w-full bg-transparent outline-none text-sm ${t.text} placeholder:${t.textFaint}`}
                data-testid="tab-search-input"
              />
            </div>
            <div
              ref={listRef}
              className="max-h-64 overflow-y-auto p-2"
              data-testid="tab-search-results"
            >
              {filtered.length === 0 ? (
                <div className={`px-2 py-3 text-xs ${t.textFaint}`}>
                  No tabs match "{query}"
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {filtered.map(({ tab, matchSource }, i) => {
                    const isActive = i === highlight;
                    const dot = tab.color
                      ? { backgroundColor: tab.color }
                      : undefined;
                    const snippet =
                      matchSource === "context" && query.trim()
                        ? extractContextSnippet(
                            contextMap.get(tab.id) || "",
                            query.trim(),
                            { window: 70 },
                          )
                        : null;
                    return (
                      <button
                        key={tab.id}
                        data-tab-idx={i}
                        onMouseMove={() => {
                          if (highlight !== i) setHighlight(i);
                        }}
                        onClick={() => confirm(tab.id)}
                        className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                          isActive
                            ? `${t.surfaceActive} ${t.text}`
                            : `${t.textMuted} ${t.surfaceHover}`
                        }`}
                      >
                        {tab.color && (
                          <span
                            className="w-2 h-2 rounded-full shrink-0 mt-1.5"
                            style={dot}
                          />
                        )}
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate flex-1">
                              {matchSource === "title"
                                ? renderHighlighted(tab.title, query)
                                : tab.title}
                            </span>
                            {matchSource === "context" && (
                              <span
                                className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${t.borderSubtle} border ${t.textFaint} shrink-0`}
                                title="Match from terminal / agent context"
                              >
                                ctx
                              </span>
                            )}
                            <span className={`text-[10px] ${t.textFaint} shrink-0`}>
                              {i + 1}
                            </span>
                          </span>
                          {snippet && (
                            <span
                              className={`block truncate font-mono text-[11px] mt-0.5 ${t.textFaint}`}
                            >
                              {renderHighlighted(snippet.prefix, query)}
                              <span
                                className="font-semibold"
                                style={{ color: "var(--brand-accent, #a855f7)" }}
                              >
                                {snippet.match}
                              </span>
                              {renderHighlighted(snippet.suffix, query)}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div
              className={`px-3 py-1.5 border-t ${t.borderSubtle} flex items-center justify-between text-[10px] ${t.textFaint}`}
            >
              <span>← → move · Enter open · Esc close</span>
              <span>{filtered.length} / {tabs.length}</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

/** Highlight every occurrence of `query` inside `text`, case-insensitive. */
function renderHighlighted(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(ql, cursor);
    if (idx < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <span
        key={`m${key++}`}
        className="font-semibold"
        style={{ color: "var(--brand-accent, #a855f7)" }}
      >
        {text.slice(idx, idx + q.length)}
      </span>,
    );
    cursor = idx + q.length;
  }
  return <>{parts}</>;
}

export default TabSearchPalette;
