import { useState, useEffect, useRef } from "react";
import { Reorder, AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import type { Tab } from "../../types";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import { themeClass } from "../../utils/theme";
import { isWindows, isMacOS, isElectronApp, isTouchDevice } from "../../utils/platform";
import { isSshOnly } from "../../services/mode";
import logoSvg from "../../assets/logo.svg";

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
  /** Show a styled confirm modal. Resolves true if user confirms. */
  onConfirmClose?: (message: string) => Promise<boolean>;
  onRenameTab?: (sessionId: string, title: string) => void;
  onUpdateTabColor?: (tabId: string, color?: string) => void;
  onDuplicateTab?: (tabId: string) => Promise<void>;
  onSaveTab?: (tabId: string) => Promise<void>;
  onLoadSavedTab?: () => void;
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
  onConfirmClose,
  onRenameTab,
  onUpdateTabColor,
  onDuplicateTab,
  onSaveTab,
  onLoadSavedTab,
}) => {
  // Confirm helper — uses styled modal if available, falls back to window.confirm
  const confirm = async (msg: string) =>
    onConfirmClose ? onConfirmClose(msg) : window.confirm(msg);

  // Local visual order — avoids propagating every drag frame to parent
  const [localTabs, setLocalTabs] = useState(tabs);
  const isDraggingRef = useRef(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

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
    tab.root.type === "leaf" &&
    tab.root.contentType === "ssh-connect" &&
    tabs.length <= 1;

  // Stable ref for Radix Popover virtual anchor (avoids infinite re-render loop)
  const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () =>
      DOMRect.fromRect({ width: 0, height: 0, x: 0, y: 0 }),
  });
  if (contextMenu) {
    anchorRef.current = {
      getBoundingClientRect: () =>
        DOMRect.fromRect({
          width: 0,
          height: 0,
          x: contextMenu.x,
          y: contextMenu.y,
        }),
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

  // Auto-scroll to end when a new tab is created
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevTabCountRef = useRef(tabs.length);
  useEffect(() => {
    if (tabs.length > prevTabCountRef.current && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          left: scrollRef.current.scrollWidth,
          behavior: "smooth",
        });
      });
    }
    prevTabCountRef.current = tabs.length;
  }, [tabs.length]);

  // Scroll active tab fully into view on mount
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (didInitialScroll.current) return;
    didInitialScroll.current = true;
    requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      const activeEl = container.querySelector(`[data-testid="tab-${activeTabId}"]`) as HTMLElement | null;
      if (!activeEl) return;
      const cRect = container.getBoundingClientRect();
      const tRect = activeEl.getBoundingClientRect();
      // Account for the sticky "New Tab" button (~60px) that overlaps the scroll area
      const rightPad = 60;
      if (tRect.left < cRect.left) {
        container.scrollLeft += tRect.left - cRect.left;
      } else if (tRect.right > cRect.right - rightPad) {
        container.scrollLeft += tRect.right - (cRect.right - rightPad);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commitReorder = () => {
    isDraggingRef.current = false;
    setDraggingTabId(null);
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
      className={`flex h-10 shrink-0 items-stretch select-none ${themeClass(
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

      {/* App icon (web mode only — Electron has native title bar / traffic lights) */}
      {!isElectronApp() && (
        <div className="flex items-center pl-3 pr-2 shrink-0">
          <img src={logoSvg} alt="Tron" className="w-5 h-5" draggable={false} />
        </div>
      )}

      {/* Tabs — scrollable container wraps both reorder group and new-tab button */}
      <div
        ref={scrollRef}
        className={`no-scrollbar flex flex-1 items-stretch overflow-x-auto ${isMacOS() ? "pl-3" : ""}`}
        style={{ WebkitAppRegion: "drag", touchAction: "pan-x", overscrollBehaviorY: "none" } as any}
      >
      <Reorder.Group
        as="div"
        axis="x"
        values={localTabs}
        onReorder={(newTabs) => {
          isDraggingRef.current = true;
          setLocalTabs(newTabs);
        }}
        className="flex items-stretch"
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
                onDragStart={() => setDraggingTabId(tab.id)}
                onDragEnd={commitReorder}
                whileDrag={{
                  zIndex: 50,
                  cursor: "grabbing",
                  boxShadow:
                    resolvedTheme === "light"
                      ? "0 2px 12px rgba(0,0,0,0.15)"
                      : "0 2px 16px rgba(0,0,0,0.6)",
                }}
                style={{ WebkitAppRegion: "no-drag" } as any}
                className={`group relative flex max-w-[200px] min-w-[100px] cursor-grab items-center gap-2 border-r px-3 text-xs transition-colors duration-150 active:cursor-grabbing ${isFirst ? "border-l" : ""} ${borderCls} ${
                  draggingTabId === tab.id
                    ? themeClass(resolvedTheme, {
                        dark: "!bg-[#151515]",
                        modern: "!bg-[#12121a]",
                        light: "!bg-white",
                      })
                    : ""
                } ${
                  isActive
                    ? themeClass(resolvedTheme, {
                        dark: "bg-[#151515] text-gray-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_3px_10px_-2px_rgba(255,255,255,0.15)]",
                        modern:
                          "bg-white/[0.04] text-gray-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_3px_10px_-2px_rgba(168,85,247,0.2)] backdrop-blur-xl",
                        light:
                          "bg-white text-gray-900 shadow-[inset_0_0_6px_rgba(0,0,0,0.03),0_3px_10px_-2px_rgba(0,0,0,0.1)]",
                      })
                    : themeClass(resolvedTheme, {
                        dark: "text-gray-500 hover:bg-white/[0.03] hover:text-gray-300",
                        modern:
                          "text-gray-500 hover:bg-white/[0.03] hover:text-gray-300",
                        light:
                          "text-gray-400 hover:bg-white/40 hover:text-gray-600",
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
                    className="h-2 w-2 flex-shrink-0 rounded-full"
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
                        if (
                          renameValue.trim() &&
                          tab.activeSessionId &&
                          onRenameTab &&
                          renameValue.trim() !== tab.title
                        ) {
                          onRenameTab(tab.activeSessionId, renameValue.trim());
                        }
                        setRenamingTabId(null);
                      } else if (e.key === "Escape") {
                        setRenamingTabId(null);
                      }
                    }}
                    onBlur={() => {
                      if (
                        renameValue.trim() &&
                        tab.activeSessionId &&
                        onRenameTab &&
                        renameValue.trim() !== tab.title
                      ) {
                        onRenameTab(tab.activeSessionId, renameValue.trim());
                      }
                      setRenamingTabId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.stopPropagation()}
                    className={`-mx-1 min-w-[50px] flex-1 rounded-sm bg-transparent px-1 ring-1 ring-blue-500/50 outline-none ${themeClass(
                      resolvedTheme,
                      {
                        dark: "text-white",
                        modern: "text-white",
                        light: "text-gray-900",
                      },
                    )}`}
                  />
                ) : (
                  <span className="flex-1 truncate select-none">
                    {tab.title}
                  </span>
                )}
                {renamingTabId !== tab.id && !isOnlyConnectTab(tab) && (
                  <button
                    data-testid={`tab-close-${tab.id}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      const dirty = isTabDirty?.(tab.id) ?? false;
                      if (
                        tab.title === "Settings" ||
                        !dirty ||
                        (await confirm("Close this terminal session?"))
                      ) {
                        onClose(tab.id);
                      }
                    }}
                    className={`-mr-1 rounded p-1.5 opacity-0 transition-opacity group-hover:opacity-100 ${tab.id === activeTabId ? "opacity-100" : `${isTouchDevice() ? "pointer-events-none" : ""}`} ${themeClass(
                      resolvedTheme,
                      {
                        dark: "hover:bg-white/20",
                        modern: "hover:bg-white/20",
                        light: "hover:bg-black/10",
                      },
                    )}`}
                  >
                    <svg
                      className="h-3 w-3"
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
      </Reorder.Group>

        {/* New Tab + Dropdown — outside Reorder.Group so tabs can't be dragged over it */}
        <div
          className={`flex items-stretch shrink-0 z-10 ${themeClass(
            resolvedTheme,
            {
              dark: "bg-[#0e0e0e]",
              modern: "bg-[#0c0c14]",
              light: "bg-gray-100/80",
            },
          )}`}
          style={{ WebkitAppRegion: "no-drag" } as any}
        >
        <motion.button
          data-testid="tab-create"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={isSshOnly() && onCreateSSH ? onCreateSSH : onCreate}
          className={`flex items-center px-2.5 transition-colors ${themeClass(
            resolvedTheme,
            {
              dark: "text-gray-500 hover:bg-white/[0.06]",
              modern: "text-gray-500 hover:bg-white/[0.06]",
              light: "text-gray-400 hover:bg-black/[0.04]",
            },
          )}`}
          title={isSshOnly() ? "New SSH Connection" : "New Terminal"}
        >
          <svg
            className="h-4 w-4"
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
                className={`flex items-center px-2.5 transition-colors ${themeClass(
                  resolvedTheme,
                  {
                    dark: "text-gray-500 hover:bg-white/[0.06]",
                    modern: "text-gray-500 hover:bg-white/[0.06]",
                    light: "text-gray-400 hover:bg-black/[0.04]",
                  },
                )}`}
                title="More tab options"
              >
                <svg
                  className="h-3 w-3 -translate-x-1.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                side="bottom"
                align="start"
                sideOffset={4}
                className={`z-[100] w-48 overflow-hidden rounded-md border py-1 shadow-xl ${themeClass(
                  resolvedTheme,
                  {
                    dark: "border-white/10 bg-[#1e1e1e] text-gray-200",
                    modern:
                      "border-white/[0.15] bg-[#1a1a3e]/95 text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
                    light: "border-gray-200 bg-white text-gray-800 shadow-xl",
                  },
                )}`}
              >
                <Popover.Close asChild>
                  <button
                    data-testid="tab-create-terminal"
                    onClick={onCreate}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${themeClass(
                      resolvedTheme,
                      {
                        dark: "hover:bg-white/10",
                        modern: "hover:bg-white/20",
                        light: "hover:bg-gray-100",
                      },
                    )}`}
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    New Terminal
                  </button>
                </Popover.Close>
                <Popover.Close asChild>
                  <button
                    data-testid="tab-create-ssh"
                    onClick={onCreateSSH}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${themeClass(
                      resolvedTheme,
                      {
                        dark: "hover:bg-white/10",
                        modern: "hover:bg-white/20",
                        light: "hover:bg-gray-100",
                      },
                    )}`}
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"
                      />
                    </svg>
                    SSH Connection
                  </button>
                </Popover.Close>
                {onLoadSavedTab && (
                  <>
                    <div
                      className={`my-1 ${themeClass(resolvedTheme, {
                        dark: "border-t border-white/5",
                        modern: "border-t border-white/10",
                        light: "border-t border-gray-100",
                      })}`}
                    />
                    <Popover.Close asChild>
                      <button
                        data-testid="tab-load-saved"
                        onClick={onLoadSavedTab}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${themeClass(
                          resolvedTheme,
                          {
                            dark: "hover:bg-white/10",
                            modern: "hover:bg-white/20",
                            light: "hover:bg-gray-100",
                          },
                        )}`}
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                          />
                        </svg>
                        Load Saved Tab
                      </button>
                    </Popover.Close>
                  </>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
      </div>

      {/* Settings Button */}
      <button
        data-testid="tab-settings"
        onClick={() => onOpenSettings()}
        className={`flex items-center px-2.5 transition-colors ${themeClass(
          resolvedTheme,
          {
            dark: "text-gray-500 hover:bg-white/[0.06]",
            modern:
              "text-purple-300/60 hover:bg-white/[0.04] hover:text-purple-200",
            light: "text-gray-400 hover:bg-black/[0.04]",
          },
        )}`}
        title="Settings (Cmd+,)"
        style={{ WebkitAppRegion: "no-drag" } as any}
      >
        <svg
          className="h-5 w-5"
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
      <Popover.Root
        open={!!contextMenu}
        onOpenChange={(open) => {
          if (!open) setContextMenu(null);
        }}
      >
        <Popover.Anchor virtualRef={anchorRef as any} />
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={4}
            className={`z-[100] w-48 overflow-hidden rounded-md border py-1 shadow-xl ${themeClass(
              resolvedTheme,
              {
                dark: "border-white/10 bg-[#1e1e1e] text-gray-200",
                modern:
                  "border-white/[0.15] bg-[#1a1a3e]/95 text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
                light: "border-gray-200 bg-white text-gray-800 shadow-xl",
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
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${themeClass(
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
            <div
              className={`flex gap-1 px-3 py-1.5 ${themeClass(resolvedTheme, {
                dark: "border-t border-b border-white/5",
                modern: "border-t border-b border-white/10",
                light: "border-t border-b border-gray-100",
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
                  className={`h-4 w-4 rounded-full border border-gray-500/30 transition-transform hover:scale-110 ${
                    clr.c ===
                    tabs.find((t) => t.id === contextMenu?.tabId)?.color
                      ? "ring-2 ring-gray-400 ring-offset-1"
                      : ""
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

            {/* Move Left / Right — inline on single row */}
            {tabs.length > 1 &&
              (() => {
                const idx = tabs.findIndex((t) => t.id === contextMenu?.tabId);
                const canLeft = idx > 0;
                const canRight = idx >= 0 && idx < tabs.length - 1;
                const btnBase =
                  "px-4 py-2 text-sm transition-colors min-w-[44px] text-center";
                const disabledCls = "opacity-30 cursor-default";
                const hoverCls = themeClass(resolvedTheme, {
                  dark: "hover:bg-white/10",
                  modern: "hover:bg-white/20",
                  light: "hover:bg-gray-100",
                });
                return (
                  <div
                    className={`flex items-center px-1 ${themeClass(
                      resolvedTheme,
                      {
                        dark: "border-t border-white/5",
                        modern: "border-t border-white/10",
                        light: "border-t border-gray-100",
                      },
                    )}`}
                  >
                    <button
                      disabled={!canLeft}
                      onClick={() => {
                        if (canLeft) {
                          onReorder(idx, idx - 1);
                          setContextMenu(null);
                        }
                      }}
                      className={`${btnBase} rounded ${!canLeft ? disabledCls : hoverCls}`}
                    >
                      ←
                    </button>
                    <span className="flex-1 text-center text-xs opacity-50">
                      Move
                    </span>
                    <button
                      disabled={!canRight}
                      onClick={() => {
                        if (canRight) {
                          onReorder(idx, idx + 1);
                          setContextMenu(null);
                        }
                      }}
                      className={`${btnBase} rounded ${!canRight ? disabledCls : hoverCls}`}
                    >
                      →
                    </button>
                  </div>
                );
              })()}

            {/* Duplicate */}
            <button
              onClick={async () => {
                const tabId = contextMenu?.tabId;
                setContextMenu(null);
                if (onDuplicateTab && tabId) {
                  await onDuplicateTab(tabId);
                }
              }}
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${themeClass(
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

            {/* Save to Remote */}
            <button
              data-testid="tab-save-remote"
              onClick={async () => {
                const tabId = contextMenu?.tabId;
                setContextMenu(null);
                if (onSaveTab && tabId) {
                  await onSaveTab(tabId);
                }
              }}
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${themeClass(
                resolvedTheme,
                {
                  dark: "hover:bg-white/10",
                  modern: "hover:bg-white/20",
                  light: "hover:bg-gray-100",
                },
              )}`}
            >
              Save to Remote
            </button>

            {/* Close */}
            <button
              onClick={async () => {
                const tabId = contextMenu?.tabId;
                setContextMenu(null);
                const tab = tabs.find((t) => t.id === tabId);
                const dirty = tabId ? (isTabDirty?.(tabId) ?? false) : false;
                if (
                  tab &&
                  tabId &&
                  (tab.title === "Settings" ||
                    !dirty ||
                    (await confirm("Close this terminal session?")))
                ) {
                  onClose(tabId);
                }
              }}
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${themeClass(
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
                onClick={async () => {
                  setContextMenu(null);
                  if (await confirm(`Close all ${tabs.length} tabs?`)) {
                    const tabIds = tabs.map((t) => t.id);
                    for (const id of tabIds) {
                      onClose(id);
                    }
                  }
                }}
                className={`w-full px-3 py-1.5 text-left text-sm text-red-500 transition-colors ${themeClass(
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
