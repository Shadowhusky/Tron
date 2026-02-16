import type { TerminalSession } from "../types";
import { aiService } from "../services/ai";
import { useHistory } from "../contexts/HistoryContext";
import { useAgent } from "../contexts/AgentContext";
import { IPC } from "../constants/ipc";

/**
 * Extracts agent orchestration logic from the terminal pane component.
 * Manages running agent tasks, command execution, and permission handling.
 */
export function useAgentRunner(sessionId: string, session: TerminalSession | undefined) {
  const { addToHistory } = useHistory();
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
  } = useAgent(sessionId);

  const handleCommand = async (cmd: string, queueCallback?: (item: { type: "command"; content: string }) => void) => {
    if (isAgentRunning && queueCallback) {
      queueCallback({ type: "command", content: cmd });
      return;
    }

    if (window.electron) {
      window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
        id: sessionId,
        data: "\x15" + cmd + "\r",
      });
      addToHistory(cmd);
    }
  };

  const handleAgentRun = async (prompt: string, queueCallback?: (item: { type: "agent"; content: string }) => void) => {
    if (isAgentRunning && queueCallback) {
      queueCallback({ type: "agent", content: prompt });
      return;
    }

    // Create and register controller
    const controller = new AbortController();
    registerAbortController(controller);

    setIsAgentRunning(true);
    setIsThinking(true);
    setIsOverlayVisible(true);
    setAgentThread([]);

    try {
      // 1. Fetch Session History
      let sessionHistory = "";
      if (window.electron) {
        sessionHistory = await window.electron.ipcRenderer.invoke(
          IPC.TERMINAL_GET_HISTORY,
          sessionId,
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

          if (!sessionId) {
            throw new Error("No terminal session found.");
          }

          // Clear any partial user input, then write command
          if (window.electron) {
            window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
              id: sessionId,
              data: "\x15" + cmd + "\r",
            });
          }

          addToHistory(cmd.trim());

          // Execute with timeout (30s)
          const execPromise = window.electron.ipcRenderer.exec(
            sessionId,
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
            window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
              id: sessionId,
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
        controller.signal,
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

  return {
    // Agent state (re-exported from useAgent for convenience)
    agentThread,
    isAgentRunning,
    isThinking,
    pendingCommand,
    isOverlayVisible,
    setIsOverlayVisible,
    // Actions
    handleCommand,
    handleAgentRun,
    handlePermission,
  };
}
