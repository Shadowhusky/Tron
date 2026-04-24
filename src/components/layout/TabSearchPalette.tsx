import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useLayout } from "../../contexts/LayoutContext";
import { useTheme } from "../../contexts/ThemeContext";
import { getTheme } from "../../utils/theme";
import { filterTabs } from "../../utils/tabSwitcher";

/**
 * Floating palette for quick tab navigation by fuzzy title search.
 * Opens when the "tron:openTabSearch" custom event fires (dispatched by the
 * configurable `tabSearch` hotkey). Type to filter, Left/Right to move,
 * Enter to activate, Esc or click-outside to close.
 */
const TabSearchPalette: React.FC = () => {
  const { tabs, selectTab } = useLayout();
  const { resolvedTheme } = useTheme();
  const t = getTheme(resolvedTheme);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Open on hotkey event; cleanup stale state when we open again.
  useEffect(() => {
    const onOpen = () => {
      setQuery("");
      setHighlight(0);
      setOpen(true);
    };
    window.addEventListener("tron:openTabSearch", onOpen);
    return () => window.removeEventListener("tron:openTabSearch", onOpen);
  }, []);

  // Focus the input when palette opens.
  useEffect(() => {
    if (open) {
      // Defer so focus lands after the overlay is rendered.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => filterTabs(tabs, query), [tabs, query]);

  // Clamp highlight to valid range whenever results shrink.
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered.length, highlight]);

  // Ensure the highlighted pill stays in view.
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
  };

  const confirm = (tabId?: string) => {
    const target = tabId ?? filtered[highlight]?.id;
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
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlight((h) => (h + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlight((h) => (h + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
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
            // Click outside the panel closes
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
                  {filtered.map((tab, i) => {
                    const isActive = i === highlight;
                    const dot = tab.color
                      ? { backgroundColor: tab.color }
                      : undefined;
                    return (
                      <button
                        key={tab.id}
                        data-tab-idx={i}
                        onMouseEnter={() => setHighlight(i)}
                        onClick={() => confirm(tab.id)}
                        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                          isActive
                            ? `${t.surfaceActive} ${t.text}`
                            : `${t.textMuted} ${t.surfaceHover}`
                        }`}
                      >
                        {tab.color && (
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={dot}
                          />
                        )}
                        <span className="truncate flex-1">{tab.title}</span>
                        <span className={`text-[10px] ${t.textFaint}`}>
                          {i + 1}
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

export default TabSearchPalette;
