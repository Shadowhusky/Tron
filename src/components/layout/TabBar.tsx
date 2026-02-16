import { useState, useRef } from "react";
import type { Tab } from "../../types";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import { themeClass } from "../../utils/theme";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  resolvedTheme: ResolvedTheme;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onOpenSettings: () => void;
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
}) => {
  const dragTabRef = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  return (
    <div
      className={`flex items-center h-10 px-2 gap-2 border-b select-none shrink-0 ${themeClass(
        resolvedTheme,
        {
          dark: "bg-gray-900/50 border-white/5",
          modern:
            "bg-white/[0.03] border-white/[0.08] backdrop-blur-2xl shadow-[0_1px_0_rgba(168,85,247,0.08),inset_0_1px_0_rgba(255,255,255,0.05)]",
          light: "bg-white border-gray-200",
        },
      )}`}
      style={{ WebkitAppRegion: "drag" } as any}
    >
      {/* Traffic Lights Spacer (Mac) */}
      <div className="w-16" />

      {/* Tabs */}
      <div
        className="flex items-center gap-1 flex-1 overflow-x-auto no-scrollbar"
        style={{ WebkitAppRegion: "drag" } as any}
      >
        {tabs.map((tab, tabIndex) => {
          const showLeft =
            dragOverIndex === tabIndex &&
            draggingIndex !== null &&
            draggingIndex > tabIndex;
          const showRight =
            dragOverIndex === tabIndex &&
            draggingIndex !== null &&
            draggingIndex < tabIndex;
          return (
            <div key={tab.id} className="relative flex items-center">
              {/* Drop indicator — left (dragging leftward) */}
              {showLeft && (
                <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-purple-500 z-20 -translate-x-0.5" />
              )}
              <div
                onClick={() => onSelect(tab.id)}
                draggable
                onDragStart={(e) => {
                  dragTabRef.current = tabIndex;
                  setDraggingIndex(tabIndex);
                  e.dataTransfer.effectAllowed = "move";
                  const ghost = e.currentTarget.cloneNode(true) as HTMLElement;
                  ghost.style.position = "absolute";
                  ghost.style.top = "-1000px";
                  ghost.style.opacity = "0.85";
                  ghost.style.transform = "scale(0.95)";
                  ghost.style.borderRadius = "6px";
                  ghost.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
                  ghost.style.background =
                    resolvedTheme === "light" ? "#fff" : "#1a1a2e";
                  ghost.style.border = "1px solid rgba(168,85,247,0.4)";
                  ghost.style.pointerEvents = "none";
                  document.body.appendChild(ghost);
                  e.dataTransfer.setDragImage(
                    ghost,
                    ghost.offsetWidth / 2,
                    ghost.offsetHeight / 2,
                  );
                  requestAnimationFrame(() => document.body.removeChild(ghost));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverIndex(tabIndex);
                }}
                onDragLeave={() => {
                  setDragOverIndex((prev) =>
                    prev === tabIndex ? null : prev,
                  );
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (
                    dragTabRef.current !== null &&
                    dragTabRef.current !== tabIndex
                  ) {
                    onReorder(dragTabRef.current, tabIndex);
                  }
                  dragTabRef.current = null;
                  setDraggingIndex(null);
                  setDragOverIndex(null);
                }}
                onDragEnd={() => {
                  dragTabRef.current = null;
                  setDraggingIndex(null);
                  setDragOverIndex(null);
                }}
                style={{ WebkitAppRegion: "no-drag" } as any}
                className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-md text-xs cursor-grab active:cursor-grabbing transition-all border max-w-[200px] min-w-[100px] ${
                  draggingIndex === tabIndex ? "opacity-30 scale-95" : ""
                } ${
                  tab.id === activeTabId
                    ? themeClass(resolvedTheme, {
                        dark: "bg-gray-800 text-white border-white/10 shadow-sm",
                        modern:
                          "bg-white/[0.08] text-white border-white/[0.12] shadow-[0_0_15px_rgba(168,85,247,0.12)] backdrop-blur-xl",
                        light:
                          "bg-white text-gray-900 border-gray-300 shadow-sm",
                      })
                    : resolvedTheme === "light"
                      ? "border-transparent hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                      : "border-transparent hover:bg-white/5 text-gray-500 hover:text-gray-300"
                }`}
              >
                <span className="truncate flex-1">{tab.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      tab.title === "Settings" ||
                      window.confirm(
                        "Are you sure you want to close this session?",
                      )
                    ) {
                      onClose(tab.id);
                    }
                  }}
                  className={`opacity-0 group-hover:opacity-100 p-0.5 rounded-sm hover:bg-white/20 transition-opacity ${tab.id === activeTabId ? "opacity-100" : ""}`}
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
              </div>
              {/* Drop indicator — right (dragging rightward) */}
              {showRight && (
                <div className="absolute right-0 top-1 bottom-1 w-0.5 rounded-full bg-purple-500 z-20 translate-x-0.5" />
              )}
            </div>
          );
        })}
        <button
          onClick={onCreate}
          style={{ WebkitAppRegion: "no-drag" } as any}
          className="p-1.5 rounded-md hover:bg-white/10 text-gray-500 transition-colors"
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
        </button>
      </div>

      {/* Settings Button */}
      <button
        onClick={onOpenSettings}
        className={`p-2 rounded-md transition-colors ${themeClass(resolvedTheme, {
          dark: "hover:bg-white/10 text-gray-500",
          modern: "hover:bg-white/20 text-purple-300",
          light: "hover:bg-gray-100 text-gray-500",
        })}`}
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
    </div>
  );
};

export default TabBar;
