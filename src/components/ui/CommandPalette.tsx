import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { themeClass } from "../../utils/theme";
import { fuzzyFilter } from "../../utils/fuzzy";

export interface PaletteAction {
  id: string;
  /** Display label — also the fuzzy-match target. */
  label: string;
  /** Optional right-aligned hint (hotkey or category). */
  hint?: string;
  /** Section header shown when unfiltered. */
  section?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
  /** Pre-filled filter query (e.g. "split with" for the Split With… picker). */
  initialQuery?: string;
}

/**
 * Cmd-P command palette: fuzzy action launcher (Warp / VS Code pattern).
 * Keyboard-first: type to filter, ↑↓ to move, ⏎ to run, Esc to close.
 */
const CommandPalette: React.FC<CommandPaletteProps> = ({ open, actions, onClose, initialQuery }) => {
  const { resolvedTheme } = useTheme();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => fuzzyFilter(query, actions, (a) => a.label),
    [query, actions],
  );

  // State is reset by remounting: the caller keys this component on `open`
  // (see App), so each open starts with a fresh query/selection.
  useEffect(() => {
    if (open) {
      // Focus after the entrance frame so the browser doesn't scroll-jump.
      // Select any pre-filled query so typing replaces it.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open]);

  // Keep the selected row in view while arrowing.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (a: PaletteAction | undefined) => {
    if (!a) return;
    onClose();
    // Run after close so actions that move focus (splits, tabs) win.
    setTimeout(() => a.run(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(filtered[index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[200] flex items-start justify-center bg-black/40 pt-[18vh]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ type: "spring", bounce: 0, duration: 0.25 }}
            style={{ transformOrigin: "top center" }}
            className={`w-[560px] max-w-[90vw] overflow-hidden rounded-xl border shadow-2xl ${themeClass(
              resolvedTheme,
              {
                dark: "border-white/10 bg-[#1c1c1e] text-gray-100",
                modern: "border-white/[0.15] bg-[#141a2a] text-white",
                light: "border-gray-200 bg-white text-gray-900",
              },
            )}`}
          >
            <div className={`flex items-center gap-2 border-b px-4 py-3 ${
              resolvedTheme === "light" ? "border-gray-100" : "border-white/[0.06]"
            }`}>
              <Search className="h-4 w-4 opacity-40" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
                onKeyDown={onKeyDown}
                placeholder="Type a command…"
                spellCheck={false}
                className="w-full bg-transparent text-[15px] outline-none placeholder:opacity-40"
              />
            </div>
            <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1.5">
              {filtered.length === 0 && (
                <div className="px-4 py-6 text-center text-sm opacity-40">No matching commands</div>
              )}
              {filtered.map((a, i) => {
                const showSection =
                  !query && a.section && (i === 0 || filtered[i - 1].section !== a.section);
                return (
                  <div key={a.id}>
                    {showSection && (
                      <div className="px-4 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide opacity-35">
                        {a.section}
                      </div>
                    )}
                    <button
                      data-idx={i}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => run(a)}
                      className={`flex w-full items-center justify-between px-4 py-2 text-left text-[13px] transition-colors ${
                        i === index
                          ? resolvedTheme === "light"
                            ? "bg-gray-100"
                            : "bg-white/[0.08]"
                          : ""
                      }`}
                    >
                      <span className="truncate">{a.label}</span>
                      {a.hint && (
                        <span className="ml-4 shrink-0 text-[11px] opacity-40">{a.hint}</span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default CommandPalette;
