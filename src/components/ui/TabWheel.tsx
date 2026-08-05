import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import type { Tab } from "../../types";
import { wheelSectorIndex, sectorPath, polarPoint, comboKeyReleased } from "../../utils/tabWheel";
import { ease } from "../../utils/motion";

/** Mouse must move this far from the center before direction picks a sector. */
const DEADZONE = 24;
/** Hairline gap between sectors, degrees per side. */
const GAP_DEG = 0.8;

interface TabWheelProps {
  tabs: Tab[];
  currentTabId: string;
  /** The hold-combo that opened the wheel — releasing any of its keys commits. */
  combo: string;
  resolvedTheme: string;
  /** Called exactly once: with the picked tab id, or null on cancel. */
  onCommit: (tabId: string | null) => void;
}

/**
 * Game-style radial tab switcher: hold the hotkey to show, point the mouse in
 * a direction to pick (pure angle — no need to reach the sector), release to
 * jump. Click a sector to commit immediately; Esc or backdrop click cancels.
 */
export function TabWheel({ tabs, currentTabId, combo, resolvedTheme, onCommit }: TabWheelProps) {
  const isLight = resolvedTheme === "light";
  const count = tabs.length;
  const [selected, setSelected] = useState(() =>
    Math.max(0, tabs.findIndex((t) => t.id === currentTabId)),
  );
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const committedRef = useRef(false);

  const outerR = Math.min(215, Math.floor(window.innerHeight * 0.3));
  const innerR = Math.floor(outerR * 0.44);
  const size = outerR * 2 + 12;
  const c = size / 2;
  const step = 360 / count;

  useEffect(() => {
    const commit = (tabId: string | null) => {
      if (committedRef.current) return;
      committedRef.current = true;
      onCommit(tabId);
    };
    const onMove = (e: MouseEvent) => {
      const idx = wheelSectorIndex(
        e.clientX - window.innerWidth / 2,
        e.clientY - window.innerHeight / 2,
        count,
        DEADZONE,
      );
      if (idx != null) setSelected(idx);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (comboKeyReleased(e, combo)) {
        e.preventDefault();
        commit(tabs[selectedRef.current]?.id ?? null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commit(null);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [combo, count, tabs, onCommit]);

  const selectedTab = tabs[selected];

  return (
    <div
      className={`fixed inset-0 z-[300] flex items-center justify-center ${isLight ? "bg-black/30" : "bg-black/50"}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCommit(null); }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={ease}
        className="relative select-none"
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} className="block">
          {tabs.map((tab, i) => {
            const mid = i * step;
            const start = mid - step / 2 + GAP_DEG;
            const end = mid + step / 2 - GAP_DEG;
            const isSelected = i === selected;
            const label = polarPoint(c, c, (innerR + outerR) / 2, mid);
            const title = tab.title.length > 14 ? `${tab.title.slice(0, 13)}…` : tab.title;
            return (
              <g key={tab.id} onMouseDown={() => onCommit(tab.id)} className="cursor-pointer">
                <path
                  d={sectorPath(c, c, innerR, outerR, start, end)}
                  fill={isSelected
                    ? "rgba(59, 130, 246, 0.9)"
                    : isLight ? "rgba(255, 255, 255, 0.95)" : "rgba(28, 28, 30, 0.92)"}
                  stroke={isLight ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.1)"}
                  strokeWidth={1}
                />
                {tab.color && (
                  <circle cx={label.x} cy={label.y - 13} r={3} fill={tab.color} />
                )}
                <text
                  x={label.x}
                  y={label.y + 5}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={isSelected ? 600 : 400}
                  fill={isSelected ? "#fff" : isLight ? "#374151" : "#d1d5db"}
                >
                  {title}
                </text>
                {tab.id === currentTabId && (
                  <circle cx={label.x} cy={label.y + 16} r={2} fill={isSelected ? "#fff" : "#3b82f6"} />
                )}
              </g>
            );
          })}
          {/* Center hub — shows the landing tab */}
          <circle
            cx={c} cy={c} r={innerR - 8}
            fill={isLight ? "rgba(255,255,255,0.97)" : "rgba(18, 18, 20, 0.95)"}
            stroke={isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.1)"}
          />
          <text
            x={c} y={c - 2} textAnchor="middle" fontSize={14} fontWeight={600}
            fill={isLight ? "#111827" : "#f3f4f6"}
          >
            {selectedTab && selectedTab.title.length > 16
              ? `${selectedTab.title.slice(0, 15)}…`
              : selectedTab?.title || ""}
          </text>
          <text
            x={c} y={c + 18} textAnchor="middle" fontSize={11}
            fill={isLight ? "#9ca3af" : "#6b7280"}
          >
            release to switch
          </text>
        </svg>
      </motion.div>
    </div>
  );
}
