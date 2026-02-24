import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Bot, ChevronRight, Folder } from "lucide-react";
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
import { isInteractiveCommand, smartQuotePaths } from "../../utils/commandClassifier";
import { IPC } from "../../constants/ipc";
import { abbreviateHome, isTouchDevice } from "../../utils/platform";
import type { AttachedImage, SSHConnectionStatus } from "../../types";
import SSHStatusBadge from "../../features/ssh/components/SSHStatusBadge";
import TuiKeyToolbar from "../../features/terminal/components/TuiKeyToolbar";
import { useAllConfiguredModels } from "../../hooks/useModels";

interface TerminalPaneProps {
  sessionId: string;
}

const TerminalPane: React.FC<TerminalPaneProps> = ({ sessionId }) => {
  const { activeSessionId, sessions, markSessionDirty, focusSession, clearInteractions, createSSHTab, openSettingsTab } =
    useLayout();
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

  const { stopAgent: stopAgentRaw, resetSession, overlayHeight, setOverlayHeight, draftInput, setDraftInput, setAgentThread, focusTarget, setFocusTarget, scrollPosition, setScrollPosition } = useAgent(sessionId);

  // Stable refs for SmartInput memo
  const stopAgentRef = useRef(stopAgentRaw);
  stopAgentRef.current = stopAgentRaw;
  const stableStopAgent = useCallback(() => stopAgentRef.current(), []);

  const setThinkingEnabledRef = useRef(setThinkingEnabled);
  setThinkingEnabledRef.current = setThinkingEnabled;
  const stableSetThinkingEnabled = useCallback((v: boolean) => setThinkingEnabledRef.current(v), []);

  const setDraftInputRef = useRef(setDraftInput);
  setDraftInputRef.current = setDraftInput;
  const stableSetDraftInput = useCallback((v: string | undefined) => setDraftInputRef.current(v), []);

  // Stable callback refs for SmartInput memo (assigned after functions are defined below)
  const wrappedHandleCommandRef = useRef<(cmd: string) => void>(() => { });
  const wrappedHandleAgentRunRef = useRef<(prompt: string, queueCallback?: any, images?: AttachedImage[]) => void>(() => { });
  const handleSlashCommandRef = useRef<(cmd: string) => void>(() => { });
  const stableOnSend = useCallback((cmd: string) => wrappedHandleCommandRef.current(cmd), []);
  const stableOnRunAgent = useCallback(async (prompt: string, images?: AttachedImage[]) => wrappedHandleAgentRunRef.current(prompt, (item: any) => queueItemRef.current(item), images), []);
  const stableSlashCommand = useCallback((cmd: string) => handleSlashCommandRef.current(cmd), []);

  // No-model toast handler
  const openSettingsTabRef = useRef(openSettingsTab);
  openSettingsTabRef.current = openSettingsTab;
  const stableHandleNoModel = useCallback(() => {
    setModelToast(true);
    if (modelToastTimer.current) clearTimeout(modelToastTimer.current);
    modelToastTimer.current = setTimeout(() => setModelToast(false), 6000);
  }, []);

  // Stable callback for Terminal memo
  const markSessionDirtyRef = useRef(markSessionDirty);
  markSessionDirtyRef.current = markSessionDirty;
  const stableOnActivity = useCallback(() => markSessionDirtyRef.current(sessionId), [sessionId]);

  // Input Queue
  const [inputQueue, setInputQueue] = useState<
    Array<{ type: "command" | "agent"; content: string }>
  >([]);

  // Stable ref for queueItem so stableOnRunAgent can use it
  const queueItemRef = useRef<(item: { type: "command" | "agent"; content: string }) => void>(() => { });

  // SSH status tracking
  const isSSH = !!session?.sshProfileId;
  const [sshStatus, setSshStatus] = useState<SSHConnectionStatus>(isSSH ? "connected" : "disconnected");

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

  // In agent view: show embedded terminal when user runs a command
  const [showEmbeddedTerminal, setShowEmbeddedTerminal] = useState(false);
  const showTuiToolbar = isTouchDevice() && !isConnectPane && (isAgentMode ? showEmbeddedTerminal : focusTarget === "terminal");

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

  // Stop running agent
  useHotkey(
    "stopAgent",
    () => {
      if (!isActive || !isAgentRunning) return;
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
        window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, { id: sessionId, data });
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

  const wrappedHandleCommand = useCallback((cmd: string, queueCallback?: any) => {
    const fixed = smartQuotePaths(cmd);
    markSessionDirty(sessionId);
    if (isAgentMode) {
      if (isInteractiveCommand(fixed)) {
        // Interactive command → show embedded terminal for TUI / REPL interaction
        setShowEmbeddedTerminal(true);
        handleCommand(fixed, queueCallback);
      } else {
        // Non-interactive → run via sentinel exec, output in agent overlay
        handleCommandInOverlay(fixed, queueCallback);
      }
    } else {
      handleCommand(fixed, queueCallback);
    }
  }, [isAgentMode, markSessionDirty, sessionId, handleCommand, handleCommandInOverlay]);

  const wrappedHandleAgentRun = useCallback(async (prompt: string, queueCallback?: any, images?: AttachedImage[]) => {
    markSessionDirty(sessionId);
    await handleAgentRun(prompt, queueCallback, images);
  }, [markSessionDirty, sessionId, handleAgentRun]);

  const handleSlashCommand = useCallback(async (command: string) => {
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
          agentThread: agentThread.map((s) => ({ step: s.step, output: s.output, payload: s.payload })),
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
            { step: "system", output: `Failed to save log: ${result.error || "Unknown error"}` },
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
  }, [sessionId, session, agentThread, setAgentThread, isOverlayVisible, setIsOverlayVisible]);
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

  return (
    <div
      onMouseDown={handlePaneFocus}
      className={`w-full h-full relative flex flex-col border border-transparent ${isActive ? "ring-1 ring-purple-500/50 z-10" : "opacity-80 hover:opacity-100"}`}
    >
      {isAgentMode ? (
        <>
          {/* Agent View Mode: info header + full-height overlay */}
          <div
            className={`flex items-center gap-2 px-3 py-1.5 border-b shrink-0 ${themeClass(
              resolvedTheme,
              {
                dark: "bg-[#0a0a0a] border-white/5",
                modern: "bg-white/[0.02] border-white/6 backdrop-blur-2xl",
                light: "bg-gray-50 border-gray-200",
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
            {!isSSH && (
              <Folder
                className={`w-3 h-3 shrink-0 ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`}
              />
            )}
            <span
              className={`text-[11px] font-mono truncate ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}
            >
              {isSSH ? (session?.cwd || "~") : abbreviateHome(session?.cwd || "~")}
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
            onClose={() => { }}
            onClear={() => resetSession()}
            onPermission={handlePermission}
            isExpanded={true}
            onExpand={() => { }}
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
                className={`relative border-t shrink-0 ${themeClass(resolvedTheme, {
                  dark: "border-white/10",
                  modern: "border-white/10",
                  light: "border-gray-300",
                })}`}
              >
                {/* Header bar with close button */}
                <div
                  className={`absolute top-0 right-0 z-10 flex items-center gap-1 px-2 py-1`}
                >
                  <button
                    onClick={closeEmbeddedTerminal}
                    className={`p-1 rounded transition-colors ${themeClass(resolvedTheme, {
                      dark: "hover:bg-white/10 text-gray-400 hover:text-white",
                      modern: "hover:bg-white/10 text-gray-400 hover:text-white",
                      light: "hover:bg-gray-200 text-gray-500 hover:text-gray-800",
                    })}`}
                    title="Close terminal (sends Ctrl+C)"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <Terminal
                  className="w-full h-full"
                  sessionId={sessionId}
                  onActivity={stableOnActivity}
                  isActive={isActive}
                  isAgentRunning={isAgentRunning}
                  stopAgent={stableStopAgent}
                  focusTarget={focusTarget}
                  isReconnected={session?.reconnected}
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
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 relative" onMouseDown={() => setFocusTarget("terminal")}>
            {isConnectPane ? (
              <div className={`w-full h-full flex flex-col items-center justify-center gap-5 ${themeClass(resolvedTheme, {
                dark: "bg-[#0d0d0d]",
                modern: "bg-[#08081a]",
                light: "bg-white",
              })}`}>
                <img src={logoSvg} alt="Tron" className="w-12 h-12 opacity-50" />
                <button
                  onClick={() => setShowSSHModal(true)}
                  className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${themeClass(resolvedTheme, {
                    dark: "bg-purple-600/80 hover:bg-purple-600 text-white",
                    modern: "bg-purple-500/70 hover:bg-purple-500 text-white",
                    light: "bg-purple-600 hover:bg-purple-500 text-white",
                  })}`}
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
                      className={`absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-xs font-medium shadow-lg ${themeClass(resolvedTheme, {
                        dark: "bg-yellow-500/90 text-black",
                        modern: "bg-yellow-500/90 text-black",
                        light: "bg-yellow-500 text-black",
                      })}`}
                    >
                      Connect to a server first
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <Terminal
                className="w-full h-full"
                sessionId={sessionId}
                onActivity={stableOnActivity}
                isActive={isActive}
                isAgentRunning={isAgentRunning}
                stopAgent={stableStopAgent}
                focusTarget={focusTarget}
                isReconnected={session?.reconnected}
              />
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
            className={`overflow-hidden border-t ${themeClass(resolvedTheme, {
              dark: "bg-[#0e0e0e] border-white/5",
              modern: "bg-white/[0.03] border-white/6",
              light: "bg-amber-50/50 border-gray-200",
            })}`}
          >
            <div className="px-3 py-1.5 flex items-center gap-2 flex-wrap">
              <span
                className={`text-[10px] uppercase tracking-wider font-semibold shrink-0 ${resolvedTheme === "light"
                  ? "text-amber-600"
                  : "text-amber-400/70"
                  }`}
              >
                Queue ({inputQueue.length})
              </span>
              {inputQueue.map((item, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono max-w-[200px] ${resolvedTheme === "light"
                    ? item.type === "agent"
                      ? "bg-purple-100 text-purple-700 border border-purple-200"
                      : "bg-gray-100 text-gray-700 border border-gray-200"
                    : item.type === "agent"
                      ? "bg-purple-500/10 text-purple-300 border border-purple-500/20"
                      : "bg-white/5 text-gray-400 border border-white/10"
                    }`}
                >
                  {item.type === "agent" ? (
                    <Bot className="w-3 h-3 shrink-0 opacity-60" />
                  ) : (
                    <ChevronRight className="w-3 h-3 shrink-0 opacity-60" />
                  )}
                  <span
                    className="truncate cursor-pointer hover:underline"
                    onClick={() => {
                      // Pop item from queue into SmartInput for editing
                      setInputQueue((prev) => prev.filter((_, idx) => idx !== i));
                      window.dispatchEvent(new CustomEvent("tron:editQueueItem", {
                        detail: { sessionId, text: item.content, type: item.type },
                      }));
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
                    className="shrink-0 opacity-40 hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`shrink-0 p-2 border-t relative ${pendingCommand ? "z-0" : "z-20"} ${themeClass(resolvedTheme, {
          dark: "bg-[#0a0a0a] border-white/5",
          modern: "bg-[#060618] border-white/6",
          light: "bg-gray-50 border-gray-200",
        })}`}
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
      <div className="shrink-0 relative z-30">
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
            className={`absolute bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-xs font-medium shadow-lg ${themeClass(resolvedTheme, {
              dark: "bg-gray-800/95 text-gray-200 border border-gray-600",
              modern: "bg-[#1a1a3e]/95 text-gray-200 border border-white/10",
              light: "bg-white/95 text-gray-700 border border-gray-200",
            })}`}
          >
            No AI model configured.{" "}
            <button
              className="underline font-semibold hover:opacity-80 cursor-pointer"
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
    </div>
  );
};

export default TerminalPane;
