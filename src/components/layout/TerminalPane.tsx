import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence, Reorder, useDragControls } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { X, Bot, ChevronRight, ChevronUp, Folder, Columns2, Rows2, SquareSplitHorizontal, Copy, ClipboardPaste, TextCursorInput, TextSelect, Check, Monitor, Search, Maximize2, Minimize2, GripVertical, Play, CornerRightUp, ImageIcon } from "lucide-react";
import Terminal from "../../features/terminal/components/Terminal";
import SmartInput from "../../features/terminal/components/SmartInput";
import AgentOverlay from "../../features/agent/components/AgentOverlay";
import ContextBar from "./ContextBar";
import SSHConnectModal from "../../features/ssh/components/SSHConnectModal";
import { useLayout } from "../../contexts/LayoutContext";
import { useTheme } from "../../contexts/ThemeContext";
import { useAgentRunner } from "../../hooks/useAgentRunner";
import { useAgent } from "../../contexts/AgentContext";
import { themeClass } from "../../utils/theme";
import logoSvg from "../../assets/logo.svg";
import { useHotkey, formatHotkey } from "../../hooks/useHotkey";
import { useConfig } from "../../contexts/ConfigContext";
import { subtreeContainsSession, countLeaves } from "../../utils/paneNav";
import { usePanelChrome } from "../../hooks/usePanelChrome";
import { Collapsible } from "../ui/Collapsible";
import { setFocusedSession, getFocusedSession } from "../../services/panelFocus";
import type { PanelChromeRegion } from "../../types";
import {
  isInteractiveCommand,
  smartQuotePaths,
} from "../../utils/commandClassifier";
import { IPC } from "../../constants/ipc";
import { abbreviateHome, isElectronApp, isTouchDevice } from "../../utils/platform";
import type { AttachedImage, SSHConnectionStatus } from "../../types";
import SSHStatusBadge from "../../features/ssh/components/SSHStatusBadge";
import TuiKeyToolbar from "../../features/terminal/components/TuiKeyToolbar";
import { useAllConfiguredModels } from "../../hooks/useModels";
import { readScreenBuffer, getTerminalSelection, readViewportText } from "../../services/terminalBuffer";
import { aiService } from "../../services/ai";
import { stripAnsi } from "../../utils/contextCleaner";
import { writeClipboardText } from "../../utils/clipboard";

interface TerminalPaneProps {
  sessionId: string;
}

/** A prompt or command waiting for the agent to become free. */
interface QueueItem {
  id: string;
  type: "command" | "agent";
  content: string;
  images?: AttachedImage[];
}

let queueItemIdCounter = 0;
const newQueueItemId = () => `q${++queueItemIdCounter}-${Math.random().toString(36).slice(2, 7)}`;

/** One row in the queued-prompts list: drag handle, inline edit, steer/delete. */
const QueueRow: React.FC<{
  item: QueueItem;
  resolvedTheme: string;
  isAgentRunning: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSteer: () => void;
}> = ({ item, resolvedTheme, isAgentRunning, editing, onStartEdit, onSaveEdit, onCancelEdit, onDelete, onSteer }) => {
  const dragControls = useDragControls();
  const isAgentItem = item.type === "agent";
  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={dragControls}
      className={`group flex items-center gap-1.5 rounded-md px-1.5 py-1 ${themeClass(resolvedTheme, {
        dark: "hover:bg-white/[0.05]",
        modern: "hover:bg-white/[0.06]",
        light: "hover:bg-gray-100",
      })}`}
    >
      <span
        onPointerDown={(e) => {
          e.preventDefault();
          dragControls.start(e);
        }}
        style={{ touchAction: "none" }}
        title="Drag to reorder"
        className="shrink-0 cursor-grab opacity-20 transition-opacity group-hover:opacity-50 active:cursor-grabbing"
      >
        <GripVertical className="h-3 w-3" />
      </span>
      {isAgentItem ? (
        <Bot className="h-3 w-3 shrink-0 text-blue-400/70" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
      )}
      {editing ? (
        <input
          autoFocus
          defaultValue={item.content}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onSaveEdit((e.target as HTMLInputElement).value);
            else if (e.key === "Escape") onCancelEdit();
          }}
          onBlur={(e) => onSaveEdit(e.target.value)}
          className={`min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none ${themeClass(resolvedTheme, {
            dark: "text-gray-200",
            modern: "text-gray-100",
            light: "text-gray-800",
          })}`}
        />
      ) : (
        <span
          onClick={onStartEdit}
          title="Click to edit"
          className="min-w-0 flex-1 cursor-text truncate font-mono text-[11px] opacity-80 transition-opacity hover:opacity-100"
        >
          {item.content || "(image prompt)"}
        </span>
      )}
      {item.images && item.images.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-[10px] opacity-50">
          <ImageIcon className="h-2.5 w-2.5" />
          {item.images.length}
        </span>
      )}
      {isAgentRunning && isAgentItem && !item.images?.length && (
        <button
          onClick={onSteer}
          title="Send now — steer the running agent with this message"
          className="shrink-0 rounded p-0.5 text-blue-400 opacity-0 transition-opacity hover:bg-blue-400/10 group-hover:opacity-80"
        >
          <CornerRightUp className="h-3 w-3" />
        </button>
      )}
      <button
        onClick={onDelete}
        title="Remove from queue"
        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-60"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </Reorder.Item>
  );
};

const TerminalPane: React.FC<TerminalPaneProps> = ({ sessionId }) => {
  const {
    tabs,
    activeSessionId,
    sessions,
    markSessionDirty,
    focusSession,
    clearInteractions,
    createSSHTab,
    openSettingsTab,
    renameTab,
    isTabTitleLocked,
    lockTabTitle,
    refreshCwd,
    splitUserAction,
    closePane,
    serverDisconnected,
    reconnectSSH,
    restartShell,
    toggleMaximizePane,
  } = useLayout();
  const { resolvedTheme, viewMode } = useTheme();
  const isAgentMode = viewMode === "agent";
  const isActive = sessionId === activeSessionId;
  const session = sessions.get(sessionId);
  const isConnectPane = sessionId.startsWith("ssh-connect");
  const { hotkeys } = useConfig();
  const paneTab = tabs.find((t) => subtreeContainsSession(t.root, sessionId));
  // Own tab's value, not the active tab's — panes in hidden tabs must keep
  // their maximize state (context maximizedSessionId is active-tab only).
  const isMaximized = paneTab?.maximizedSessionId === sessionId;
  const canMaximize = !!paneTab && countLeaves(paneTab.root) > 1;
  const maximizeTitle = `${isMaximized ? "Restore pane" : "Maximize pane"} (${formatHotkey(hotkeys.maximizePane)})`;
  const [showSSHModal, setShowSSHModal] = useState(false);
  const [connectToast, setConnectToast] = useState(false);
  const connectToastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { data: availableModels = [] } = useAllConfiguredModels();
  const noModelConfigured = availableModels.length === 0;
  const [modelToast, setModelToast] = useState(false);
  const modelToastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const {
    agentThread,
    isAgentRunning,
    isThinking,
    pendingCommand,
    isOverlayVisible,
    setIsOverlayVisible,
    alwaysAllowSession,
    setAlwaysAllowSession,
    thinkingEnabled,
    setThinkingEnabled,
    modelCapabilities,
    handleCommand,
    handleCommandInOverlay,
    handleAgentRun,
    handlePermission,
    awaitingAnswer,
  } = useAgentRunner(sessionId, session);

  const {
    stopAgent: stopAgentRaw,
    resetSession,
    overlayHeight,
    setOverlayHeight,
    draftInput,
    setDraftInput,
    setAgentThread,
    focusTarget,
    setFocusTarget,
    scrollPosition,
    setScrollPosition,
  } = useAgent(sessionId);

  // Stable refs for SmartInput memo
  const stopAgentRef = useRef(stopAgentRaw);
  stopAgentRef.current = stopAgentRaw;
  const stableStopAgent = useCallback(() => stopAgentRef.current(), []);

  const setThinkingEnabledRef = useRef(setThinkingEnabled);
  setThinkingEnabledRef.current = setThinkingEnabled;
  const stableSetThinkingEnabled = useCallback(
    (v: boolean) => setThinkingEnabledRef.current(v),
    [],
  );

  const setDraftInputRef = useRef(setDraftInput);
  setDraftInputRef.current = setDraftInput;
  const stableSetDraftInput = useCallback(
    (v: string | undefined) => setDraftInputRef.current(v),
    [],
  );

  // ── Collapsible panel chrome (input / hints / footer) ──────────────────
  const paneRootRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  useEffect(() => {
    const el = paneRootRef.current;
    if (!el) return;
    setPanelHeight(el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPanelHeight(e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const {
    visible: chromeVisible,
    toggle: toggleChrome,
    showAll: showAllChrome,
    anyHidden: chromeAnyHidden,
  } = usePanelChrome(sessionId, panelHeight);
  const stableToggleChrome = useCallback(
    (region: PanelChromeRegion) => toggleChrome(region),
    [toggleChrome],
  );
  // Panel-chrome hotkeys act on the focused pane only (matters with splits /
  // multiple tabs mounted at once). No focused pane yet → no-op (the user
  // clicks a pane first, which sets focus via handlePaneFocus).
  const toggleRegionIfFocused = useCallback(
    (region: PanelChromeRegion) => {
      if (getFocusedSession() === sessionId) toggleChrome(region);
    },
    [sessionId, toggleChrome],
  );
  useHotkey("togglePanelInput", () => toggleRegionIfFocused("input"), [toggleRegionIfFocused]);
  useHotkey("togglePanelHints", () => toggleRegionIfFocused("hints"), [toggleRegionIfFocused]);
  useHotkey("togglePanelFooter", () => toggleRegionIfFocused("footer"), [toggleRegionIfFocused]);

  // Command-palette entry point: toggle a chrome region on a SPECIFIC pane
  // (the palette targets the active session; hotkeys target the focused one).
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { sessionId?: string; region?: PanelChromeRegion };
      if (d?.sessionId === sessionId && d.region) stableToggleChrome(d.region);
    };
    window.addEventListener("tron:togglePanelRegion", handler);
    return () => window.removeEventListener("tron:togglePanelRegion", handler);
  }, [sessionId, stableToggleChrome]);

  // Stable callback refs for SmartInput memo (assigned after functions are defined below)
  const wrappedHandleCommandRef = useRef<(cmd: string) => void>(() => {});
  const wrappedHandleAgentRunRef = useRef<
    (prompt: string, queueCallback?: any, images?: AttachedImage[]) => void
  >(() => {});
  const handleSlashCommandRef = useRef<(cmd: string) => void>(() => {});
  const stableOnSend = useCallback(
    (cmd: string) => wrappedHandleCommandRef.current(cmd),
    [],
  );
  const stableOnRunAgent = useCallback(
    async (prompt: string, images?: AttachedImage[]) =>
      wrappedHandleAgentRunRef.current(
        prompt,
        (item: any) => queueItemRef.current(item),
        images,
      ),
    [],
  );
  const stableSlashCommand = useCallback(
    (cmd: string) => handleSlashCommandRef.current(cmd),
    [],
  );

  // No-model toast handler
  const openSettingsTabRef = useRef(openSettingsTab);
  openSettingsTabRef.current = openSettingsTab;
  const stableHandleNoModel = useCallback(() => {
    setModelToast(true);
    if (modelToastTimer.current) clearTimeout(modelToastTimer.current);
    modelToastTimer.current = setTimeout(() => setModelToast(false), 6000);
  }, []);

  // Terminal scroll-to-bottom state + paused lines count
  const [termScrolledUp, setTermScrolledUp] = useState(false);
  const stableOnScrolledUpChange = useCallback((up: boolean) => setTermScrolledUp(up), []);
  const scrollTermToBottom = useCallback(() => {
    window.dispatchEvent(new CustomEvent("tron:scrollTermToBottom", { detail: { sessionId } }));
    setTermScrolledUp(false);
  }, [sessionId]);

  // Selection overlay text — snapshot of visible viewport lines (no scrolling needed)
  const [selectionText, setSelectionText] = useState("");

  // Stable callback for Terminal memo
  const markSessionDirtyRef = useRef(markSessionDirty);
  markSessionDirtyRef.current = markSessionDirty;
  const stableOnActivity = useCallback(
    () => markSessionDirtyRef.current(sessionId),
    [sessionId],
  );

  // Rename tab on first direct terminal Enter (when tab title is still "Terminal")
  const renameTabRef = useRef(renameTab);
  renameTabRef.current = renameTab;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const firstCommandFired = useRef(false);
  useEffect(() => {
    firstCommandFired.current = false;
  }, [sessionId]);
  const isTabTitleLockedRef = useRef(isTabTitleLocked);
  isTabTitleLockedRef.current = isTabTitleLocked;
  const lockTabTitleRef = useRef(lockTabTitle);
  lockTabTitleRef.current = lockTabTitle;
  const stableOnFirstCommand = useCallback(() => {
    if (firstCommandFired.current) return;
    firstCommandFired.current = true;
    // Skip if tab title is already locked (user-renamed or auto-named by another panel)
    if (isTabTitleLockedRef.current(sessionId)) return;
    // Only rename if tab title is still the default
    const currentTab = tabsRef.current.find(
      (t) => t.activeSessionId === sessionId,
    );
    if (currentTab && currentTab.title !== "Terminal") return;
    // Read from xterm screen buffer after a short delay to let PTY echo
    setTimeout(() => {
      const buf = readScreenBuffer(sessionId, 5);
      if (!buf) return;
      const lines = buf.split("\n").filter((l: string) => l.trim());
      const lastLine = lines[lines.length - 1]?.trim();
      if (!lastLine) return;
      // Strip common prompt prefixes ($ % # > PS path>)
      const cmd = lastLine
        .replace(/^(?:\$|%|#|>|PS [^>]*>|[A-Z]:\\[^>]*>)\s*/, "")
        .trim();
      if (cmd) {
        const title = cmd.length > 20 ? cmd.substring(0, 20) + "..." : cmd;
        renameTabRef.current(sessionId, title);
      }
    }, 200);
  }, [sessionId]);

  // Auto-generate tab name after 60s of activity (once per session)
  const autoNameAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sessionId || sessionId.startsWith("ssh-connect")) return;
    if (autoNameAttempted.current.has(sessionId)) return;
    const timer = setTimeout(async () => {
      if (autoNameAttempted.current.has(sessionId)) return;
      autoNameAttempted.current.add(sessionId);
      try {
        // Skip if tab title is already locked (user-renamed or auto-named by another panel)
        if (isTabTitleLockedRef.current(sessionId)) return;
        // Check tab title is still default
        const currentTab = tabsRef.current.find(
          (t) => t.activeSessionId === sessionId,
        );
        if (!currentTab || currentTab.title !== "Terminal") return;
        // Get history
        const history = await window.electron?.ipcRenderer?.getHistory?.(sessionId);
        if (!history || history.length < 50) return;
        const stripped = stripAnsi(history);
        if (stripped.trim().length < 30) return;
        const name = await aiService.generateTabName(
          stripped,
          session?.aiConfig,
        );
        if (!name) return;
        // Re-check tab still has default title and not locked
        if (isTabTitleLockedRef.current(sessionId)) return;
        const recheckTab = tabsRef.current.find(
          (t) => t.activeSessionId === sessionId,
        );
        if (recheckTab && recheckTab.title === "Terminal") {
          // AI-generated tab name: lock it so no later auto-rename overrides.
          renameTabRef.current(sessionId, name);
          lockTabTitleRef.current(sessionId);
        }
      } catch {
        // Non-critical, silently ignore
      }
    }, 60000);
    return () => clearTimeout(timer);
  }, [sessionId]);

  // Input Queue — prompts/commands sent while the agent is busy. An item is
  // only removed once its run actually STARTS: a rejected drain re-queues it
  // at the front, and a watchdog retries so a missed state transition (e.g.
  // auto-summarize churn) can never strand the queue.
  const [inputQueue, setInputQueue] = useState<QueueItem[]>([]);
  const inputQueueRef = useRef<QueueItem[]>([]);
  inputQueueRef.current = inputQueue;
  // When the user manually stops the agent the queue PAUSES (visibly) so the
  // next queued message isn't silently auto-fired. Any new run resumes it.
  const [queuePaused, setQueuePaused] = useState(false);
  // Bumped to force a drain retry (rejected drain, watchdog tick, manual resume)
  const [drainNonce, setDrainNonce] = useState(0);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);

  // Stable ref for queueItem so stableOnRunAgent can use it
  const queueItemRef = useRef<
    (item: { type: "command" | "agent"; content: string; images?: AttachedImage[] }) => void
  >(() => {});

  // SSH status tracking
  const isSSH = !!session?.sshProfileId;
  const [sshStatus, setSshStatus] = useState<SSHConnectionStatus>(
    isSSH ? "connected" : "disconnected",
  );

  useEffect(() => {
    if (!isSSH) return;
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.on) return;
    const cleanup = ipc.on(IPC.SSH_STATUS_CHANGE, (data: any) => {
      if (data.sessionId === sessionId) {
        setSshStatus(data.status);
      }
    });
    return cleanup;
  }, [sessionId, isSSH]);

  // Touch selection mode — when active, a native-selectable text overlay appears
  const [selectionMode, setSelectionMode] = useState(false);
  // Snapshot the visible viewport text when entering selection mode
  useEffect(() => {
    if (selectionMode) {
      setSelectionText(readViewportText(sessionId));
    }
  }, [selectionMode, sessionId]);

  // Context menu state (right-click / long-press for split/close)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const longPressTriggered = useRef(false);

  // Radix Popover virtual anchor — positions popover at click/touch coordinates
  const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: 0, y: 0 }),
  });
  if (contextMenu) {
    anchorRef.current = {
      getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: contextMenu.x, y: contextMenu.y }),
    };
  }

  // In agent view: show embedded terminal when user runs a command
  const [showEmbeddedTerminal, setShowEmbeddedTerminal] = useState(false);
  const showTuiToolbar =
    isTouchDevice() &&
    !isConnectPane &&
    (isAgentMode ? showEmbeddedTerminal : focusTarget === "terminal");

  // Toggle agent panel (no-op in agent view mode — overlay is always visible)
  useHotkey(
    "toggleOverlay",
    () => {
      if (!isActive || isAgentMode) return;
      if (agentThread.length > 0) setIsOverlayVisible(!isOverlayVisible);
    },
    [
      isActive,
      isAgentMode,
      isOverlayVisible,
      agentThread.length,
      setIsOverlayVisible,
    ],
  );

  // Stop running agent — only when focus is NOT inside the terminal (xterm textarea)
  // so that Ctrl+C in the terminal sends SIGINT to PTY without also stopping the agent
  useHotkey(
    "stopAgent",
    () => {
      if (!isActive || !isAgentRunning) return;
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement && el.closest(".xterm")) return;
      stopAgentRaw();
    },
    [isActive, isAgentRunning, stopAgentRaw],
  );

  // Clear terminal only (Cmd+K) — preserves agent thread
  useHotkey(
    "clearTerminal",
    () => {
      if (!isActive) return;
      // Only clear the xterm display, never the agent thread
      window.dispatchEvent(
        new CustomEvent("tron:clearTerminal", { detail: { sessionId } }),
      );
    },
    [isActive, sessionId],
  );

  // Clear agent panel only (Cmd+Shift+K)
  useHotkey(
    "clearAgent",
    () => {
      if (!isActive) return;
      resetSession();
      clearInteractions(sessionId);
    },
    [isActive, resetSession, clearInteractions, sessionId],
  );

  // Listen for tutorial test-run event
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: Event) => {
      const prompt = (e as CustomEvent).detail?.prompt;
      if (prompt) handleAgentRun(prompt);
    };
    window.addEventListener("tutorial-run-agent", handler);
    return () => window.removeEventListener("tutorial-run-agent", handler);
  }, [isActive, handleAgentRun]);

  // Reclaim steering messages that were posted too late to steer (the run
  // ended first) — demote them to the front of the queue instead of dropping.
  const prevAgentRunningRef = useRef(false);
  useEffect(() => {
    if (prevAgentRunningRef.current && !isAgentRunning) {
      const leftovers = aiService.takeSteeringMessages(sessionId);
      if (leftovers.length > 0) {
        setInputQueue((prev) => [
          ...leftovers.map((t) => ({ id: newQueueItemId(), type: "agent" as const, content: t })),
          ...prev,
        ]);
      }
    }
    prevAgentRunningRef.current = isAgentRunning;
  }, [isAgentRunning, sessionId]);

  // Process Queue Effect
  useEffect(() => {
    // A new run resumes a paused queue so it drains normally after the agent
    // finishes on its own.
    if (isAgentRunning) {
      if (queuePaused) setQueuePaused(false);
      return;
    }
    if (inputQueue.length === 0 || queuePaused) return;
    const nextItem = inputQueue[0];
    // Hold the drain while the user is editing the item that's up next — the
    // save/cancel updates editingQueueId, which re-triggers this effect.
    if (editingQueueId === nextItem.id) return;
    setInputQueue((prev) => prev.filter((it) => it.id !== nextItem.id));

    if (nextItem.type === "command") {
      if (isAgentMode) {
        if (isInteractiveCommand(nextItem.content)) {
          setShowEmbeddedTerminal(true);
          handleCommand(nextItem.content);
        } else {
          handleCommandInOverlay(nextItem.content);
        }
      } else {
        handleCommand(nextItem.content);
      }
    } else if (nextItem.content.trim() || nextItem.images?.length) {
      void handleAgentRun(nextItem.content, undefined, nextItem.images, { fromQueue: true }).then(
        (accepted) => {
          if (accepted === false) {
            // Rejected (e.g. another run raced in) — put it back and retry
            // shortly instead of silently dropping the prompt.
            setInputQueue((prev) => [nextItem, ...prev]);
            setTimeout(() => setDrainNonce((n) => n + 1), 800);
          }
        },
      );
    }
  }, [
    isAgentRunning,
    inputQueue,
    queuePaused,
    drainNonce,
    editingQueueId,
    handleCommand,
    handleCommandInOverlay,
    handleAgentRun,
    isAgentMode,
  ]);

  // Watchdog: while idle with a non-empty, unpaused queue, retry the drain
  // every 2s. Guarantees recovery if a state transition was missed.
  useEffect(() => {
    if (isAgentRunning || inputQueue.length === 0 || queuePaused) return;
    const iv = setInterval(() => setDrainNonce((n) => n + 1), 2000);
    return () => clearInterval(iv);
  }, [isAgentRunning, inputQueue.length, queuePaused]);

  // On a manual stop, pause the queue for this pane so the next queued message
  // isn't auto-fired the instant the agent stops (see AgentContext.stopAgent).
  useEffect(() => {
    const onStopped = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string };
      if (detail?.sessionId && detail.sessionId !== sessionId) return;
      if (inputQueueRef.current.length > 0) setQueuePaused(true);
    };
    window.addEventListener("tron:agentManuallyStopped", onStopped);
    return () => window.removeEventListener("tron:agentManuallyStopped", onStopped);
  }, [sessionId]);

  const queueItem = (item: { type: "command" | "agent"; content: string; images?: AttachedImage[] }) => {
    setInputQueue((prev) => [...prev, { ...item, id: newQueueItemId() }]);
  };
  queueItemRef.current = queueItem;

  /** Steer the RUNNING agent — or start a fresh run if it just finished. */
  const steerText = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      if (isAgentRunning) {
        aiService.postSteeringMessage(sessionId, text.trim());
      } else {
        wrappedHandleAgentRunRef.current(text.trim(), (item: QueueItem) => queueItemRef.current(item));
      }
    },
    [isAgentRunning, sessionId],
  );

  /** Pop the most recent queued prompt (no attachments) for editing in the input. */
  const popQueuedForEdit = useCallback((): string | null => {
    const q = inputQueueRef.current;
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].images?.length) continue;
      const item = q[i];
      setInputQueue((prev) => prev.filter((it) => it.id !== item.id));
      return item.content;
    }
    return null;
  }, []);

  // Close embedded terminal: aggressively exit whatever is running, wait for cleanup, then hide
  const closeEmbeddedTerminal = useCallback(() => {
    if (window.electron) {
      const write = (data: string) =>
        window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
          id: sessionId,
          data,
        });
      // 1. Escape + :q! — exit vi/vim/nvim (Escape exits insert mode, :q! force quits)
      write("\x1B\x1B:q!\r");
      // 2. After brief delay, Ctrl+C x2 + Ctrl+D — exit processes / REPLs
      setTimeout(() => {
        write("\x03\x03");
        setTimeout(() => write("\x04"), 50);
      }, 100);
    }
    // Wait for exit sequences to be processed by the PTY before hiding
    setTimeout(() => setShowEmbeddedTerminal(false), 350);
  }, [sessionId]);

  const wrappedHandleCommand = useCallback(
    async (cmd: string, queueCallback?: any) => {
      const fixed = smartQuotePaths(cmd);
      markSessionDirty(sessionId);
      if (isAgentMode) {
        if (isInteractiveCommand(fixed)) {
          setShowEmbeddedTerminal(true);
          handleCommand(fixed, queueCallback);
        } else {
          await handleCommandInOverlay(fixed, queueCallback);
        }
      } else {
        handleCommand(fixed, queueCallback);
      }
      // Eagerly refresh CWD after directory-changing commands
      if (
        /^\s*(cd|pushd|popd|z|j)\s/i.test(fixed) ||
        /^\s*(cd)\s*$/i.test(fixed)
      ) {
        setTimeout(() => refreshCwd(sessionId), 500);
      }
    },
    [
      isAgentMode,
      markSessionDirty,
      sessionId,
      handleCommand,
      handleCommandInOverlay,
      refreshCwd,
    ],
  );

  const wrappedHandleAgentRun = useCallback(
    async (prompt: string, queueCallback?: any, images?: AttachedImage[]) => {
      markSessionDirty(sessionId);
      await handleAgentRun(prompt, queueCallback, images);
    },
    [
      markSessionDirty,
      sessionId,
      handleAgentRun,
    ],
  );

  const handleSlashCommand = useCallback(
    async (command: string) => {
      if (command === "/clear") {
        resetSession();
        clearInteractions(sessionId);
        window.dispatchEvent(
          new CustomEvent("tron:clearTerminal", { detail: { sessionId } }),
        );
        if (!isOverlayVisible) setIsOverlayVisible(true);
        return;
      }

      if (command === "/log") {
        try {
          // Assemble session metadata (strip secrets)
          const meta: Record<string, unknown> = {
            id: sessionId,
            title: session?.title || "Terminal",
            cwd: session?.cwd,
            provider: session?.aiConfig?.provider,
            model: session?.aiConfig?.model,
          };

          const result = await window.electron.ipcRenderer.saveSessionLog({
            sessionId,
            session: meta,
            interactions: session?.interactions || [],
            agentThread: agentThread.map((s) => ({
              step: s.step,
              output: s.output,
              payload: s.payload,
            })),
            contextSummary: session?.contextSummary,
          });

          if (result.success && result.filePath && result.logId) {
            // Copy file path to clipboard
            try {
              await navigator.clipboard.writeText(result.filePath);
            } catch {
              // Clipboard may not be available
            }

            // Push system step to agent thread
            setAgentThread((prev) => [
              ...prev,
              {
                step: "system",
                output: `Session log saved: **${result.logId}**\n\n${result.filePath}\n\nPath copied to clipboard.`,
              },
            ]);

            // Show overlay if hidden
            if (!isOverlayVisible) setIsOverlayVisible(true);
          } else {
            setAgentThread((prev) => [
              ...prev,
              {
                step: "system",
                output: `Failed to save log: ${result.error || "Unknown error"}`,
              },
            ]);
            if (!isOverlayVisible) setIsOverlayVisible(true);
          }
        } catch (err: any) {
          setAgentThread((prev) => [
            ...prev,
            { step: "system", output: `Error saving log: ${err.message}` },
          ]);
          if (!isOverlayVisible) setIsOverlayVisible(true);
        }
      }
    },
    [
      sessionId,
      session,
      agentThread,
      setAgentThread,
      isOverlayVisible,
      setIsOverlayVisible,
    ],
  );
  // Update refs after function definitions so stable callbacks always call the latest version
  const showConnectToast = useCallback(() => {
    setConnectToast(true);
    clearTimeout(connectToastTimer.current);
    connectToastTimer.current = setTimeout(() => setConnectToast(false), 2500);
  }, []);
  if (isConnectPane) {
    wrappedHandleCommandRef.current = () => showConnectToast();
    wrappedHandleAgentRunRef.current = () => showConnectToast();
    handleSlashCommandRef.current = () => showConnectToast();
  } else {
    wrappedHandleCommandRef.current = wrappedHandleCommand;
    wrappedHandleAgentRunRef.current = wrappedHandleAgentRun;
    handleSlashCommandRef.current = handleSlashCommand;
  }

  const handlePaneFocus = () => {
    setFocusedSession(sessionId);
    if (!isActive) focusSession(sessionId);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isConnectPane || selectionMode) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isConnectPane || isElectronApp() || selectionMode) return;
    longPressTriggered.current = false;
    const touch = e.touches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setContextMenu({ x, y });
    }, 500);
  };
  const handleTouchEnd = () => {
    clearTimeout(longPressTimer.current);
  };
  const handleTouchMove = () => {
    clearTimeout(longPressTimer.current);
  };

  // Read selection from xterm first, fall back to DOM selection (agent overlay, input box)
  const selection = contextMenu
    ? (getTerminalSelection(sessionId) || window.getSelection()?.toString() || "")
    : "";
  const hasSelection = selection.trim().length > 0;

  const isTouch = isTouchDevice();

  // Copy helper — works on both desktop and mobile (fallback to execCommand)
  const copyToClipboard = writeClipboardText;

  const contextMenuItems = [
    // Copy, Paste, Select Text — shown on all devices
    {
      label: "Copy",
      icon: <Copy className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
      action: () => { if (hasSelection) copyToClipboard(selection); },
      disabled: !hasSelection,
    },
    {
      label: "Paste",
      icon: <ClipboardPaste className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
      action: async () => {
          const sendToTerminal = (text: string) => {
            if (text && window.electron) {
              window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, { id: sessionId, data: text });
            }
          };
          const saveImageAndType = async (blob: Blob, filename: string) => {
            const buf = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = ""; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            const ext = filename.split(".").pop() || "png";
            const filePath = await window.electron?.ipcRenderer?.invoke("file.saveTempImage", { base64: btoa(binary), ext });
            if (filePath) sendToTerminal(filePath);
          };

          // 1. Try browser Clipboard API FIRST — must be called immediately
          //    on user gesture (before any await) or the permission is lost.
          //    Supports both text and images.
          try {
            if (navigator.clipboard?.read) {
              const items = await navigator.clipboard.read();
              for (const item of items) {
                // Check for image types
                const imgType = item.types.find((t: string) => t.startsWith("image/"));
                if (imgType) {
                  const blob = await item.getType(imgType);
                  const ext = imgType.split("/")[1]?.replace("jpeg", "jpg") || "png";
                  await saveImageAndType(blob, `paste.${ext}`);
                  return;
                }
                // Check for text
                if (item.types.includes("text/plain")) {
                  const blob = await item.getType("text/plain");
                  const text = await blob.text();
                  if (text) { sendToTerminal(text); return; }
                }
              }
            }
          } catch { /* permission denied or not supported */ }

          // 2. Fallback: try navigator.clipboard.readText() (simpler API, wider support)
          try {
            if (navigator.clipboard?.readText) {
              const text = await navigator.clipboard.readText();
              if (text) { sendToTerminal(text); return; }
            }
          } catch { /* not available */ }

          // 3. Electron-specific: file paths, then image
          if (isElectronApp()) {
            try {
              const paths = await window.electron?.ipcRenderer?.readClipboardFilePaths?.();
              if (paths && paths.length > 0) {
                sendToTerminal(paths.map((p: string) => /\s/.test(p) ? `"${p}"` : p).join(" "));
                return;
              }
            } catch {}
          }

          // 4. Server-side clipboard IPC (reads server's clipboard)
          try {
            const text = await window.electron?.ipcRenderer?.clipboardReadText?.();
            if (text) { sendToTerminal(text); return; }
          } catch {}

          // 5. Server-side clipboard image
          try {
            const base64 = await window.electron?.ipcRenderer?.readClipboardImage?.();
            if (base64) {
              const filePath = await window.electron?.ipcRenderer?.invoke("file.saveTempImage", { base64, ext: "png" });
              if (filePath) { sendToTerminal(filePath); return; }
            }
          } catch {}

          // 6. Last resort (mobile): focused textarea for native paste gesture
          const ta = document.createElement("textarea");
          ta.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:220px;height:40px;z-index:99999;font-size:16px;padding:8px 12px;border:1px solid #555;border-radius:8px;background:#1a1a1a;color:#ccc;outline:none;text-align:center;-webkit-user-select:text;user-select:text";
          ta.placeholder = "Tap here & paste";
          document.body.appendChild(ta);
          ta.focus();
          const cleanup = () => { if (ta.parentNode) ta.remove(); };
          ta.addEventListener("paste", (ev) => {
            // Handle pasted images
            const files = ev.clipboardData?.files;
            if (files && files.length > 0) {
              for (const f of Array.from(files)) {
                if (f.type.startsWith("image/")) {
                  saveImageAndType(f, f.name || `paste.${f.type.split("/")[1] || "png"}`);
                }
              }
              cleanup();
              return;
            }
            setTimeout(() => { if (ta.value) sendToTerminal(ta.value); cleanup(); }, 50);
          });
          ta.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); if (ta.value) sendToTerminal(ta.value); cleanup(); }
            if (ev.key === "Escape") cleanup();
          });
          setTimeout(cleanup, 10000);
        },
      },
      {
        label: "Find",
        icon: <Search className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
        action: () => {
          window.dispatchEvent(new CustomEvent("tron:terminalSearch", { detail: { sessionId } }));
        },
      },
      { separator: true as const },
      {
        label: "Ask Agent",
        icon: <Bot className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
        action: () => { if (hasSelection) stableOnRunAgent(selection); },
        disabled: !hasSelection,
      },
      {
        label: "Add to Input",
        icon: <TextCursorInput className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
        action: () => {
          if (hasSelection) {
            window.dispatchEvent(new CustomEvent("tron:addToInput", { detail: { sessionId, text: selection } }));
          }
        },
        disabled: !hasSelection,
      },
      // Touch-only: quick copy + line selection mode
      ...(isTouch ? [
        { separator: true as const },
        {
          label: "Copy Screen",
          icon: <Copy className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
          action: () => {
            const content = readScreenBuffer(sessionId, 200);
            if (content) copyToClipboard(content);
          },
        },
        {
          label: "Select Text",
          icon: <TextSelect className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
          action: () => setSelectionMode(true),
        },
      ] : []),
      { separator: true as const },
    {
      label: "Split Horizontal",
      icon: <Columns2 className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
      action: () => { focusSession(sessionId); splitUserAction("horizontal"); },
    },
    {
      label: "Split Vertical",
      icon: <Rows2 className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
      action: () => { focusSession(sessionId); splitUserAction("vertical"); },
    },
    {
      label: "Split With…",
      icon: <SquareSplitHorizontal className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
      action: () => {
        focusSession(sessionId);
        window.dispatchEvent(new CustomEvent("tron:openCommandPalette", { detail: { query: "split with" } }));
      },
    },
    ...(canMaximize || isMaximized ? [{
      label: isMaximized ? "Restore Pane" : "Maximize Pane",
      icon: isMaximized
        ? <Minimize2 className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />
        : <Maximize2 className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
      action: () => { focusSession(sessionId); toggleMaximizePane(sessionId); },
    }] : []),
    { separator: true as const },
    {
      label: "Close Pane",
      icon: <X className="h-3.5 w-3.5 opacity-60" strokeWidth={1.5} />,
      action: () => closePane(sessionId),
      danger: true,
    },
  ];

  return (
    <div
      ref={paneRootRef}
      onMouseDown={handlePaneFocus}
      onFocusCapture={() => setFocusedSession(sessionId)}
      className={`group/pane relative flex h-full w-full flex-col border border-transparent ${isActive ? "z-10" : "opacity-80 hover:opacity-100"}`}
    >
      {/* Server disconnected overlay — shown when tabs are restored offline */}
      {serverDisconnected && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70">
          <div className={`flex flex-col items-center gap-3 rounded-xl px-8 py-6 ${themeClass(resolvedTheme, {
            dark: "bg-gray-900/90 border border-white/10",
            modern: "bg-gray-900/90 border border-white/10",
            light: "bg-white/95 border border-gray-200 shadow-lg",
          })}`}>
            <div className={`text-sm font-medium ${resolvedTheme === "light" ? "text-gray-700" : "text-gray-200"}`}>
              Server Disconnected
            </div>
            <div className={`text-xs ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
              Reconnecting automatically...
            </div>
            <div className="flex gap-1">
              {[0, 150, 300].map((d) => (
                <div
                  key={d}
                  className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      {/* Shell-exited overlay — the pane's process died mid-session. Without
          this the pane silently ignores all input (no PTY behind it). */}
      {session?.exited != null && !serverDisconnected && !isConnectPane && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
          <div className={`flex flex-col items-center gap-3 rounded-xl px-8 py-6 ${themeClass(resolvedTheme, {
            dark: "bg-gray-900/90 border border-white/10",
            modern: "bg-gray-900/90 border border-white/10",
            light: "bg-white/95 border border-gray-200 shadow-lg",
          })}`}>
            <div className={`text-sm font-medium ${resolvedTheme === "light" ? "text-gray-700" : "text-gray-200"}`}>
              Shell exited{session.exited !== 0 ? ` (code ${session.exited})` : ""}
            </div>
            <div className={`text-xs ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
              The process behind this pane ended. Scrollback is preserved.
            </div>
            <button
              onClick={() => restartShell(sessionId)}
              className={`cursor-pointer rounded-lg px-5 py-2 text-sm font-medium transition-colors ${themeClass(resolvedTheme, {
                dark: "bg-blue-500 text-white hover:bg-blue-600",
                modern: "bg-blue-500 text-white hover:bg-blue-600",
                light: "bg-blue-600 text-white hover:bg-blue-700",
              })}`}
            >
              Restart Shell
            </button>
          </div>
        </div>
      )}
      {isAgentMode ? (
        <>
          {/* Agent View Mode: info header + full-height overlay */}
          <div
            className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 ${themeClass(
              resolvedTheme,
              {
                dark: "border-white/5 bg-[#0a0a0a]",
                modern: "border-white/[0.08] bg-white/[0.04] backdrop-blur-2xl backdrop-saturate-150",
                light: "border-gray-200 bg-gray-50",
              },
            )}`}
          >
            {isSSH && (
              <SSHStatusBadge
                status={sshStatus}
                label={session?.title || "SSH"}
                resolvedTheme={resolvedTheme}
                onReconnect={() => reconnectSSH(sessionId)}
              />
            )}
            {!isSSH && session?.remoteUrl && (
              <span className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${themeClass(resolvedTheme, {
                dark: "bg-blue-500/15 text-blue-300",
                modern: "bg-blue-500/20 text-blue-300",
                light: "bg-blue-100 text-blue-600",
              })}`}>
                <Monitor className="h-2.5 w-2.5" />
                Remote
              </span>
            )}
            {!isSSH && !session?.remoteUrl && (
              <Folder
                className={`h-3 w-3 shrink-0 ${themeClass(resolvedTheme, {
                  dark: "text-gray-500",
                  modern: "text-gray-400",
                  light: "text-gray-400",
                })}`}
              />
            )}
            <span
              className={`truncate font-mono text-[11px] ${themeClass(resolvedTheme, {
                dark: "text-gray-400",
                modern: "text-gray-300",
                light: "text-gray-500",
              })}`}
            >
              {isSSH
                ? session?.cwd || "~"
                : abbreviateHome(session?.cwd || "~")}
            </span>
            {(canMaximize || isMaximized) && (
              <button
                onClick={() => toggleMaximizePane(sessionId)}
                title={maximizeTitle}
                aria-label={maximizeTitle}
                className="ml-auto shrink-0 opacity-60 transition-opacity hover:opacity-100"
              >
                {isMaximized
                  ? <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  : <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.5} />}
              </button>
            )}
          </div>

          {/* AgentOverlay — full height, always expanded */}
          <AgentOverlay
            isThinking={isThinking}
            isAgentRunning={isAgentRunning}
            agentThread={agentThread}
            pendingCommand={pendingCommand}
            autoExecuteEnabled={alwaysAllowSession}
            onToggleAutoExecute={() =>
              setAlwaysAllowSession(!alwaysAllowSession)
            }
            thinkingEnabled={thinkingEnabled}
            onToggleThinking={() => setThinkingEnabled(!thinkingEnabled)}
            onClose={() => {}}
            onClear={() => resetSession()}
            onPermission={handlePermission}
            isExpanded={true}
            onExpand={() => {}}
            onRunAgent={(prompt, images) =>
              wrappedHandleAgentRun(prompt, queueItem as any, images)
            }
            modelCapabilities={modelCapabilities}
            fullHeight
            scrollPosition={scrollPosition}
            onScrollPositionChange={setScrollPosition}
          />

          {/* Embedded terminal — shown when user runs a command in agent mode */}
          <AnimatePresence>
            {showEmbeddedTerminal && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "40%", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                onContextMenu={handleContextMenu}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
                onTouchMove={handleTouchMove}
                className={`relative shrink-0 border-t ${themeClass(
                  resolvedTheme,
                  {
                    dark: "border-white/10",
                    modern: "border-white/10",
                    light: "border-gray-300",
                  },
                )}`}
              >
                {/* Header bar with close button */}
                <div
                  className={`absolute top-0 right-0 z-10 flex items-center gap-1 px-2 py-1`}
                >
                  <button
                    onClick={closeEmbeddedTerminal}
                    className={`rounded p-1 transition-colors ${themeClass(
                      resolvedTheme,
                      {
                        dark: "text-gray-400 hover:bg-white/10 hover:text-white",
                        modern:
                          "text-gray-400 hover:bg-white/10 hover:text-white",
                        light:
                          "text-gray-500 hover:bg-gray-200 hover:text-gray-800",
                      },
                    )}`}
                    title="Close terminal (sends Ctrl+C)"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <Terminal
                  className="h-full w-full"
                  sessionId={sessionId}
                  onActivity={stableOnActivity}
                  onFirstCommand={stableOnFirstCommand}
                  isActive={isActive}
                  isAgentRunning={isAgentRunning}
                  stopAgent={stableStopAgent}
                  focusTarget={focusTarget}
                  isReconnected={session?.reconnected}
                  pendingHistory={session?.pendingHistory}
                  onScrolledUpChange={stableOnScrolledUpChange}
                  selectionMode={selectionMode}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* TUI key toolbar — touch devices, agent mode */}
          <AnimatePresence>
            {showTuiToolbar && <TuiKeyToolbar sessionId={sessionId} />}
          </AnimatePresence>
        </>
      ) : (
        /* Terminal View Mode: terminal + overlay share remaining space above input */
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className="relative min-h-0 flex-1"
            onMouseDown={() => setFocusTarget("terminal")}
            onContextMenu={handleContextMenu}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchMove={handleTouchMove}
          >
            {isConnectPane ? (
              <div
                className={`flex h-full w-full flex-col items-center justify-center gap-5 ${themeClass(
                  resolvedTheme,
                  {
                    dark: "bg-[#0d0d0d]",
                    modern: "bg-[#0a0e18]/70 backdrop-blur-xl backdrop-saturate-150",
                    light: "bg-white",
                  },
                )}`}
              >
                <img
                  src={logoSvg}
                  alt="Tron"
                  className="h-12 w-12 opacity-50"
                />
                <button
                  onClick={() => setShowSSHModal(true)}
                  className={`cursor-pointer rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${themeClass(
                    resolvedTheme,
                    {
                      dark: "bg-blue-500 text-white hover:bg-blue-600",
                      modern: "bg-blue-500 text-white hover:bg-blue-600",
                      light: "bg-blue-600 text-white hover:bg-blue-700",
                    },
                  )}`}
                >
                  New Connection
                </button>
                {/* Toast */}
                <AnimatePresence>
                  {connectToast && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className={`absolute top-4 left-1/2 -translate-x-1/2 rounded-lg px-4 py-2 text-xs font-medium shadow-lg ${themeClass(
                        resolvedTheme,
                        {
                          dark: "bg-yellow-500/90 text-black",
                          modern: "bg-yellow-500/90 text-black",
                          light: "bg-yellow-500 text-black",
                        },
                      )}`}
                    >
                      Connect to a server first
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <Terminal
                className="h-full w-full"
                sessionId={sessionId}
                onActivity={stableOnActivity}
                onFirstCommand={stableOnFirstCommand}
                isActive={isActive}
                isAgentRunning={isAgentRunning}
                stopAgent={stableStopAgent}
                focusTarget={focusTarget}
                isReconnected={session?.reconnected}
                onScrolledUpChange={stableOnScrolledUpChange}
                selectionMode={selectionMode}
              />
            )}
            {/* Selection mode: native text overlay for browser-native selection */}
            {selectionMode && (
              <>
                <pre
                  className={`absolute inset-0 z-20 overflow-hidden whitespace-pre font-mono text-[14px] leading-[16.8px] p-0 m-0 ${themeClass(resolvedTheme, {
                    dark: "bg-[#0a0a0a] text-gray-200",
                    modern: "bg-[#05080f] text-gray-200",
                    light: "bg-[#f9fafb] text-gray-800",
                  })}`}
                  style={{ userSelect: "text", WebkitUserSelect: "text", touchAction: "auto" }}
                >
                  {selectionText}
                </pre>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-30">
                  <button
                    onClick={() => setSelectionMode(false)}
                    className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-medium shadow-lg ${themeClass(
                      resolvedTheme,
                      {
                        dark: "bg-gray-800/90 hover:bg-gray-700/90 text-gray-200 border border-gray-600/50",
                        modern: "bg-gray-900/90 hover:bg-gray-800/90 text-gray-200 border border-white/10",
                        light: "bg-white/90 hover:bg-gray-100/90 text-gray-700 border border-gray-300",
                      },
                    )}`}
                  >
                    <Check className="h-3 w-3" /> Done
                  </button>
                </div>
              </>
            )}
            {/* Scroll to bottom button */}
            {termScrolledUp && !selectionMode && (
              <button
                onClick={scrollTermToBottom}
                className={`absolute bottom-2 left-1/2 -translate-x-1/2 z-20 px-4 py-1 rounded-full text-[11px] font-medium shadow-lg transition-opacity ${themeClass(
                  resolvedTheme,
                  {
                    dark: "bg-gray-800/90 hover:bg-gray-700/90 text-gray-200 border border-gray-600/50",
                    modern: "bg-gray-900/90 hover:bg-gray-800/90 text-gray-200 border border-white/10",
                    light: "bg-white/90 hover:bg-gray-100/90 text-gray-700 border border-gray-300",
                  },
                )}`}
              >
                ↓ Scroll to bottom
              </button>
            )}
            {/* Maximize / restore pane — hover chrome, always visible while maximized */}
            {(canMaximize || isMaximized) && !selectionMode && !isConnectPane && (
              <button
                onClick={() => toggleMaximizePane(sessionId)}
                title={maximizeTitle}
                aria-label={maximizeTitle}
                className={`absolute top-2 right-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border shadow-lg transition-opacity ${
                  isMaximized ? "opacity-80" : "opacity-0 group-hover/pane:opacity-80 focus-visible:opacity-80"
                } hover:opacity-100 ${themeClass(resolvedTheme, {
                  dark: "bg-gray-800/90 hover:bg-gray-700/90 text-gray-200 border-gray-600/50",
                  modern: "bg-gray-900/90 hover:bg-gray-800/90 text-gray-200 border-white/10",
                  light: "bg-white/90 hover:bg-gray-100/90 text-gray-700 border-gray-300",
                })}`}
              >
                {isMaximized
                  ? <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  : <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.5} />}
              </button>
            )}
          </div>

          {/* TUI key toolbar — touch devices, terminal mode (above agent overlay) */}
          <AnimatePresence>
            {showTuiToolbar && <TuiKeyToolbar sessionId={sessionId} />}
          </AnimatePresence>

          {/* Agent Overlay — in flex flow so terminal shrinks to fit */}
          <AnimatePresence>
            {(isOverlayVisible || isAgentRunning) && (
              <AgentOverlay
                isThinking={isThinking}
                isAgentRunning={isAgentRunning}
                agentThread={agentThread}
                pendingCommand={pendingCommand}
                autoExecuteEnabled={alwaysAllowSession}
                onToggleAutoExecute={() =>
                  setAlwaysAllowSession(!alwaysAllowSession)
                }
                thinkingEnabled={thinkingEnabled}
                onToggleThinking={() => setThinkingEnabled(!thinkingEnabled)}
                onClose={() => setIsOverlayVisible(false)}
                onClear={() => resetSession()}
                onPermission={handlePermission}
                isExpanded={isOverlayVisible}
                onExpand={() => setIsOverlayVisible(true)}
                onRunAgent={(prompt) =>
                  wrappedHandleAgentRun(prompt, queueItem as any)
                }
                modelCapabilities={modelCapabilities}
                overlayHeight={overlayHeight}
                onResizeHeight={setOverlayHeight}
                scrollPosition={scrollPosition}
                onScrollPositionChange={setScrollPosition}
              />
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Queued prompts — list above the input (drag to reorder, click to edit) */}
      <AnimatePresence>
        {inputQueue.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className={`px-3 pb-1 pt-1.5 ${themeClass(resolvedTheme, {
              dark: "bg-[#0a0a0a] text-gray-400",
              modern: "bg-[#070b14]/70 text-gray-300 backdrop-blur-xl backdrop-saturate-150",
              light: "bg-gray-50 text-gray-500",
            })}`}>
              <div className="flex items-center gap-2 pb-1">
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider opacity-40">
                  Queued · {inputQueue.length}
                </span>
                {queuePaused && (
                  <button
                    onClick={() => {
                      setQueuePaused(false);
                      setDrainNonce((n) => n + 1);
                    }}
                    title="Queue paused after manual stop — click to resume"
                    className="flex shrink-0 items-center gap-1 rounded-full bg-amber-400/10 px-2 py-px text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-400/20"
                  >
                    <Play className="h-2.5 w-2.5" />
                    paused — resume
                  </button>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => setInputQueue([])}
                  title="Clear queue"
                  className="shrink-0 text-[10px] uppercase tracking-wide opacity-30 transition-opacity hover:opacity-80"
                >
                  clear
                </button>
              </div>
              <Reorder.Group
                axis="y"
                values={inputQueue}
                onReorder={setInputQueue}
                className="flex flex-col gap-px"
              >
                {inputQueue.map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    resolvedTheme={resolvedTheme}
                    isAgentRunning={isAgentRunning}
                    editing={editingQueueId === item.id}
                    onStartEdit={() => setEditingQueueId(item.id)}
                    onSaveEdit={(text) => {
                      setEditingQueueId(null);
                      const trimmed = text.trim();
                      setInputQueue((prev) =>
                        trimmed || item.images?.length
                          ? prev.map((it) => (it.id === item.id ? { ...it, content: trimmed } : it))
                          : prev.filter((it) => it.id !== item.id),
                      );
                    }}
                    onCancelEdit={() => setEditingQueueId(null)}
                    onDelete={() => setInputQueue((prev) => prev.filter((it) => it.id !== item.id))}
                    onSteer={() => {
                      setInputQueue((prev) => prev.filter((it) => it.id !== item.id));
                      steerText(item.content);
                    }}
                  />
                ))}
              </Reorder.Group>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`relative shrink-0 ${(chromeVisible.input || chromeVisible.hints) ? "border-t p-2" : ""} ${pendingCommand ? "z-0" : "z-20"} ${themeClass(
          resolvedTheme,
          {
            dark: "border-white/5 bg-[#0a0a0a]",
            modern: "border-white/[0.08] bg-[#070b14]/70 backdrop-blur-xl backdrop-saturate-150",
            light: "border-gray-200 bg-gray-50",
          },
        )}`}
      >
        <SmartInput
          onSend={stableOnSend}
          onRunAgent={stableOnRunAgent}
          isAgentRunning={isAgentRunning}
          pendingCommand={pendingCommand}
          sessionId={sessionId}
          modelCapabilities={modelCapabilities}
          sessionAIConfig={session?.aiConfig}
          defaultAgentMode={isAgentMode}
          draftInput={draftInput}
          onDraftChange={stableSetDraftInput}
          onSlashCommand={stableSlashCommand}
          onSteer={steerText}
          queuedCount={inputQueue.length}
          onPopQueued={popQueuedForEdit}
          stopAgent={stableStopAgent}
          thinkingEnabled={thinkingEnabled}
          setThinkingEnabled={stableSetThinkingEnabled}
          activeSessionId={activeSessionId}
          awaitingAnswer={awaitingAnswer}
          focusTarget={focusTarget}
          onFocusInput={() => setFocusTarget("input")}
          noModelConfigured={noModelConfigured}
          onNoModel={stableHandleNoModel}
          inputVisible={chromeVisible.input}
          hintsVisible={chromeVisible.hints}
          onToggleRegion={stableToggleChrome}
        />
      </div>
      <Collapsible visible={chromeVisible.footer}>
        <div className="relative z-30 shrink-0">
          <ContextBar
            sessionId={sessionId}
            hasAgentThread={agentThread.length > 0}
            isOverlayVisible={isOverlayVisible}
            onShowOverlay={() => setIsOverlayVisible(true)}
            onHide={() => stableToggleChrome("footer")}
          />
        </div>
      </Collapsible>
      {/* Restore strip — appears when any chrome region is hidden. A slim
          hover-expand bar that brings everything back (also via hotkeys). */}
      {chromeAnyHidden && (
        <button
          type="button"
          onClick={showAllChrome}
          title="Show hidden panel areas"
          className={`group/restore relative flex h-1.5 w-full shrink-0 items-center justify-center overflow-hidden transition-all duration-200 hover:h-5 ${themeClass(
            resolvedTheme,
            {
              dark: "bg-white/[0.03] hover:bg-white/[0.06] text-gray-500",
              modern: "bg-white/[0.03] hover:bg-white/[0.07] backdrop-blur-xl text-gray-400",
              light: "bg-gray-100 hover:bg-gray-200 text-gray-500",
            },
          )}`}
        >
          <span className="flex items-center gap-1 text-[11px] opacity-0 transition-opacity duration-200 group-hover/restore:opacity-100">
            <ChevronUp className="h-2.5 w-2.5" />
            show panel
          </span>
        </button>
      )}

      {isConnectPane && (
        <SSHConnectModal
          show={showSSHModal}
          resolvedTheme={resolvedTheme}
          onConnect={async (config) => {
            await createSSHTab(config);
            setShowSSHModal(false);
          }}
          onClose={() => setShowSSHModal(false)}
        />
      )}

      {/* No-model toast */}
      <AnimatePresence>
        {modelToast && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className={`absolute bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-xs font-medium shadow-lg ${themeClass(
              resolvedTheme,
              {
                dark: "border border-white/10 bg-[#1e1e1e]/95 text-gray-200",
                modern: "border border-white/10 bg-[#172033] text-gray-200",
                light: "border border-gray-200 bg-white/95 text-gray-700",
              },
            )}`}
          >
            No AI model configured.{" "}
            <button
              className="cursor-pointer font-semibold underline hover:opacity-80"
              onClick={() => {
                setModelToast(false);
                openSettingsTabRef.current();
              }}
            >
              Settings
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pane context menu (right-click / long-press) — Radix Popover with virtual anchor */}
      <Popover.Root
        open={!!contextMenu}
        onOpenChange={(open) => { if (!open) setContextMenu(null); }}
      >
        <Popover.Anchor virtualRef={anchorRef as any} />
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className={`tron-pop z-[100] min-w-[160px] overflow-hidden rounded-xl p-1 shadow-xl ${themeClass(
              resolvedTheme,
              {
                dark: "border border-white/10 bg-[#1e1e1e] text-gray-200",
                modern: "border border-white/[0.12] bg-[#172033] text-white",
                light: "border border-black/[0.08] bg-white text-gray-800",
              },
            )}`}
            onContextMenu={(e) => e.preventDefault()}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {contextMenuItems.map((item, i) =>
              "separator" in item ? (
                <div
                  key={i}
                  className={`my-1 h-px ${resolvedTheme === "light" ? "bg-black/[0.06]" : "bg-white/[0.08]"}`}
                />
              ) : (
                <button
                  key={i}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                    item.disabled
                      ? "opacity-40 cursor-default pointer-events-none"
                      : item.danger
                        ? resolvedTheme === "light"
                          ? "cursor-pointer text-red-500 hover:bg-red-500/10"
                          : "cursor-pointer text-red-400 hover:bg-red-500/10"
                        : resolvedTheme === "light"
                          ? "cursor-pointer hover:bg-black/[0.05]"
                          : "cursor-pointer hover:bg-white/10"
                  }`}
                  onClick={() => {
                    item.action();
                    setContextMenu(null);
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              ),
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
};

export default TerminalPane;
