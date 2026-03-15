import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { X, Bot, ChevronRight, Folder, Columns2, Rows2, Copy, ClipboardPaste, TextCursorInput, TextSelect, Check, Monitor, Search } from "lucide-react";
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
import { useHotkey } from "../../hooks/useHotkey";
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

interface TerminalPaneProps {
  sessionId: string;
}

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
    refreshCwd,
    splitUserAction,
    closePane,
    serverDisconnected,
  } = useLayout();
  const { resolvedTheme, viewMode } = useTheme();
  const isAgentMode = viewMode === "agent";
  const isActive = sessionId === activeSessionId;
  const session = sessions.get(sessionId);
  const isConnectPane = sessionId.startsWith("ssh-connect");
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
  const stableOnFirstCommand = useCallback(() => {
    if (firstCommandFired.current) return;
    firstCommandFired.current = true;
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
        // Re-check tab still has default title
        const recheckTab = tabsRef.current.find(
          (t) => t.activeSessionId === sessionId,
        );
        if (recheckTab && recheckTab.title === "Terminal") {
          renameTabRef.current(sessionId, name);
        }
      } catch {
        // Non-critical, silently ignore
      }
    }, 60000);
    return () => clearTimeout(timer);
  }, [sessionId]);

  // Input Queue
  const [inputQueue, setInputQueue] = useState<
    Array<{ type: "command" | "agent"; content: string }>
  >([]);

  // Stable ref for queueItem so stableOnRunAgent can use it
  const queueItemRef = useRef<
    (item: { type: "command" | "agent"; content: string }) => void
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

  // Process Queue Effect
  useEffect(() => {
    if (!isAgentRunning && inputQueue.length > 0) {
      const nextItem = inputQueue[0];
      setInputQueue((prev) => prev.slice(1));

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
      } else {
        handleAgentRun(nextItem.content);
      }
    }
  }, [
    isAgentRunning,
    inputQueue,
    handleCommand,
    handleCommandInOverlay,
    handleAgentRun,
    isAgentMode,
  ]);

  const queueItem = (item: { type: "command" | "agent"; content: string }) => {
    setInputQueue((prev) => [...prev, item]);
  };
  queueItemRef.current = queueItem;

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
  const copyToClipboard = (text: string) => {
    const deviceCopy = (t: string) => {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.focus({ preventScroll: true });
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignored */ }
      ta.remove();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => deviceCopy(text));
    } else {
      deviceCopy(text);
    }
  };

  const contextMenuItems = [
    // Copy, Paste, Select Text — shown on all devices
    {
      label: "Copy",
      icon: <Copy className="h-3.5 w-3.5" />,
      action: () => { if (hasSelection) copyToClipboard(selection); },
      disabled: !hasSelection,
    },
    {
      label: "Paste",
      icon: <ClipboardPaste className="h-3.5 w-3.5" />,
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
        icon: <Search className="h-3.5 w-3.5" />,
        action: () => {
          window.dispatchEvent(new CustomEvent("tron:terminalSearch", { detail: { sessionId } }));
        },
      },
      { separator: true as const },
      {
        label: "Ask Agent",
        icon: <Bot className="h-3.5 w-3.5" />,
        action: () => { if (hasSelection) stableOnRunAgent(selection); },
        disabled: !hasSelection,
      },
      {
        label: "Add to Input",
        icon: <TextCursorInput className="h-3.5 w-3.5" />,
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
          icon: <Copy className="h-3.5 w-3.5" />,
          action: () => {
            const content = readScreenBuffer(sessionId, 200);
            if (content) copyToClipboard(content);
          },
        },
        {
          label: "Select Text",
          icon: <TextSelect className="h-3.5 w-3.5" />,
          action: () => setSelectionMode(true),
        },
      ] : []),
      { separator: true as const },
    {
      label: "Split Horizontal",
      icon: <Columns2 className="h-3.5 w-3.5" />,
      action: () => { focusSession(sessionId); splitUserAction("horizontal"); },
    },
    {
      label: "Split Vertical",
      icon: <Rows2 className="h-3.5 w-3.5" />,
      action: () => { focusSession(sessionId); splitUserAction("vertical"); },
    },
    { separator: true as const },
    {
      label: "Close Pane",
      icon: <X className="h-3.5 w-3.5" />,
      action: () => closePane(sessionId),
      danger: true,
    },
  ];

  return (
    <div
      onMouseDown={handlePaneFocus}
      className={`relative flex h-full w-full flex-col border border-transparent ${isActive ? "z-10 ring-1 ring-purple-500/50" : "opacity-80 hover:opacity-100"}`}
    >
      {/* Server disconnected overlay — shown when tabs are restored offline */}
      {serverDisconnected && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70">
          <div className={`flex flex-col items-center gap-3 rounded-xl px-8 py-6 ${themeClass(resolvedTheme, {
            dark: "bg-gray-900/90 border border-white/10",
            modern: "bg-gray-900/80 border border-white/10 backdrop-blur-sm",
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
                  className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </div>
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
                modern: "border-white/6 bg-white/[0.02] backdrop-blur-2xl",
                light: "border-gray-200 bg-gray-50",
              },
            )}`}
          >
            {isSSH && (
              <SSHStatusBadge
                status={sshStatus}
                label={session?.title || "SSH"}
                resolvedTheme={resolvedTheme}
              />
            )}
            {!isSSH && session?.remoteUrl && (
              <span className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider ${themeClass(resolvedTheme, {
                dark: "bg-purple-500/15 text-purple-300",
                modern: "bg-purple-500/20 text-purple-200",
                light: "bg-purple-100 text-purple-600",
              })}`}>
                <Monitor className="h-2.5 w-2.5" />
                Remote
              </span>
            )}
            {!isSSH && !session?.remoteUrl && (
              <Folder
                className={`h-3 w-3 shrink-0 ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`}
              />
            )}
            <span
              className={`truncate font-mono text-[11px] ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}
            >
              {isSSH
                ? session?.cwd || "~"
                : abbreviateHome(session?.cwd || "~")}
            </span>
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
                    modern: "bg-[#08081a]",
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
                      dark: "bg-purple-600/80 text-white hover:bg-purple-600",
                      modern: "bg-purple-500/70 text-white hover:bg-purple-500",
                      light: "bg-purple-600 text-white hover:bg-purple-500",
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
                    modern: "bg-[#040414] text-gray-200",
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
                        modern: "bg-gray-900/90 hover:bg-gray-800/90 text-gray-200 border border-purple-500/30",
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
                className={`absolute bottom-2 left-1/2 -translate-x-1/2 z-20 px-4 py-1 rounded-full text-[10px] font-medium shadow-lg transition-opacity ${themeClass(
                  resolvedTheme,
                  {
                    dark: "bg-gray-800/90 hover:bg-gray-700/90 text-gray-200 border border-gray-600/50",
                    modern: "bg-gray-900/90 hover:bg-gray-800/90 text-gray-200 border border-purple-500/30",
                    light: "bg-white/90 hover:bg-gray-100/90 text-gray-700 border border-gray-300",
                  },
                )}`}
              >
                ↓ Scroll to bottom
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

      {/* Queue display */}
      <AnimatePresence>
        {inputQueue.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className={`flex flex-wrap items-center gap-1.5 px-3 py-1 ${themeClass(resolvedTheme, {
              dark: "bg-[#0a0a0a]",
              modern: "bg-[#060618]",
              light: "bg-gray-50",
            })}`}>
              <span
                className={`shrink-0 text-[10px] font-medium opacity-40`}
              >
                queued
              </span>
              {inputQueue.map((item, i) => (
                <div
                  key={i}
                  className={`flex max-w-[220px] items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ${themeClass(
                    resolvedTheme,
                    {
                      dark: "bg-white/[0.04] text-gray-400",
                      modern: item.type === "agent"
                        ? "bg-purple-500/8 text-purple-300/80"
                        : "bg-white/[0.04] text-gray-400",
                      light: item.type === "agent"
                        ? "bg-purple-50 text-purple-600"
                        : "bg-gray-100 text-gray-500",
                    },
                  )}`}
                >
                  {item.type === "agent" ? (
                    <Bot className="h-2.5 w-2.5 shrink-0 opacity-50" />
                  ) : (
                    <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-50" />
                  )}
                  <span
                    className="cursor-pointer truncate opacity-80 hover:opacity-100"
                    onClick={() => {
                      setInputQueue((prev) =>
                        prev.filter((_, idx) => idx !== i),
                      );
                      window.dispatchEvent(
                        new CustomEvent("tron:editQueueItem", {
                          detail: {
                            sessionId,
                            text: item.content,
                            type: item.type,
                          },
                        }),
                      );
                    }}
                    title="Click to edit"
                  >
                    {item.content}
                  </span>
                  <button
                    onClick={() =>
                      setInputQueue((prev) =>
                        prev.filter((_, idx) => idx !== i),
                      )
                    }
                    className="shrink-0 opacity-30 transition-opacity hover:opacity-80"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`relative shrink-0 border-t p-2 ${pendingCommand ? "z-0" : "z-20"} ${themeClass(
          resolvedTheme,
          {
            dark: "border-white/5 bg-[#0a0a0a]",
            modern: "border-white/6 bg-[#060618]",
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
          stopAgent={stableStopAgent}
          thinkingEnabled={thinkingEnabled}
          setThinkingEnabled={stableSetThinkingEnabled}
          activeSessionId={activeSessionId}
          awaitingAnswer={awaitingAnswer}
          focusTarget={focusTarget}
          onFocusInput={() => setFocusTarget("input")}
          noModelConfigured={noModelConfigured}
          onNoModel={stableHandleNoModel}
        />
      </div>
      <div className="relative z-30 shrink-0">
        <ContextBar
          sessionId={sessionId}
          hasAgentThread={agentThread.length > 0}
          isOverlayVisible={isOverlayVisible}
          onShowOverlay={() => setIsOverlayVisible(true)}
        />
      </div>

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
                dark: "border border-gray-600 bg-gray-800/95 text-gray-200",
                modern: "border border-white/10 bg-[#1a1a3e]/95 text-gray-200",
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
            className={`z-[100] min-w-[160px] overflow-hidden rounded-lg py-1 shadow-xl ${themeClass(
              resolvedTheme,
              {
                dark: "border border-white/10 bg-[#1e1e1e] text-gray-200",
                modern: "border border-white/[0.15] bg-[#1a1a3e]/95 text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
                light: "border border-gray-200 bg-white text-gray-800 shadow-xl",
              },
            )}`}
            onContextMenu={(e) => e.preventDefault()}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {contextMenuItems.map((item, i) =>
              "separator" in item ? (
                <div
                  key={i}
                  className={`my-1 h-px ${resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"}`}
                />
              ) : (
                <button
                  key={i}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                    item.disabled
                      ? "opacity-40 cursor-default pointer-events-none"
                      : item.danger
                        ? resolvedTheme === "light"
                          ? "cursor-pointer text-red-600 hover:bg-red-50"
                          : "cursor-pointer text-red-400 hover:bg-red-500/10"
                        : resolvedTheme === "light"
                          ? "cursor-pointer hover:bg-gray-100"
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
