import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Bot, ChevronRight, Folder } from "lucide-react";
import Terminal from "../../features/terminal/components/Terminal";
import SmartInput from "../../features/terminal/components/SmartInput";
import AgentOverlay from "../../features/agent/components/AgentOverlay";
import ContextBar from "./ContextBar";
import { useLayout } from "../../contexts/LayoutContext";
import { useTheme } from "../../contexts/ThemeContext";
import { useAgentRunner } from "../../hooks/useAgentRunner";
import { themeClass } from "../../utils/theme";

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
    handleAgentRun,
    handlePermission,
  } = useAgentRunner(sessionId, session);

  // Input Queue
  const [inputQueue, setInputQueue] = useState<
    Array<{ type: "command" | "agent"; content: string }>
  >([]);

  // Cmd+. to toggle agent panel (no-op in agent view mode — overlay is always visible)
  useEffect(() => {
    if (!isActive || isAgentMode) return;
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === ".") {
        e.preventDefault();
        if (agentThread.length > 0) {
          setIsOverlayVisible(!isOverlayVisible);
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isActive, isAgentMode, isOverlayVisible, agentThread.length, setIsOverlayVisible]);

  // Process Queue Effect
  useEffect(() => {
    if (!isAgentRunning && inputQueue.length > 0) {
      const nextItem = inputQueue[0];
      setInputQueue((prev) => prev.slice(1));

      if (nextItem.type === "command") {
        handleCommand(nextItem.content);
      } else {
        handleAgentRun(nextItem.content);
      }
    }
  }, [isAgentRunning, inputQueue, handleCommand, handleAgentRun]);

  const queueItem = (item: { type: "command" | "agent"; content: string }) => {
    setInputQueue((prev) => [...prev, item]);
  };

  const wrappedHandleCommand = (cmd: string, queueCallback?: any) => {
    markSessionDirty(sessionId);
    handleCommand(cmd, queueCallback);
  };

  const wrappedHandleAgentRun = async (prompt: string, queueCallback?: any) => {
    markSessionDirty(sessionId);
    await handleAgentRun(prompt, queueCallback);
  };

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
            className={`flex items-center gap-2 px-3 py-1.5 border-b shrink-0 ${themeClass(resolvedTheme, {
              dark: "bg-[#0a0a0a] border-white/5",
              modern: "bg-white/[0.02] border-white/6 backdrop-blur-2xl",
              light: "bg-gray-50 border-gray-200",
            })}`}
          >
            <Folder className={`w-3 h-3 shrink-0 ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`} />
            <span className={`text-[11px] font-mono truncate ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
              {session?.cwd || "~"}
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
            onPermission={handlePermission}
            isExpanded={true}
            onExpand={() => {}}
            onRunAgent={(prompt) =>
              wrappedHandleAgentRun(prompt, queueItem as any)
            }
            modelCapabilities={modelCapabilities}
            fullHeight
          />
        </>
      ) : (
        <>
          {/* Terminal View Mode: xterm + overlay */}
          <div className="flex-1 min-h-0">
            <Terminal
              className="h-full w-full"
              sessionId={sessionId}
              onActivity={() => markSessionDirty(sessionId)}
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
              onPermission={handlePermission}
              isExpanded={isOverlayVisible}
              onExpand={() => setIsOverlayVisible(true)}
              onRunAgent={(prompt) =>
                wrappedHandleAgentRun(prompt, queueItem as any)
              }
              modelCapabilities={modelCapabilities}
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
              <span className={`text-[10px] uppercase tracking-wider font-semibold shrink-0 ${
                resolvedTheme === "light" ? "text-amber-600" : "text-amber-400/70"
              }`}>
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
                    onClick={() => setInputQueue(prev => prev.filter((_, idx) => idx !== i))}
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
          onSend={(cmd) => wrappedHandleCommand(cmd, queueItem as any)}
          onRunAgent={(prompt) =>
            wrappedHandleAgentRun(prompt, queueItem as any)
          }
          isAgentRunning={isAgentRunning}
          pendingCommand={pendingCommand}
          sessionId={sessionId}
          modelCapabilities={modelCapabilities}
          defaultAgentMode={isAgentMode}
        />
      </div>
      <div className="relative z-30">
        <ContextBar sessionId={sessionId} />
      </div>
    </div>
  );
};

export default TerminalPane;
