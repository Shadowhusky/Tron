import React, { useState, useEffect } from "react";
import type { LayoutNode } from "../../types";
import Terminal from "../../features/terminal/components/Terminal";
import { useLayout } from "../../contexts/LayoutContext";
import { useHistory } from "../../contexts/HistoryContext";
import { useTheme } from "../../contexts/ThemeContext";
import { aiService } from "../../services/ai";
import SmartInput from "../../features/terminal/components/SmartInput";
import AgentOverlay from "../../features/agent/components/AgentOverlay";
import ContextBar from "./ContextBar";
import { useAgent } from "../../contexts/AgentContext";
import SettingsPane from "../../features/settings/components/SettingsPane"; // Add import

interface SplitPaneProps {
  node: LayoutNode;
}

const SplitPane: React.FC<SplitPaneProps> = ({ node }) => {
  const { activeSessionId, sessions } = useLayout();
  const { addToHistory } = useHistory();
  const { resolvedTheme } = useTheme();

  // Handle Settings Pane
  if (node.type === "leaf" && node.contentType === "settings") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <SettingsPane />
      </div>
    );
  }

  const {
    agentThread,
    setAgentThread,
    isAgentRunning,
    setIsAgentRunning,
    isThinking,
    setIsThinking,
    pendingCommand,
    setPendingCommand,
    permissionResolve,
    setPermissionResolve,
    alwaysAllowSession,
    setAlwaysAllowSession,
    isOverlayVisible,
    setIsOverlayVisible,
    registerAbortController,
  } = useAgent(node.type === "leaf" ? node.sessionId : "");

  if (node.type === "leaf") {
    const isActive = node.sessionId === activeSessionId;
    const session = sessions.get(node.sessionId);

    // Input Queue
    const [inputQueue, setInputQueue] = useState<
      Array<{ type: "command" | "agent"; content: string }>
    >([]);

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
    }, [isAgentRunning, inputQueue]);

    const handleCommand = async (cmd: string) => {
      if (isAgentRunning) {
        setInputQueue((prev) => [...prev, { type: "command", content: cmd }]);
        return;
      }

      if (window.electron) {
        window.electron.ipcRenderer.send("terminal.write", {
          id: node.sessionId,
          data: cmd + "\r",
        });
        addToHistory(cmd);
      }
    };

    const handleAgentRun = async (prompt: string) => {
      if (isAgentRunning) {
        setInputQueue((prev) => [...prev, { type: "agent", content: prompt }]);
        return;
      }

      // Create and register controller
      const controller = new AbortController();
      registerAbortController(controller);

      setIsAgentRunning(true);
      setIsThinking(true); // Immediate feedback
      setIsOverlayVisible(true);
      setAgentThread([]);

      try {
        // 1. Fetch Session History
        let sessionHistory = "";
        if (window.electron) {
          sessionHistory = await window.electron.ipcRenderer.invoke(
            "terminal.getHistory",
            node.sessionId,
          );
        }

        // 2. Context Compression — summarize if over limit
        const contextLimit =
          session?.aiConfig?.contextWindow ||
          aiService.getConfig().contextWindow ||
          4000;
        if (sessionHistory.length > contextLimit) {
          sessionHistory = await aiService.summarizeContext(
            sessionHistory.slice(0, contextLimit),
          );
        }

        // 3. Augment Prompt with Context
        const augmentedPrompt = `
Context (Recent Terminal Output):
${sessionHistory.slice(-2000)}

Task: ${prompt}
`;

        const finalAnswer = await aiService.runAgent(
          augmentedPrompt,
          async (cmd) => {
            // Check Permissions
            if (!alwaysAllowSession) {
              setPendingCommand(cmd);
              const allowed = await new Promise<boolean>((resolve) => {
                setPermissionResolve(resolve);
              });
              setPendingCommand(null);
              setPermissionResolve(null);

              if (!allowed) {
                throw new Error("User denied command execution.");
              }
            }

            if (!node.sessionId) {
              throw new Error("No terminal session found.");
            }

            // 1. Clear any partial user input, then write command
            if (window.electron) {
              window.electron.ipcRenderer.send("terminal.write", {
                id: node.sessionId,
                data: "\x15" + cmd + "\r",
              });
            }

            // Add to user history
            addToHistory(cmd.trim());

            // 2. Execute with timeout (30s) to prevent hanging on long commands
            const execPromise = window.electron.ipcRenderer.exec(
              node.sessionId,
              cmd,
            );
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Command timed out after 30s")),
                30000,
              ),
            );
            const result = await Promise.race([execPromise, timeoutPromise]);

            if (result.exitCode !== 0 && result.stderr) {
              throw new Error(`Exit Code ${result.exitCode}: ${result.stderr}`);
            }

            return (
              result.stdout || "(Command executed successfully with no output)"
            );
          },
          (cmd) => {
            // writeToTerminal: clear line first, then fire & forget
            if (window.electron) {
              const cleaned = cmd.endsWith("\n") ? cmd.slice(0, -1) : cmd;
              window.electron.ipcRenderer.send("terminal.write", {
                id: node.sessionId,
                data: "\x15" + cleaned + "\r",
              });
            }
            addToHistory(cmd.trim());
          },
          (step, output) => {
            if (step !== "thinking") {
              setAgentThread((prev) => [...prev, { step, output }]);
            }
            setIsThinking(step === "thinking");
          },
          session?.aiConfig,
          controller.signal, // Pass signal
        );
        // Ensure successful completion clears active state
        setIsAgentRunning(false);
        setAgentThread((prev) => [
          ...prev,
          {
            step: finalAnswer.success ? "done" : "failed",
            output: finalAnswer.message,
          },
        ]);
      } catch (e: any) {
        // stopAgent already adds abort entry + resets state, so skip duplicates
        if (e.message !== "Agent aborted by user.") {
          setAgentThread((prev) => [
            ...prev,
            { step: "error", output: e.message },
          ]);
        }
      } finally {
        setIsAgentRunning(false);
        setIsThinking(false);
        // Keep panel visible so user can review the execution history
        setIsOverlayVisible(true);
      }
    };

    const handlePermission = (choice: "allow" | "always" | "deny") => {
      if (!permissionResolve) return;
      if (choice === "always") {
        setAlwaysAllowSession(true);
        permissionResolve(true);
      } else if (choice === "allow") {
        permissionResolve(true);
      } else {
        permissionResolve(false);
      }
    };

    return (
      <div
        className={`w-full h-full relative flex flex-col border border-transparent ${isActive ? "ring-1 ring-purple-500/50 z-10" : "opacity-80 hover:opacity-100"}`}
      >
        {/* Top: Terminal Area */}
        <div className="flex-1 min-h-0 relative flex flex-col">
          <div className="flex-1 min-h-0 relative">
            <Terminal className="h-full w-full" sessionId={node.sessionId} />
          </div>

          {/* Agent Overlay - Now a sibling that takes space */}
          {(isOverlayVisible || isAgentRunning) && (
            <AgentOverlay
              isThinking={isThinking}
              isAgentRunning={isAgentRunning}
              agentThread={agentThread}
              pendingCommand={pendingCommand}
              onClose={() => setIsOverlayVisible(false)}
              onPermission={handlePermission}
            />
          )}
        </div>
        <div
          className={`p-2 border-t z-40 relative ${
            resolvedTheme === "light"
              ? "bg-gray-50 border-gray-200"
              : resolvedTheme === "modern"
                ? "bg-black/60 border-white/5 backdrop-blur-md"
                : "bg-[#0a0a0a] border-white/5"
          }`}
        >
          <SmartInput
            onSend={handleCommand}
            onRunAgent={handleAgentRun}
            isAgentRunning={isAgentRunning}
            pendingCommand={pendingCommand}
          />
        </div>
        <ContextBar sessionId={node.sessionId} />
      </div>
    );
  }

  return (
    <div
      className={`flex w-full h-full ${node.direction === "horizontal" ? "flex-row" : "flex-col"}`}
    >
      {node.children.map((child, index) => (
        <div
          key={index}
          style={{ flex: node.sizes ? node.sizes[index] : 1 }}
          className="relative border-r border-b border-white/5 last:border-0 overflow-hidden"
        >
          <SplitPane node={child} />
        </div>
      ))}
    </div>
  );
};

export default SplitPane;
