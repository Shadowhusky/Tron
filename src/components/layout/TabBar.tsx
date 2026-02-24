import { useState, useEffect, useRef } from "react";
import { Reorder, AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import type { Tab } from "../../types";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import { themeClass } from "../../utils/theme";
import { isWindows, isElectronApp, isTouchDevice } from "../../utils/platform";
import { isSshOnly } from "../../services/mode";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  resolvedTheme: ResolvedTheme;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  onCreateSSH?: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onOpenSettings: () => void;
  isTabDirty?: (tabId: string) => boolean;
  onRenameTab?: (sessionId: string, title: string) => void;
  onUpdateTabColor?: (tabId: string, color?: string) => void;
  onDuplicateTab?: (tabId: string) => Promise<void>;
}

const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  resolvedTheme,
  onSelect,
  onClose,
  onCreate,
  onCreateSSH,
  onReorder,
  onOpenSettings,
  isTabDirty,
  onRenameTab,
  onUpdateTabColor,
  onDuplicateTab,
}) => {
  // Local visual order — avoids propagating every drag frame to parent
  const [localTabs, setLocalTabs] = useState(tabs);
  const isDraggingRef = useRef(false);

  // Long-press for mobile context menu
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const handleTouchStart = (tab: Tab, e: React.TouchEvent) => {
    if (isOnlyConnectTab(tab)) return;
    longPressFired.current = false;
    const touch = e.touches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    longPressTimerRef.current = setTimeout(() => {
      longPressFired.current = true;
      setContextMenu({ tabId: tab.id, x, y });
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleTouchMove = () => {
    // Cancel long-press if finger moves (scrolling)
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);

  // Rename State
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Check if a tab is the sole connect placeholder (no close, no context menu)
  const isOnlyConnectTab = (tab: Tab) =>
    tab.root.type === "leaf" && tab.root.contentType === "ssh-connect" && tabs.length <= 1;

  // Stable ref for Radix Popover virtual anchor (avoids infinite re-render loop)
  const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: 0, y: 0 }),
  });
  if (contextMenu) {
    anchorRef.current = {
      getBoundingClientRect: () =>
        DOMRect.fromRect({ width: 0, height: 0, x: contextMenu.x, y: contextMenu.y }),
    };
  }

  // Close context menu on external click
  useEffect(() => {
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener("click", closeContextMenu);
    return () => window.removeEventListener("click", closeContextMenu);
  }, []);

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
      data-testid="tab-bar"
      className={`flex items-stretch h-10 select-none shrink-0 ${themeClass(
        resolvedTheme,
        {
          dark: "bg-[#0e0e0e]",
          modern: "bg-white/[0.015] backdrop-blur-2xl",
          light: "bg-gray-100/80",
        },
      )}`}
      style={{ WebkitAppRegion: "drag" } as any}
    >
      {/* Traffic Lights Spacer (macOS Electron only) */}
      {isElectronApp() && !isWindows() && <div className="w-16 shrink-0" />}

      {/* Tabs */}
      <Reorder.Group
        as="div"
        axis="x"
        values={localTabs}
        onReorder={(newTabs) => {
          isDraggingRef.current = true;
          setLocalTabs(newTabs);
        }}
        className="flex items-stretch flex-1 overflow-x-auto no-scrollbar"
        style={{ WebkitAppRegion: "drag" } as any}
      >
        <AnimatePresence initial={false}>
          {localTabs.map((tab, index) => {
            const isFirst = index === 0;
            const isActive = tab.id === activeTabId;
            const borderCls = themeClass(resolvedTheme, {
              dark: "border-white/[0.06]",
              modern: "border-white/[0.06]",
              light: "border-black/[0.08]",
            });
            return (
            <Reorder.Item
              key={tab.id}
              value={tab}
              drag={isTouchDevice() ? false : "x"}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={0.1}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, width: 0, overflow: "hidden" }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              onDragEnd={commitReorder}
              whileDrag={{
                zIndex: 50,
                cursor: "grabbing",
                boxShadow:
                  resolvedTheme === "light"
                    ? "0 2px 12px rgba(0,0,0,0.15)"
                    : "0 2px 16px rgba(0,0,0,0.6)",
                background:
                  resolvedTheme === "light"
                    ? "rgba(255,255,255,1)"
                    : resolvedTheme === "modern"
                      ? "rgba(18,18,24,1)"
                      : "rgba(21,21,21,1)",
              }}
              style={{ WebkitAppRegion: "no-drag" } as any}
              className={`group relative flex items-center gap-2 px-3 text-xs cursor-grab active:cursor-grabbing transition-colors duration-150 max-w-[200px] min-w-[100px] border-r ${isFirst ? "border-l" : ""} ${borderCls} ${isActive
                ? themeClass(resolvedTheme, {
                  dark: "bg-[#151515] text-gray-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_3px_10px_-2px_rgba(255,255,255,0.15)]",
                  modern:
                    "bg-white/[0.04] text-gray-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_3px_10px_-2px_rgba(168,85,247,0.2)] backdrop-blur-xl",
                  light: "bg-white text-gray-900 shadow-[inset_0_0_6px_rgba(0,0,0,0.03),0_3px_10px_-2px_rgba(0,0,0,0.1)]",
                })
                : themeClass(resolvedTheme, {
                  dark: "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]",
                  modern:
                    "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]",
                  light:
                    "text-gray-400 hover:text-gray-600 hover:bg-white/40",
                })
                }`}
              data-testid={`tab-${tab.id}`}
              onClick={() => {
                if (longPressFired.current) return; // Prevent click after long-press
                onSelect(tab.id);
              }}
              onTouchStart={(e) => handleTouchStart(tab, e)}
              onTouchEnd={handleTouchEnd}
              onTouchMove={handleTouchMove}
              onContextMenu={(e) => {
                e.preventDefault();
                if (isOnlyConnectTab(tab)) return; // no context menu for connect tabs
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
            >
              {tab.color && (
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: tab.color }}
                />
              )}
              {renamingTabId === tab.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      if (renameValue.trim() && tab.activeSessionId && onRenameTab && renameValue.trim() !== tab.title) {
                        onRenameTab(tab.activeSessionId, renameValue.trim());
                      }
                      setRenamingTabId(null);
                    } else if (e.key === "Escape") {
                      setRenamingTabId(null);
                    }
                  }}
                  onBlur={() => {
                    if (renameValue.trim() && tab.activeSessionId && onRenameTab && renameValue.trim() !== tab.title) {
                      onRenameTab(tab.activeSessionId, renameValue.trim());
                    }
                    setRenamingTabId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()}
                  className={`flex-1 min-w-[50px] bg-transparent outline-none ring-1 ring-blue-500/50 rounded-sm px-1 -mx-1 ${themeClass(
                    resolvedTheme,
                    { dark: "text-white", modern: "text-white", light: "text-gray-900" },
                  )}`}
                />
              ) : (
                <span className="truncate flex-1 select-none">{tab.title}</span>
              )}
              {renamingTabId !== tab.id && !isOnlyConnectTab(tab) && (
                <button
                  data-testid={`tab-close-${tab.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const dirty = isTabDirty?.(tab.id) ?? false;
                    // Skip confirm in sandboxed iframes where confirm() is blocked
                    const canConfirm = !window.frameElement;
                    if (
                      tab.title === "Settings" ||
                      !dirty ||
                      !canConfirm ||
                      window.confirm("Close this terminal session?")
                    ) {
                      onClose(tab.id);
                    }
                  }}
                  className={`opacity-0 group-hover:opacity-100 p-1.5 -mr-1 rounded transition-opacity ${tab.id === activeTabId ? "opacity-100" : `${isTouchDevice() ? "pointer-events-none" : ""}`} ${themeClass(
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
              )}
            </Reorder.Item>
            );
          })}
        </AnimatePresence>
        {/* New Tab button */}
        <motion.button
          data-testid="tab-create"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={isSshOnly() && onCreateSSH ? onCreateSSH : onCreate}
          style={{ WebkitAppRegion: "no-drag" } as any}
          className={`ml-1 px-2.5 flex items-center transition-colors ${themeClass(
            resolvedTheme,
            {
              dark: "hover:bg-white/[0.06] text-gray-500",
              modern: "hover:bg-white/[0.06] text-gray-500",
              light: "hover:bg-black/[0.04] text-gray-400",
            },
          )}`}
          title={isSshOnly() ? "New SSH Connection" : "New Terminal"}
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

        {/* Dropdown arrow for SSH and other tab types (hidden in gateway mode — + goes straight to SSH) */}
        {onCreateSSH && !isSshOnly() && (
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                data-testid="tab-create-dropdown"
                style={{ WebkitAppRegion: "no-drag" } as any}
                className={`px-2.5 flex items-center transition-colors ${themeClass(
                  resolvedTheme,
                  {
                    dark: "hover:bg-white/[0.06] text-gray-500",
                    modern: "hover:bg-white/[0.06] text-gray-500",
                    light: "hover:bg-black/[0.04] text-gray-400",
                  },
                )}`}
                title="More tab options"
              >
                <svg className="w-3 h-3 -translate-x-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="bottom"
                align="start"
                sideOffset={4}
                className={`w-48 py-1 rounded-md shadow-xl border overflow-hidden z-[100] ${themeClass(
                  resolvedTheme,
                  {
                    dark: "bg-[#1e1e1e] border-white/10 text-gray-200",
                    modern:
                      "bg-white/[0.08] backdrop-blur-3xl border-white/[0.15] text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
                    light: "bg-white border-gray-200 text-gray-800 shadow-xl",
                  },
                )}`}
              >
                <Popover.Close asChild>
                  <button
                    data-testid="tab-create-terminal"
                    onClick={onCreate}
                    className={`w-full text-left px-3 py-1.5 text-sm transition-colors flex items-center gap-2 ${themeClass(
                      resolvedTheme,
                      {
                        dark: "hover:bg-white/10",
                        modern: "hover:bg-white/20",
                        light: "hover:bg-gray-100",
                      },
                    )}`}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    New Terminal
                  </button>
                </Popover.Close>
                <Popover.Close asChild>
                  <button
                    data-testid="tab-create-ssh"
                    onClick={onCreateSSH}
                    className={`w-full text-left px-3 py-1.5 text-sm transition-colors flex items-center gap-2 ${themeClass(
                      resolvedTheme,
                      {
                        dark: "hover:bg-white/10",
                        modern: "hover:bg-white/20",
                        light: "hover:bg-gray-100",
                      },
                    )}`}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
                    </svg>
                    SSH Connection
                  </button>
                </Popover.Close>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
      </Reorder.Group>

      {/* Settings Button */}
      <button
        data-testid="tab-settings"
        onClick={onOpenSettings}
        className={`px-2.5 flex items-center transition-colors ${themeClass(
          resolvedTheme,
          {
            dark: "hover:bg-white/[0.06] text-gray-500",
            modern:
              "hover:bg-white/[0.04] text-purple-300/60 hover:text-purple-200",
            light: "hover:bg-black/[0.04] text-gray-400",
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

      {/* Windows title bar overlay spacer (min/max/close buttons are on the right, Electron only) */}
      {isElectronApp() && isWindows() && <div className="w-36 shrink-0" />}

      {/* Context Menu managed by Radix Popover */}
      <Popover.Root open={!!contextMenu} onOpenChange={(open) => {
        if (!open) setContextMenu(null);
      }}>
        <Popover.Anchor
          virtualRef={anchorRef as any}
        />
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={4}
            className={`w-48 py-1 rounded-md shadow-xl border overflow-hidden z-[100] ${themeClass(
              resolvedTheme,
              {
                dark: "bg-[#1e1e1e] border-white/10 text-gray-200",
                modern:
                  "bg-white/[0.08] backdrop-blur-3xl border-white/[0.15] text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
                light: "bg-white border-gray-200 text-gray-800 shadow-xl",
              },
            )}`}
            onContextMenu={(e) => {
              // Prevent browser native context menu if user right-clicks
              // the custom context menu itself.
              e.preventDefault();
            }}
          >
            {/* Rename */}
            <button
              onClick={() => {
                setContextMenu(null);
                const tab = tabs.find((t) => t.id === contextMenu?.tabId);
                if (!tab) return;
                setRenamingTabId(tab.id);
                setRenameValue(tab.title);
              }}
              className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${themeClass(
                resolvedTheme,
                {
                  dark: "hover:bg-white/10",
                  modern: "hover:bg-white/20",
                  light: "hover:bg-gray-100",
                },
              )}`}
            >
              Rename Tab
            </button>

            {/* Colors */}
            <div className={`px-3 py-1.5 flex gap-1 ${themeClass(resolvedTheme, {
              dark: "border-b border-t border-white/5",
              modern: "border-b border-t border-white/10",
              light: "border-b border-t border-gray-100",
            })}`}
            >
              {[
                { c: undefined, bg: "transparent" },
                { c: "#ef4444", bg: "#ef4444" },
                { c: "#f97316", bg: "#f97316" },
                { c: "#eab308", bg: "#eab308" },
                { c: "#22c55e", bg: "#22c55e" },
                { c: "#3b82f6", bg: "#3b82f6" },
                { c: "#a855f7", bg: "#a855f7" },
              ].map((clr, i) => (
                <button
                  key={i}
                  className={`w-4 h-4 rounded-full border border-gray-500/30 hover:scale-110 transition-transform ${clr.c === tabs.find(t => t.id === contextMenu?.tabId)?.color ? "ring-2 ring-offset-1 ring-gray-400" : ""
                    }`}
                  style={{ backgroundColor: clr.bg }}
                  onClick={() => {
                    if (onUpdateTabColor && contextMenu) {
                      onUpdateTabColor(contextMenu.tabId, clr.c);
                    }
                    setContextMenu(null);
                  }}
                  title={clr.c ? "Set color" : "Clear color"}
                />
              ))}
            </div>

            {/* Duplicate */}
            <button
              onClick={async () => {
                const tabId = contextMenu?.tabId;
                setContextMenu(null);
                if (onDuplicateTab && tabId) {
                  await onDuplicateTab(tabId);
                }
              }}
              className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${themeClass(
                resolvedTheme,
                {
                  dark: "hover:bg-white/10",
                  modern: "hover:bg-white/20",
                  light: "hover:bg-gray-100",
                },
              )}`}
            >
              Duplicate Tab
            </button>

            {/* Move Left / Right — inline on single row */}
            {tabs.length > 1 && (() => {
              const idx = tabs.findIndex((t) => t.id === contextMenu?.tabId);
              const canLeft = idx > 0;
              const canRight = idx >= 0 && idx < tabs.length - 1;
              const btnBase = "px-4 py-2 text-sm transition-colors min-w-[44px] text-center";
              const disabledCls = "opacity-30 cursor-default";
              const hoverCls = themeClass(resolvedTheme, {
                dark: "hover:bg-white/10",
                modern: "hover:bg-white/20",
                light: "hover:bg-gray-100",
              });
              return (
                <div className={`flex items-center px-1 ${themeClass(resolvedTheme, {
                  dark: "border-t border-white/5",
                  modern: "border-t border-white/10",
                  light: "border-t border-gray-100",
                })}`}>
                  <button
                    disabled={!canLeft}
                    onClick={() => { if (canLeft) { onReorder(idx, idx - 1); setContextMenu(null); } }}
                    className={`${btnBase} rounded ${!canLeft ? disabledCls : hoverCls}`}
                  >←</button>
                  <span className="flex-1 text-center text-xs opacity-50">Move</span>
                  <button
                    disabled={!canRight}
                    onClick={() => { if (canRight) { onReorder(idx, idx + 1); setContextMenu(null); } }}
                    className={`${btnBase} rounded ${!canRight ? disabledCls : hoverCls}`}
                  >→</button>
                </div>
              );
            })()}

            {/* Close */}
            <button
              onClick={() => {
                const tabId = contextMenu?.tabId;
                setContextMenu(null);
                const tab = tabs.find((t) => t.id === tabId);
                const dirty = tabId ? (isTabDirty?.(tabId) ?? false) : false;
                const canConfirm = !window.frameElement;
                if (
                  tab && tabId &&
                  (tab.title === "Settings" ||
                    !dirty ||
                    !canConfirm ||
                    window.confirm("Close this terminal session?"))
                ) {
                  onClose(tabId);
                }
              }}
              className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${themeClass(
                resolvedTheme,
                {
                  dark: "hover:bg-white/10",
                  modern: "hover:bg-white/20",
                  light: "hover:bg-red-50",
                },
              )}`}
            >
              Close Tab
            </button>

            {/* Close All Tabs */}
            {tabs.length > 1 && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  if (window.confirm(`Close all ${tabs.length} tabs?`)) {
                    // Close all tabs except the last one (which triggers a new tab)
                    const tabIds = tabs.map((t) => t.id);
                    for (const id of tabIds) {
                      onClose(id);
                    }
                  }
                }}
                className={`w-full text-left px-3 py-1.5 text-sm transition-colors text-red-500 ${themeClass(
                  resolvedTheme,
                  {
                    dark: "hover:bg-white/10",
                    modern: "hover:bg-white/20",
                    light: "hover:bg-red-50",
                  },
                )}`}
              >
                Close All Tabs
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
};

export default TabBar;
