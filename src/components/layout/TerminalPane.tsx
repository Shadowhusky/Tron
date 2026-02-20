import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Bot, ChevronRight, Folder } from "lucide-react";
import Terminal from "../../features/terminal/components/Terminal";
import SmartInput from "../../features/terminal/components/SmartInput";
import AgentOverlay from "../../features/agent/components/AgentOverlay";
import ContextBar from "./ContextBar";
import { useLayout } from "../../contexts/LayoutContext";
import { useTheme } from "../../contexts/ThemeContext";
import { useAgentRunner } from "../../hooks/useAgentRunner";
import { useAgent } from "../../contexts/AgentContext";
import { themeClass } from "../../utils/theme";
import { useHotkey } from "../../hooks/useHotkey";
import { isInteractiveCommand, smartQuotePaths } from "../../utils/commandClassifier";
import { IPC } from "../../constants/ipc";
import { abbreviateHome } from "../../utils/platform";
import type { AttachedImage } from "../../types";

interface TerminalPaneProps {
  sessionId: string;
}

const TerminalPane: React.FC<TerminalPaneProps> = ({ sessionId }) => {
  const { activeSessionId, sessions, markSessionDirty, focusSession } =
    useLayout();
  const { resolvedTheme, viewMode } = useTheme();
  const isAgentMode = viewMode === "agent";
  const isActive = sessionId === activeSessionId;
  const session = sessions.get(sessionId);

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
  } = useAgentRunner(sessionId, session);

  const { stopAgent: stopAgentRaw, resetSession, overlayHeight, setOverlayHeight, draftInput, setDraftInput, setAgentThread } = useAgent(sessionId);

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
  const wrappedHandleCommandRef = useRef<(cmd: string) => void>(() => {});
  const wrappedHandleAgentRunRef = useRef<(prompt: string, queueCallback?: any, images?: AttachedImage[]) => void>(() => {});
  const handleSlashCommandRef = useRef<(cmd: string) => void>(() => {});
  const stableOnSend = useCallback((cmd: string) => wrappedHandleCommandRef.current(cmd), []);
  const stableOnRunAgent = useCallback(async (prompt: string, images?: AttachedImage[]) => wrappedHandleAgentRunRef.current(prompt, undefined, images), []);
  const stableSlashCommand = useCallback((cmd: string) => handleSlashCommandRef.current(cmd), []);

  // Stable callback for Terminal memo
  const markSessionDirtyRef = useRef(markSessionDirty);
  markSessionDirtyRef.current = markSessionDirty;
  const stableOnActivity = useCallback(() => markSessionDirtyRef.current(sessionId), [sessionId]);

  // Input Queue
  const [inputQueue, setInputQueue] = useState<
    Array<{ type: "command" | "agent"; content: string }>
  >([]);

  // In agent view: show embedded terminal when user runs a command
  const [showEmbeddedTerminal, setShowEmbeddedTerminal] = useState(false);

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

  // Clear terminal (+ agent thread so it doesn't come back on refresh)
  useHotkey(
    "clearTerminal",
    () => {
      if (!isActive) return;
      if (isAgentMode) {
        resetSession();
      } else {
        // Clear xterm
        window.dispatchEvent(
          new CustomEvent("tron:clearTerminal", { detail: { sessionId } }),
        );
        // Also clear agent thread so it doesn't reappear on refresh
        resetSession();
      }
    },
    [isActive, isAgentMode, resetSession, sessionId],
  );

  // Clear agent panel only (Cmd+Shift+K)
  useHotkey(
    "clearAgent",
    () => {
      if (!isActive) return;
      resetSession();
    },
    [isActive, resetSession],
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
          agentThread: agentThread.map((s) => ({ step: s.step, output: s.output })),
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
  wrappedHandleCommandRef.current = wrappedHandleCommand;
  wrappedHandleAgentRunRef.current = wrappedHandleAgentRun;
  handleSlashCommandRef.current = handleSlashCommand;

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
            <Folder
              className={`w-3 h-3 shrink-0 ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`}
            />
            <span
              className={`text-[11px] font-mono truncate ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}
            >
              {abbreviateHome(session?.cwd || "~")}
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
                />
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        <>
          {/* Terminal View Mode: xterm + overlay */}
          <div className="flex-1 min-h-0">
            <Terminal
              className="w-full h-full"
              sessionId={sessionId}
              onActivity={stableOnActivity}
              isActive={isActive}
            />
          </div>

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
              />
            )}
          </AnimatePresence>
        </>
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
                className={`text-[10px] uppercase tracking-wider font-semibold shrink-0 ${
                  resolvedTheme === "light"
                    ? "text-amber-600"
                    : "text-amber-400/70"
                }`}
              >
                Queue ({inputQueue.length})
              </span>
              {inputQueue.map((item, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono max-w-[200px] ${
                    resolvedTheme === "light"
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
                  <span className="truncate">{item.content}</span>
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
        className={`p-2 border-t relative z-20 ${themeClass(resolvedTheme, {
          dark: "bg-[#0a0a0a] border-white/5",
          modern: "bg-white/2 border-white/6 backdrop-blur-2xl",
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
        />
      </div>
      <div className="relative z-30">
        <ContextBar sessionId={sessionId} />
      </div>
    </div>
  );
};

export default TerminalPane;
