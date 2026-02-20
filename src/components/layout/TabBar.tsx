import { useState, useEffect, useRef } from "react";
import { Reorder, AnimatePresence, motion } from "framer-motion";
import type { Tab } from "../../types";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import { themeClass } from "../../utils/theme";
import { isWindows } from "../../utils/platform";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  resolvedTheme: ResolvedTheme;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onOpenSettings: () => void;
  isTabDirty?: (tabId: string) => boolean;
}

const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  resolvedTheme,
  onSelect,
  onClose,
  onCreate,
  onReorder,
  onOpenSettings,
  isTabDirty,
}) => {
  // Local visual order — avoids propagating every drag frame to parent
  const [localTabs, setLocalTabs] = useState(tabs);
  const isDraggingRef = useRef(false);

  // Sync from parent when not dragging
  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalTabs(tabs);
    }
  }, [tabs]);

  const commitReorder = () => {
    isDraggingRef.current = false;
    const oldIds = tabs.map((t) => t.id);
    const newIds = localTabs.map((t) => t.id);
    for (let i = 0; i < oldIds.length; i++) {
      if (oldIds[i] !== newIds[i]) {
        const movedId = newIds[i];
        const fromIndex = oldIds.indexOf(movedId);
        onReorder(fromIndex, i);
        break;
      }
    }
  };

  return (
    <div
      data-tutorial="tab-bar"
      className={`flex items-center h-10 px-2 gap-2 border-b select-none shrink-0 ${themeClass(
        resolvedTheme,
        {
          dark: "bg-[#111111] border-white/5",
          modern: "bg-white/[0.02] border-white/[0.06] backdrop-blur-2xl",
          light: "bg-gray-100 border-gray-200",
        },
      )}`}
      style={{ WebkitAppRegion: "drag" } as any}
    >
      {/* Traffic Lights Spacer (Mac only) */}
      {!isWindows() && <div className="w-16" />}

      {/* Tabs */}
      <Reorder.Group
        as="div"
        axis="x"
        values={localTabs}
        onReorder={(newTabs) => {
          isDraggingRef.current = true;
          setLocalTabs(newTabs);
        }}
        className="flex items-center gap-1 flex-1 overflow-x-auto no-scrollbar"
        style={{ WebkitAppRegion: "drag" } as any}
      >
        <AnimatePresence initial={false}>
          {localTabs.map((tab) => (
            <Reorder.Item
              key={tab.id}
              value={tab}
              drag="x"
              dragConstraints={{ top: 0, bottom: 0 }}
              initial={{ opacity: 0, scale: 0.9, width: 0 }}
              animate={{ opacity: 1, scale: 1, width: "auto" }}
              exit={{ opacity: 0, scale: 0.9, width: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              onDragEnd={commitReorder}
              whileDrag={{
                scale: 1.03,
                boxShadow:
                  resolvedTheme === "light"
                    ? "0 4px 16px rgba(0,0,0,0.12)"
                    : "0 4px 16px rgba(0,0,0,0.4)",
                zIndex: 50,
                cursor: "grabbing",
              }}
              style={{ WebkitAppRegion: "no-drag" } as any}
              className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-md text-xs cursor-grab active:cursor-grabbing transition-colors border max-w-[200px] min-w-[100px] ${
                tab.id === activeTabId
                  ? themeClass(resolvedTheme, {
                      dark: "bg-[#1e1e1e] text-white border-white/10",
                      modern:
                        "bg-white/[0.06] text-white border-white/[0.1] backdrop-blur-xl",
                      light: "bg-white text-gray-900 border-gray-300 shadow-sm",
                    })
                  : themeClass(resolvedTheme, {
                      dark: "bg-[#161616] border-white/5 hover:bg-[#1a1a1a] text-gray-500 hover:text-gray-300",
                      modern:
                        "border-transparent hover:bg-white/5 text-gray-500 hover:text-gray-300",
                      light:
                        "bg-gray-100/80 border-gray-200/60 text-gray-500 hover:bg-gray-200/60 hover:text-gray-700",
                    })
              }`}
              onClick={() => onSelect(tab.id)}
            >
              <span className="truncate flex-1">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const dirty = isTabDirty?.(tab.id) ?? false;
                  if (
                    tab.title === "Settings" ||
                    !dirty ||
                    window.confirm("Close this terminal session?")
                  ) {
                    onClose(tab.id);
                  }
                }}
                className={`opacity-0 group-hover:opacity-100 p-0.5 rounded-sm transition-opacity ${tab.id === activeTabId ? "opacity-100" : ""} ${themeClass(
                  resolvedTheme,
                  {
                    dark: "hover:bg-white/20",
                    modern: "hover:bg-white/20",
                    light: "hover:bg-black/10",
                  },
                )}`}
              >
                <svg
                  className="w-3 h-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </Reorder.Item>
          ))}
        </AnimatePresence>
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={onCreate}
          style={{ WebkitAppRegion: "no-drag" } as any}
          className={`p-1.5 rounded-md transition-colors ${themeClass(
            resolvedTheme,
            {
              dark: "hover:bg-white/10 text-gray-500",
              modern: "hover:bg-white/10 text-gray-500",
              light: "hover:bg-gray-200 text-gray-500",
            },
          )}`}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        </motion.button>
      </Reorder.Group>

      {/* Settings Button */}
      <button
        onClick={onOpenSettings}
        className={`p-2 rounded-md transition-colors ${themeClass(
          resolvedTheme,
          {
            dark: "hover:bg-white/10 text-gray-500",
            modern:
              "hover:bg-white/[0.08] text-purple-300/70 hover:text-purple-200",
            light: "hover:bg-gray-100 text-gray-500",
          },
        )}`}
        title="Settings (Cmd+,)"
        style={{ WebkitAppRegion: "no-drag" } as any}
      >
        <svg
          className="w-5 h-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>

      {/* Windows title bar overlay spacer (min/max/close buttons are on the right) */}
      {isWindows() && <div className="w-36 shrink-0" />}
    </div>
  );
};

export default TabBar;
