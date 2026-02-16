import { useState, useEffect } from "react";
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
  const { activeSessionId, sessions, markSessionDirty } = useLayout();
  const { resolvedTheme } = useTheme();
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
    handleCommand,
    handleAgentRun,
    handlePermission,
  } = useAgentRunner(sessionId, session);

  // Input Queue
  const [inputQueue, setInputQueue] = useState<
    Array<{ type: "command" | "agent"; content: string }>
  >([]);

  // Cmd+. to toggle agent panel
  useEffect(() => {
    if (!isActive) return;
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        if (agentThread.length > 0) {
          setIsOverlayVisible(!isOverlayVisible);
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isActive, isOverlayVisible, agentThread.length, setIsOverlayVisible]);

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

  return (
    <div
      className={`w-full h-full relative flex flex-col border border-transparent ${isActive ? "ring-1 ring-purple-500/50 z-10" : "opacity-80 hover:opacity-100"}`}
    >
      {/* Top: Terminal Area */}
      <div className="flex-1 min-h-0 relative flex flex-col">
        <div className="flex-1 min-h-0 relative">
          <Terminal className="h-full w-full" sessionId={sessionId} />
        </div>

        {/* Agent Overlay */}
        {(isOverlayVisible || isAgentRunning) && (
          <AgentOverlay
            isThinking={isThinking}
            isAgentRunning={isAgentRunning}
            agentThread={agentThread}
            pendingCommand={pendingCommand}
            autoExecuteEnabled={alwaysAllowSession}
            onToggleAutoExecute={() => setAlwaysAllowSession(!alwaysAllowSession)}
            thinkingEnabled={thinkingEnabled}
            onToggleThinking={() => setThinkingEnabled(!thinkingEnabled)}
            onClose={() => setIsOverlayVisible(false)}
            onPermission={handlePermission}
          />
        )}
      </div>
      <div
        className={`p-2 border-t relative z-20 ${themeClass(resolvedTheme, {
          dark: "bg-[#0a0a0a] border-white/5",
          modern: "bg-[#080818]/80 border-white/10 backdrop-blur-xl",
          light: "bg-gray-50 border-gray-200",
        })}`}
      >
        <SmartInput
          onSend={(cmd) => wrappedHandleCommand(cmd, queueItem as any)}
          onRunAgent={(prompt) => wrappedHandleAgentRun(prompt, queueItem as any)}
          isAgentRunning={isAgentRunning}
          pendingCommand={pendingCommand}
          sessionId={sessionId}
        />
      </div>
      <div className="relative z-30">
        <ContextBar sessionId={sessionId} />
      </div>
    </div>
  );
};

export default TerminalPane;
