import { useState, useRef, useEffect } from "react";
import type { TerminalSession } from "../types";
import { aiService } from "../services/ai";
import { useHistory } from "../contexts/HistoryContext";
import { useAgent } from "../contexts/AgentContext";
import { useLayout } from "../contexts/LayoutContext";
import { IPC } from "../constants/ipc";
import { cleanContextForAI } from "../utils/contextCleaner";

/**
 * Extracts agent orchestration logic from the terminal pane component.
 * Manages running agent tasks, command execution, and permission handling.
 */
export function useAgentRunner(
  sessionId: string,
  session: TerminalSession | undefined,
) {
  const {
    updateSession,
    // @ts-ignore
    addInteraction,
    renameTab,
  } = useLayout();
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
    thinkingEnabled,
    setThinkingEnabled,
    registerAbortController,
  } = useAgent(sessionId);

  // Model capabilities state
  const [modelCapabilities, setModelCapabilities] = useState<string[]>([]);

  // Fetch capabilities when session config model changes
  useEffect(() => {
    const model = session?.aiConfig?.model || aiService.getConfig().model;
    const provider =
      session?.aiConfig?.provider || aiService.getConfig().provider;
    if (model && provider === "ollama") {
      const baseUrl =
        session?.aiConfig?.baseUrl || aiService.getConfig().baseUrl;
      aiService.getModelCapabilities(model, baseUrl).then(setModelCapabilities);
    } else {
      setModelCapabilities([]);
    }
  }, [session?.aiConfig?.model, session?.aiConfig?.provider]);

  // Ref to track latest alwaysAllowSession inside async closures
  const alwaysAllowRef = useRef(alwaysAllowSession);
  useEffect(() => {
    alwaysAllowRef.current = alwaysAllowSession;
  }, [alwaysAllowSession]);

  /**
   * Write a command to the terminal.
   * @param cmd The command string
   * @param skipInterrupt If true, skips sending Ctrl+C (useful for injecting comments/context without resetting prompt)
   */
  const writeCommandToTerminal = (
    cmd: string,
    skipInterrupt = false,
  ): Promise<void> => {
    return new Promise((resolve) => {
      if (!window.electron) {
        resolve();
        return;
      }

      const sendCommand = () => {
        window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
          id: sessionId,
          data: cmd + "\r",
        });
        resolve();
      };

      if (skipInterrupt) {
        sendCommand();
      } else {
        // Ctrl+C aborts heredocs, multiline input, or hung foreground processes
        window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
          id: sessionId,
          data: "\x03",
        });
        // Brief delay for shell to process interrupt and show a new prompt
        setTimeout(() => {
          // Send Ctrl+U (clear line) before command to ensure clean input
          window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
            id: sessionId,
            data: "\x15",
          });
          sendCommand();
        }, 80);
      }
    });
  };

  const handleCommand = async (
    cmd: string,
    queueCallback?: (item: { type: "command"; content: string }) => void,
  ) => {
    if (isAgentRunning && queueCallback) {
      queueCallback({ type: "command", content: cmd });
      return;
    }

    await writeCommandToTerminal(cmd, true);
    addToHistory(cmd);
  };

  /** Execute a command via exec() and display result in agent overlay. */
  const handleCommandInOverlay = async (
    cmd: string,
    queueCallback?: (item: { type: "command"; content: string }) => void,
  ) => {
    if (isAgentRunning && queueCallback) {
      queueCallback({ type: "command", content: cmd });
      return;
    }

    if (!window.electron) return;

    addToHistory(cmd);
    setIsOverlayVisible(true);

    // Add executing step
    setAgentThread((prev) => [...prev, { step: "executing", output: cmd }]);

    try {
      const result = await window.electron.ipcRenderer.exec(sessionId, cmd);
      let output = result.stdout || "";

      // If the command is a `cd`, also write it to the PTY so the shell's CWD
      // updates and getCwdForPid returns the correct path on next poll.
      const trimmed = cmd.trim();
      if (/^cd(\s|$)/.test(trimmed) && result.exitCode === 0) {
        writeCommandToTerminal(trimmed, true);
      }

      if (result.exitCode !== 0) {
        output = result.stderr || result.stdout || "Command failed";
        setAgentThread((prev) => {
          const updated = [...prev];
          for (let j = updated.length - 1; j >= 0; j--) {
            if (updated[j].step === "executing") {
              updated[j] = { step: "failed", output: cmd + "\n---\n" + output };
              break;
            }
          }
          return updated;
        });
      } else {
        if (!output.trim())
          output = "(Command executed successfully with no output)";
        setAgentThread((prev) => {
          const updated = [...prev];
          for (let j = updated.length - 1; j >= 0; j--) {
            if (updated[j].step === "executing") {
              updated[j] = {
                step: "executed",
                output: cmd + "\n---\n" + output,
              };
              break;
            }
          }
          return updated;
        });
      }
    } catch (err: any) {
      setAgentThread((prev) => {
        const updated = [...prev];
        for (let j = updated.length - 1; j >= 0; j--) {
          if (updated[j].step === "executing") {
            updated[j] = {
              step: "failed",
              output: cmd + "\n---\n" + err.message,
            };
            break;
          }
        }
        return updated;
      });
    }
  };

  const handleAgentRun = async (
    prompt: string,
    queueCallback?: (item: { type: "agent"; content: string }) => void,
  ) => {
    if (isAgentRunning && queueCallback) {
      queueCallback({ type: "agent", content: prompt });
      return;
    }

    // Create and register controller
    const controller = new AbortController();
    registerAbortController(controller);

    setIsAgentRunning(true);
    const modelSupportsThinking =
      modelCapabilities.length === 0 || modelCapabilities.includes("thinking");
    if (thinkingEnabled && modelSupportsThinking) {
      setIsThinking(true);
    }
    setIsOverlayVisible(true);

    // Add a run separator (always, including first run)
    setAgentThread((prev) => [...prev, { step: "separator", output: prompt }]);

    try {
      // 0. Persist User Prompt to Session State (Invisible Context)
      if (sessionId) {
        const currentInteractions = session?.interactions || [];
        updateSession(sessionId, {
          interactions: [
            ...currentInteractions,
            { role: "user", content: prompt, timestamp: Date.now() },
          ],
        });
      }

      // 1. Fetch & Clean Session History
      let sessionHistory = "";
      if (window.electron) {
        const rawHistory = await window.electron.ipcRenderer.invoke(
          IPC.TERMINAL_GET_HISTORY,
          sessionId,
        );
        sessionHistory = cleanContextForAI(rawHistory);
      }

      // 2. Context Compression
      const contextLimit =
        session?.aiConfig?.contextWindow ||
        aiService.getConfig().contextWindow ||
        4000;

      if (session?.contextSummary && session.contextSummarySourceLength) {
        const newContent = sessionHistory.slice(
          session.contextSummarySourceLength,
        );
        sessionHistory = `[PREVIOUS CONTEXT SUMMARIZED]\n${session.contextSummary}\n\n[RECENT TERMINAL OUTPUT]\n${newContent}`;
      } else if (sessionHistory.length > contextLimit) {
        const summary = await aiService.summarizeContext(
          sessionHistory.slice(-contextLimit),
        );
        sessionHistory = `[CONTEXT SUMMARIZED]\n${summary}`;
      }

      // 3. Construct Augmented Prompt with Invisible Interactions
      // Filter for recent interactions to avoid token overflow?
      // For now, take last 10 interactions or so.
      const recentInteractions = (session?.interactions || [])
        .slice(-10)
        .map((i) => `${i.role === "user" ? "User" : "Agent"}: ${i.content}`)
        .join("\n\n");

      // Add CURRENT prompt to the list (it was just added to state, but might not be in session var yet due to closure)
      // Actually, we added it to state but `session` variable is from render scope.
      // Safe to append it manually here if needed, but let's assume we want to be explicit.
      const interactionContext = recentInteractions
        ? `\n[RECENT INTERACTION HISTORY]\n${recentInteractions}\nUser: ${prompt}` // Prompt is already in valid history? No, `interactions` update might be async.
        : // Actually, let's just use the `prompt` argument as the latest user message.
          // And `recentInteractions` should exclude the one we just added?
          // Let's just build it fresh.
          "";

      const augmentedPrompt = `
Context (Terminal Output):
${sessionHistory}

${interactionContext ? interactionContext : `User: ${prompt}`}

Task: ${prompt}
`;

      const finalAnswer = await aiService.runAgent(
        augmentedPrompt,
        async (cmd) => {
          // Check Permissions — use ref for latest value
          if (!alwaysAllowRef.current) {
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

          addToHistory(cmd.trim());

          // Write a comment to the terminal so the user sees activity
          // without actually executing the command (exec handles that).
          const preview = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
          writeCommandToTerminal(`# [agent] ${preview}`, true);

          // Execute via background child_process (clean stdout)
          const result = await window.electron.ipcRenderer.exec(sessionId, cmd);

          if (result.exitCode !== 0) {
            throw new Error(
              `Exit Code ${result.exitCode}: ${result.stderr || result.stdout || "Command failed"}`,
            );
          }

          return (
            result.stdout || "(Command executed successfully with no output)"
          );
        },
        (cmd) => {
          // writeToTerminal: abort pending input, then fire & forget
          const cleaned = cmd.endsWith("\n") ? cmd.slice(0, -1) : cmd;
          writeCommandToTerminal(cleaned);
          addToHistory(cmd.trim());
        },
        (step, output) => {
          if (step === "streaming_thinking") {
            // Update or append an in-progress thinking entry
            setAgentThread((prev) => {
              const lastIdx = prev.length - 1;
              if (lastIdx >= 0 && prev[lastIdx].step === "thinking") {
                const updated = [...prev];
                updated[lastIdx] = { step: "thinking", output };
                return updated;
              }
              return [...prev, { step: "thinking", output }];
            });
            setIsThinking(true);
          } else if (step === "thinking_complete") {
            // Replace the last thinking entry with finalized thought (search backwards)
            setAgentThread((prev) => {
              const updated = [...prev];
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].step === "thinking") {
                  updated[i] = { step: "thought", output };
                  return updated;
                }
              }
              return [...prev, { step: "thought", output }];
            });
            setIsThinking(false);
          } else if (step === "thinking_done") {
            // No thinking content produced — just clear thinking state
            setIsThinking(false);
          } else if (step === "streaming_response") {
            // Update or append an in-progress response entry
            setAgentThread((prev) => {
              const lastIdx = prev.length - 1;
              if (lastIdx >= 0 && prev[lastIdx].step === "streaming") {
                const updated = [...prev];
                updated[lastIdx] = { step: "streaming", output };
                return updated;
              }
              return [...prev, { step: "streaming", output }];
            });
            setIsThinking(false);
          } else if (step !== "thinking") {
            // Real step arrived — update in-place where possible to avoid layout shift
            setAgentThread((prev) => {
              const updated = [...prev];

              // "executed"/"failed" → transform the preceding "executing" entry in-place
              if (step === "executed" || step === "failed") {
                let lastExecIdx = -1;
                for (let j = updated.length - 1; j >= 0; j--) {
                  if (updated[j].step === "executing") {
                    lastExecIdx = j;
                    break;
                  }
                }
                if (lastExecIdx >= 0) {
                  updated[lastExecIdx] = { step, output };
                  // Remove any leftover streaming entries
                  return updated.filter((s) => s.step !== "streaming");
                }
              }

              // Transform streaming entry in-place if present, otherwise append
              let lastStreamIdx = -1;
              for (let j = updated.length - 1; j >= 0; j--) {
                if (updated[j].step === "streaming") {
                  lastStreamIdx = j;
                  break;
                }
              }
              if (lastStreamIdx >= 0) {
                updated[lastStreamIdx] = { step, output };
                return updated;
              }
              return [...updated, { step, output }];
            });
            setIsThinking(false);
          } else if (thinkingEnabled && modelSupportsThinking) {
            setIsThinking(true);
          }
        },
        session?.aiConfig,
        controller.signal,
        thinkingEnabled && modelSupportsThinking,
      );
      // Ensure successful completion clears active state
      setIsAgentRunning(false);

      // Update Agent Thread with Final Status — atomic: transform streaming in-place + add final step
      const finalStep =
        finalAnswer.type === "question"
          ? "question"
          : finalAnswer.success
            ? "done"
            : "failed";
      const finalOutput =
        finalAnswer.message ||
        (finalAnswer.success ? "Task Completed" : "Task Failed");

      setAgentThread((prev) => {
        // Try to replace last streaming entry in-place
        let lastStreamIdx = -1;
        for (let j = prev.length - 1; j >= 0; j--) {
          if (prev[j].step === "streaming") {
            lastStreamIdx = j;
            break;
          }
        }
        if (lastStreamIdx >= 0) {
          const updated = [...prev];
          updated[lastStreamIdx] = { step: finalStep, output: finalOutput };
          return updated;
        }
        // No streaming entry — just append
        return [...prev, { step: finalStep, output: finalOutput }];
      });

      // Persist Agent Conclusion to Session State (Invisible Context)
      if (sessionId && finalAnswer.message) {
        addInteraction(sessionId, {
          role: "agent",
          content: finalAnswer.message,
          timestamp: Date.now(),
        });
      }

      // Generate AI tab title (fire-and-forget, non-blocking)
      if (sessionId) {
        aiService
          .generateTabTitle(prompt, session?.aiConfig)
          .then((title) => {
            if (title) renameTab(sessionId, title);
          })
          .catch(() => {});
      }
    } catch (error: any) {
      const isAbort =
        error.name === "AbortError" ||
        error.message?.toLowerCase().includes("abort");
      if (!isAbort) {
        // Only add error for non-abort failures.
        // Abort is handled by stopAgent() which already adds a "stopped" step.
        console.error(error);
        setAgentThread((prev) => [
          ...prev,
          { step: "error", output: `Error: ${error.message}` },
        ]);
        setIsAgentRunning(false);
      }
      // For aborts, stopAgent() already set isAgentRunning=false and added the stopped step
    } finally {
      setIsThinking(false);
      // unregisterAbortController(controller); // Not available in context
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
    alwaysAllowSession,
    setAlwaysAllowSession,
    thinkingEnabled,
    setThinkingEnabled,
    // Model info
    modelCapabilities,
    // Actions
    handleCommand,
    handleCommandInOverlay,
    handleAgentRun,
    handlePermission,
  };
}
