import { useState, useRef, useEffect, startTransition } from "react";
import type { TerminalSession, AttachedImage } from "../types";
import { aiService, type AgentContinuation } from "../services/ai";
import { useHistory } from "../contexts/HistoryContext";
import { useAgent } from "../contexts/AgentContext";
import { useLayout } from "../contexts/LayoutContext";
import { useConfig } from "../contexts/ConfigContext";
import { IPC } from "../constants/ipc";
import { cleanContextForAI } from "../utils/contextCleaner";
import { isDangerousCommand } from "../utils/dangerousCommand";
import { isWindows } from "../utils/platform";
import { readScreenBuffer } from "../services/terminalBuffer";

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
  const { aiBehavior } = useConfig();
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

  // Model capabilities state — null means "unknown" (cloud providers), [] means "known but none"
  const [modelCapabilities, setModelCapabilities] = useState<string[] | null>(null);

  // Persisted agent state for resuming after ask_question
  const continuationRef = useRef<AgentContinuation | null>(null);
  /** Check if the tab title is locked (agent-generated or user-renamed). */
  const isTitleLocked = () => session?.titleLocked === true;

  // Streaming throttle — buffers token-level setAgentThread calls (max ~10/sec)
  const streamBufferRef = useRef<{
    output: string | null;
    step: string | null;
    timer: ReturnType<typeof setTimeout> | null;
    lastFlush: number;
  }>({ output: null, step: null, timer: null, lastFlush: 0 });

  const flushStreamBuffer = () => {
    const buf = streamBufferRef.current;
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
    if (buf.output == null) return;
    const output = buf.output;
    const stepType = buf.step;
    buf.output = null;
    buf.step = null;
    buf.lastFlush = Date.now();

    startTransition(() => {
      if (stepType === "streaming_thinking") {
        setAgentThread((prev) => {
          const lastIdx = prev.length - 1;
          if (lastIdx >= 0 && prev[lastIdx].step === "thinking") {
            const updated = [...prev];
            updated[lastIdx] = { step: "thinking", output };
            return updated;
          }
          return [...prev, { step: "thinking", output }];
        });
      } else {
        setAgentThread((prev) => {
          const lastIdx = prev.length - 1;
          if (lastIdx >= 0 && prev[lastIdx].step === "streaming") {
            const updated = [...prev];
            updated[lastIdx] = { step: "streaming", output };
            return updated;
          }
          return [...prev, { step: "streaming", output }];
        });
      }
    });
  };

  const clearStreamBuffer = () => {
    const buf = streamBufferRef.current;
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
    buf.output = null;
    buf.step = null;
  };

  // Fetch capabilities when model changes (session-level or global)
  const effectiveModel = session?.aiConfig?.model || aiService.getConfig().model;
  const effectiveProvider = session?.aiConfig?.provider || aiService.getConfig().provider;
  useEffect(() => {
    if (effectiveModel && (effectiveProvider === "ollama" || effectiveProvider === "lmstudio")) {
      const baseUrl = session?.aiConfig?.baseUrl || aiService.getConfig().baseUrl;
      aiService.getModelCapabilities(effectiveModel, baseUrl, effectiveProvider).then((caps) => {
        // Also check runtime-detected thinking models (from <think> tags seen in previous responses)
        if (!caps.includes("thinking") && aiService.isDetectedThinkingModel(effectiveProvider, effectiveModel)) {
          caps.push("thinking");
        }
        setModelCapabilities(caps);
      });
    } else if (effectiveModel) {
      const m = effectiveModel.toLowerCase();
      const caps: string[] = [];
      if (
        effectiveProvider === "anthropic" || effectiveProvider === "anthropic-compat" ||
        effectiveProvider === "openai-compat" ||                           // Local models commonly support thinking
        /\b(o[134]|reasoner|thinking|r1|qwq|qwen)\b/.test(m) ||
        /\bgemini.*\b/.test(m)
      ) {
        caps.push("thinking");
      }
      if (
        effectiveProvider === "anthropic" || effectiveProvider === "anthropic-compat" ||
        effectiveProvider === "openai" ||
        effectiveProvider === "gemini" ||
        /\b(claude-3|gpt-4|gemini|pixtral|llava)\b/.test(m)
      ) {
        caps.push("vision");
      }
      if (!caps.includes("thinking") && effectiveProvider && aiService.isDetectedThinkingModel(effectiveProvider, effectiveModel)) {
        caps.push("thinking");
      }
      setModelCapabilities(caps);
    } else {
      setModelCapabilities([]);
    }
  }, [effectiveModel, effectiveProvider]);

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
    addNewLine = true,
  ): Promise<void> => {
    return new Promise((resolve) => {
      if (!window.electron) {
        resolve();
        return;
      }

      const sendCommand = () => {
        window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
          id: sessionId,
          data: addNewLine ? cmd + "\r" : cmd,
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
          // Clear current input line before sending the command
          window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
            id: sessionId,
            data: isWindows() ? "\x1b" : "\x15", // Esc for Win, Ctrl+U for Unix
          });
          // On Windows, Esc must be a standalone keypress — delay before sending
          // the command so PSReadLine doesn't merge it with the next characters
          setTimeout(sendCommand, isWindows() ? 50 : 0);
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

    if (!isTitleLocked() && sessionId && session?.title === "Terminal") {
      const cmdStr = cmd.trim();
      const title = cmdStr.length > 20 ? cmdStr.substring(0, 20) + "..." : cmdStr;
      renameTab(sessionId, title);
    }

    await writeCommandToTerminal(cmd, true);
    addToHistory(cmd);
  };

  /** Execute a command via execInTerminal() and display result in agent overlay. */
  const handleCommandInOverlay = async (
    cmd: string,
    queueCallback?: (item: { type: "command"; content: string }) => void,
  ) => {
    if (isAgentRunning && queueCallback) {
      queueCallback({ type: "command", content: cmd });
      return;
    }

    if (!isTitleLocked() && sessionId && session?.title === "Terminal") {
      const cmdStr = cmd.trim();
      const title = cmdStr.length > 20 ? cmdStr.substring(0, 20) + "..." : cmdStr;
      renameTab(sessionId, title);
    }

    if (!window.electron) return;

    addToHistory(cmd);
    setIsOverlayVisible(true);

    // Add executing step
    setAgentThread((prev) => [...prev, { step: "executing", output: cmd }]);

    try {
      // Use execInTerminal to run in the visible PTY and capture output
      // This handles writing to the terminal internally, so we don't need writeCommandToTerminal here
      const result = await window.electron.ipcRenderer.invoke(IPC.TERMINAL_EXEC_IN_TERMINAL, {
        sessionId,
        command: cmd,
      });

      let output = result.stdout || "";
      const exitCode = result.exitCode;

      // Handle timeout (exitCode 124)
      if (exitCode === 124) {
        output = output || "(Long-running process — still running in terminal)";
        setAgentThread((prev) => {
          const updated = [...prev];
          for (let j = updated.length - 1; j >= 0; j--) {
            if (updated[j].step === "executing") {
              updated[j] = { step: "executed", output: cmd + "\n---\n" + output };
              break;
            }
          }
          return updated;
        });
      } else if (exitCode !== 0) {
        output = result.stderr || output || "Command failed";
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

  // Cooldown ref to prevent rapid-fire agent runs (e.g. on error loops)
  const lastAgentRunRef = useRef(0);

  const handleAgentRun = async (
    prompt: string,
    queueCallback?: (item: { type: "agent"; content: string }) => void,
    images?: AttachedImage[],
  ) => {
    if (isAgentRunning && queueCallback) {
      queueCallback({ type: "agent", content: prompt });
      return;
    }

    // Guard: reject empty prompts (unless images are attached)
    const hasImages = images && images.length > 0;
    if (!prompt.trim() && !hasImages) {
      console.warn("handleAgentRun: ignoring empty prompt");
      return;
    }

    // Cooldown: prevent rapid-fire runs (min 500ms between starts)
    const now = Date.now();
    if (now - lastAgentRunRef.current < 500) {
      console.warn("handleAgentRun: throttled (too fast)");
      return;
    }
    lastAgentRunRef.current = now;

    // Create and register controller
    const controller = new AbortController();
    registerAbortController(controller);

    setIsAgentRunning(true);
    window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId, running: true } }));
    const modelSupportsThinking = modelCapabilities?.includes("thinking") ?? false;
    if (thinkingEnabled && modelSupportsThinking) {
      setIsThinking(true);
    }
    setIsOverlayVisible(true);

    // Add a run separator (always, including first run) — encode images if present
    const separatorOutput = images && images.length > 0
      ? prompt + "\n---images---\n" + JSON.stringify(images.map(img => ({ base64: img.base64, mediaType: img.mediaType, name: img.name })))
      : prompt;
    setAgentThread((prev) => [...prev, { step: "separator", output: separatorOutput }]);

    // Tab title will be generated after agent finishes (local models can't handle concurrent requests)
    const shouldGenerateTitle = !isTitleLocked() && sessionId && prompt.trim() && aiBehavior.aiTabTitles;

    // --- Image analysis shortcut: bypass agent loop entirely ---
    if (images && images.length > 0) {
      // Build conversation history from recent interactions so model has context
      const recentInteractions = (session?.interactions || []).slice(-10);
      const conversationHistory = recentInteractions.map((i) => ({
        role: i.role === "user" ? "user" as const : "assistant" as const,
        content: i.content,
      }));

      try {
        let accumulated = "";
        const result = await aiService.analyzeImages(
          prompt,
          images,
          (token) => {
            accumulated += token;
            // Throttle: buffer streaming updates instead of calling setAgentThread per token
            const buf = streamBufferRef.current;
            buf.output = accumulated;
            buf.step = "streaming_response";
            const now = Date.now();
            const elapsed = now - buf.lastFlush;
            if (elapsed >= 100) {
              flushStreamBuffer();
            } else if (!buf.timer) {
              buf.timer = setTimeout(flushStreamBuffer, 100 - elapsed);
            }
          },
          session?.aiConfig,
          controller.signal,
          conversationHistory,
        );
        flushStreamBuffer(); // Flush remaining buffer before finalizing
        const finalText = result || accumulated || "Could not analyze the image.";
        setAgentThread((prev) => {
          const updated = [...prev];
          // Replace streaming entry with done
          for (let j = updated.length - 1; j >= 0; j--) {
            if (updated[j].step === "streaming") {
              updated[j] = { step: "done", output: finalText };
              return updated;
            }
          }
          return [...prev, { step: "done", output: finalText }];
        });
        // Persist to session interactions using addInteraction (avoids stale closure)
        if (sessionId) {
          addInteraction(sessionId, { role: "user", content: prompt, timestamp: Date.now() });
          addInteraction(sessionId, { role: "agent", content: finalText, timestamp: Date.now() });
        }
      } catch (error: any) {
        const isAbort = error.name === "AbortError" || error.message?.toLowerCase().includes("abort");
        if (!isAbort) {
          setAgentThread((prev) => [
            ...prev,
            { step: "error", output: `Error: ${error.message}` },
          ]);
        }
      } finally {
        setIsAgentRunning(false);
        window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId, running: false } }));
        setIsThinking(false);
      }
      return;
    }

    // Check if this is a continuation from a previous ask_question
    const currentContinuation = continuationRef.current;
    continuationRef.current = null;

    try {
      // 0. Persist User Prompt to Session State (Invisible Context)
      if (sessionId && prompt.trim()) {
        const currentInteractions = session?.interactions || [];
        updateSession(sessionId, {
          interactions: [
            ...currentInteractions,
            { role: "user", content: prompt, timestamp: Date.now() },
          ],
        });
      }

      let finalPrompt: string;

      if (currentContinuation) {
        // Continuing from a question — pass raw answer, history is in continuation
        finalPrompt = prompt;
      } else {
        // 1. Fetch & Clean Session History & Environment
        let sessionHistory = "";
        let cwd = "";
        let systemPathsStr = "";

        let projectFiles = "";

        if (window.electron) {
          // Detect platform for cross-platform file listing command
          const listCommand = isWindows()
            ? 'Get-ChildItem -Recurse -Depth 2 -Name -Exclude node_modules,.git,dist,.next,__pycache__,venv,.venv,build | Select-Object -First 100'
            : "find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/__pycache__/*' -not -path '*/venv/*' -not -path '*/.venv/*' -not -path '*/build/*' 2>/dev/null | head -100";

          // Run fetches in parallel for speed
          const [rawHistory, fetchedCwd, paths, dirListing, sysInfo] = await Promise.all([
            window.electron.ipcRenderer.invoke(IPC.TERMINAL_GET_HISTORY, sessionId),
            window.electron.ipcRenderer.invoke(IPC.TERMINAL_GET_CWD, sessionId),
            window.electron.ipcRenderer.invoke(IPC.CONFIG_GET_SYSTEM_PATHS).catch(() => null),
            // Get project file listing so the agent knows what already exists
            window.electron.ipcRenderer.invoke(IPC.TERMINAL_EXEC, {
              sessionId,
              command: listCommand,
            }).catch(() => null),
            window.electron.ipcRenderer.invoke(IPC.TERMINAL_GET_SYSTEM_INFO, sessionId).catch(() => null),
          ]);

          sessionHistory = cleanContextForAI(rawHistory);
          cwd = fetchedCwd || "";

          if (dirListing?.stdout) {
            projectFiles = dirListing.stdout.trim();
          }

          if (paths && !session?.sshProfileId) {
            // Only show local system paths for local sessions — irrelevant for SSH
            systemPathsStr = `
System Paths:
- Home: ${paths.home}
- Desktop: ${paths.desktop}
- Documents: ${paths.documents}
- Downloads: ${paths.downloads}
- Temp: ${paths.temp}
`;
          }

          if (sysInfo) {
            const platformNames: Record<string, string> = {
              darwin: "macOS", win32: "Windows", linux: "Linux",
            };
            const sshLabel = session?.sshProfileId ? " [Remote SSH Session]" : "";
            systemPathsStr += `\nSystem: ${platformNames[sysInfo.platform] || sysInfo.platform} (${sysInfo.arch}), Shell: ${sysInfo.shell}${sshLabel}\n`;
          }

          // SSH session: inform agent about remote context
          if (session?.sshProfileId) {
            systemPathsStr += `\n[REMOTE SSH SESSION] You are connected to a remote machine via SSH. All commands (execute_command, run_in_terminal) run on the remote host. All file tools (read_file, write_file, edit_file, list_dir, search_dir) work on the remote host.\n`;
          }
        }

        // 2. Context Compression
        const contextLimit =
          session?.aiConfig?.contextWindow ||
          aiService.getConfig().contextWindow ||
          16000;

        if (session?.contextSummary) {
          // After summarization, terminal history was cleared — sessionHistory is only new output.
          sessionHistory = sessionHistory.trim()
            ? `[PREVIOUS CONTEXT SUMMARIZED]\n${session.contextSummary}\n\n[RECENT TERMINAL OUTPUT]\n${sessionHistory}`
            : `[PREVIOUS CONTEXT SUMMARIZED]\n${session.contextSummary}`;
        } else if (sessionHistory.length > contextLimit) {
          const summary = await aiService.summarizeContext(
            sessionHistory.slice(-contextLimit),
            "moderate",
          );
          sessionHistory = `[CONTEXT SUMMARIZED]\n${summary}`;
        }

        // 3. Construct Augmented Prompt with Prior Agent Interactions
        // session?.interactions may be stale (from render closure), so read from
        // the interactions we know exist at this point — the current prompt was
        // just added but may not be reflected in `session` yet.
        const priorInteractions = (session?.interactions || [])
          .slice(-6)
          .map((i) => {
            const role = i.role === "user" ? "User" : "Agent";
            const text = typeof i.content === "string" ? i.content : "";
            // Truncate to first 80 chars to prevent the model from re-executing old tasks
            const summary = text.length > 80 ? text.slice(0, 80) + "…" : text;
            return `${role}: ${summary}`;
          })
          .join("\n");

        // Always include history section so the agent sees prior prompts + responses
        const interactionContext = priorInteractions
          ? `\n[PRIOR CONVERSATION — reference only, do NOT re-execute previous tasks]\n${priorInteractions}\n`
          : "";

        if (images && images.length > 0) {
          // Image analysis mode: strip noisy terminal context to avoid the model
          // latching onto project files / history and executing random commands.
          // Put the image instruction front-and-center.
          finalPrompt = `[IMAGE ANALYSIS — READ CAREFULLY]
The user has attached ${images.length} image(s). The images are ALREADY EMBEDDED in this message — you can SEE them directly as inline visual content. You do NOT need to open, read, or access any files. Do NOT use read_file, execute_command, or ls to find the images. They are RIGHT HERE in this conversation.

Current Working Directory: ${cwd || "Unknown"}

User: ${prompt}

Respond with {"tool":"final_answer","content":"your detailed description of what you see in the image(s), plus any response to the user's request"}. If the user explicitly asks you to perform actions based on the image (e.g. "implement this design"), you may then use other tools AFTER first describing what you see.`;
        } else {
          finalPrompt = `
[ENVIRONMENT]
Current Working Directory: ${cwd || "Unknown"}${systemPathsStr}
${projectFiles ? `\n[PROJECT FILES]\n${projectFiles}\n` : ""}
[TERMINAL OUTPUT]
${sessionHistory}
${interactionContext}
[CURRENT TASK — focus ONLY on this, ignore all prior tasks above]
${prompt}
`;
        }
      } // end else (new run — not continuing from question)

      const finalAnswer = await aiService.runAgent(
        finalPrompt,
        async (cmd) => {
          // Helper: Check Permissions — use ref for latest value
          // Dangerous commands always require confirmation, even with auto-exec on
          const checkPermission = async (command: string) => {
            if (alwaysAllowRef.current && !isDangerousCommand(command)) return;
            setPendingCommand(command);
            const allowed = await new Promise<boolean>((resolve) => {
              setPermissionResolve(resolve);
            });
            setPendingCommand(null);
            setPermissionResolve(null);

            if (!allowed) {
              throw new Error("User denied command execution.");
            }
          };

          await checkPermission(cmd);

          if (!sessionId) {
            throw new Error("No terminal session found.");
          }

          addToHistory(cmd.trim());

          // Execute via execInTerminal (runs in PTY, captures output)
          const result = await window.electron.ipcRenderer.invoke(IPC.TERMINAL_EXEC_IN_TERMINAL, {
            sessionId,
            command: cmd,
          });

          // Timeout — process is still running (not killed). Agent should monitor with read_terminal.
          if (result.exitCode === 124) {
            const partial = result.stdout || "";
            // Prefix with __TIMEOUT__ so agent loop knows to set terminalBusy = true
            const msg = partial
              ? `(Command is still running — this is normal for long operations like docker, builds, installs. Output so far:)\n${partial}\n\n(Use read_terminal to monitor progress. The process may take several minutes. Do NOT run another execute_command or Ctrl+C — wait patiently.)`
              : "(Command is running with no output yet. Use read_terminal to check progress — it may take a while.)";
            return "__TIMEOUT__" + msg;
          }

          // Error
          if (result.exitCode !== 0) {
            throw new Error(
              `Exit Code ${result.exitCode}: ${result.stderr || result.stdout || "Command failed"}`,
            );
          }

          // Success
          return result.stdout || "(Command executed successfully with no output)";
        },
        async (cmd: string, isRawInput?: boolean, checkPerm?: boolean) => {
          // writeToTerminal: used for run_in_terminal AND send_text
          // For send_text (isRawInput=true, no checkPerm): write directly, no permission
          // For run_in_terminal (isRawInput=true, checkPerm=true): check permission, then raw write
          if (isRawInput) {
            if (checkPerm) {
              const displayCmd = cmd.replace(/\r$/, "");
              // Skip permission only if auto-exec on AND command is not dangerous
              if (!(alwaysAllowRef.current && !isDangerousCommand(displayCmd))) {
                setPendingCommand(displayCmd);
                const allowed = await new Promise<boolean>((resolve) => {
                  setPermissionResolve(resolve);
                });
                setPendingCommand(null);
                setPermissionResolve(null);
                if (!allowed) {
                  throw new Error("User denied command execution.");
                }
              }
            }
            if (!window.electron) return;
            // For run_in_terminal: clear any user-typed text before injecting command
            const sendRawCmd = () => {
              window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
                id: sessionId,
                data: cmd,
              });
              if (checkPerm) addToHistory(cmd.replace(/\r$/, "").trim());
            };
            if (checkPerm) {
              window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
                id: sessionId,
                data: isWindows() ? "\x1b" : "\x15", // Esc for Win, Ctrl+U for Unix
              });
              // On Windows, delay so PSReadLine processes Esc as standalone keypress
              if (isWindows()) {
                await new Promise((r) => setTimeout(r, 50));
              }
            }
            sendRawCmd();
            return;
          }

          // For other commands: check permission, send with Ctrl+C prefix
          // Dangerous commands always require confirmation, even with auto-exec on
          const checkPermission = async (command: string) => {
            if (alwaysAllowRef.current && !isDangerousCommand(command)) return;
            setPendingCommand(command);
            const allowed = await new Promise<boolean>((resolve) => {
              setPermissionResolve(resolve);
            });
            setPendingCommand(null);
            setPermissionResolve(null);

            if (!allowed) {
              throw new Error("User denied command execution.");
            }
          }

          await checkPermission(cmd);

          const cleaned = cmd.endsWith("\n") ? cmd.slice(0, -1) : cmd;
          writeCommandToTerminal(cleaned);
          addToHistory(cmd.trim());
        },
        async (lines) => {
          if (!sessionId) return "No terminal session";
          // Try xterm.js screen buffer first (gives clean TUI output)
          const screenContent = readScreenBuffer(sessionId, lines);
          if (screenContent) return screenContent;
          // Fall back to raw PTY history via IPC
          try {
            const result = await window.electron.ipcRenderer.invoke(IPC.TERMINAL_READ_HISTORY, {
              sessionId,
              lines,
            });
            return result || "(No output yet)";
          } catch (err: any) {
            console.error("readTerminal IPC failed:", err);
            return `(Read terminal error: ${err.message})`;
          }
        },
        (step, output, payload) => {
          const THROTTLE_MS = 100; // Max ~10 updates/sec for streaming

          // Streaming steps: buffer and throttle to reduce re-renders
          if (step === "streaming_thinking" || step === "streaming_response") {
            const buf = streamBufferRef.current;
            buf.output = output;
            buf.step = step;

            const now = Date.now();
            const elapsed = now - buf.lastFlush;
            if (elapsed >= THROTTLE_MS) {
              flushStreamBuffer();
            } else if (!buf.timer) {
              buf.timer = setTimeout(flushStreamBuffer, THROTTLE_MS - elapsed);
            }

            // isThinking transitions (bail-early in AgentContext deduplicates)
            if (step === "streaming_thinking") {
              setIsThinking(true);
            } else {
              setIsThinking(false);
            }
            return;
          }

          // Non-streaming step: flush any pending buffer first
          flushStreamBuffer();

          if (step === "thinking_complete") {
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
          } else if (step === "thinking") {
            // Always show thinking indicator — even for non-thinking models
            setIsThinking(true);
          } else {
            // Plan: replace streaming entry with structured plan step
            if (step === "plan") {
              setAgentThread((prev) => {
                const cleaned = prev.filter(s => s.step !== "streaming");
                return [...cleaned, { step: "plan", output: "", payload }];
              });
              return;
            }

            // Real step arrived — clean all streaming entries, then update
            setAgentThread((prev) => {
              const cleaned = prev.filter(s => s.step !== "streaming");

              // "read_terminal" → merge into the last read_terminal entry in current run
              if (step === "read_terminal") {
                for (let j = cleaned.length - 1; j >= 0; j--) {
                  if (cleaned[j].step === "separator") break;
                  if (cleaned[j].step === "read_terminal") {
                    cleaned[j] = { step, output, payload };
                    return cleaned;
                  }
                }
                return [...cleaned, { step, output, payload }];
              }

              // "executed"/"failed" → transform the preceding "executing" entry in-place
              if (step === "executed" || step === "failed") {
                for (let j = cleaned.length - 1; j >= 0; j--) {
                  if (cleaned[j].step === "executing") {
                    cleaned[j] = { step, output, payload };
                    return cleaned;
                  }
                }
              }

              return [...cleaned, { step, output, payload }];
            });
            setIsThinking(false);
          }
        },
        session?.aiConfig,
        controller.signal,
        thinkingEnabled && modelSupportsThinking,
        currentContinuation || undefined,
        images,
        { isSSH: !!session?.sshProfileId, sessionId },
        async (description: string) => {
          if (alwaysAllowRef.current) return;
          setPendingCommand(description);
          const allowed = await new Promise<boolean>((resolve) => {
            setPermissionResolve(resolve);
          });
          setPendingCommand(null);
          setPermissionResolve(null);
          if (!allowed) {
            throw new Error("User denied file operation.");
          }
        },
      );

      // Flush any remaining streaming buffer before processing final answer
      flushStreamBuffer();

      // Save continuation for question follow-ups
      if (finalAnswer.continuation) {
        continuationRef.current = finalAnswer.continuation;
      }

      // Ensure successful completion clears active state
      setIsAgentRunning(false);
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId, running: false } }));

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
        // Remove leftover streaming entries
        const cleaned = prev.filter(s => s.step !== "streaming" && s.step !== "streaming_response");
        return [...cleaned, { step: finalStep, output: finalOutput, payload: finalAnswer.payload }];
      });

      // Persist Agent Conclusion to Session State (Invisible Context)
      if (sessionId && finalAnswer.message) {
        addInteraction(sessionId, {
          role: "agent",
          content: finalAnswer.message,
          timestamp: Date.now(),
        });
      }

      // Generate smart tab title now that the model is free
      if (shouldGenerateTitle) {
        const titleContext = finalAnswer.message
          ? `${prompt}\n[AGENT RESPONSE]: ${finalAnswer.message.slice(0, 200)}`
          : prompt;
        aiService.generateTabTitle(titleContext, session?.aiConfig).then((t) => {
          if (t) {
            renameTab(sessionId, t);
            updateSession(sessionId, { titleLocked: true });
          }
        });
      }
    } catch (error: any) {
      // Clear streaming buffer (don't flush stale data on error/abort)
      clearStreamBuffer();
      const isAbort =
        error.name === "AbortError" ||
        error.message?.toLowerCase().includes("abort");
      if (!isAbort) {
        // Only add error for non-abort failures.
        // Abort is handled by stopAgent() which already adds a "stopped" step.
        console.error(error);
        setAgentThread((prev) => [
          ...prev.filter(s => s.step !== "streaming" && s.step !== "streaming_response"),
          { step: "error", output: `Error: ${error.message}` },
        ]);
        setIsAgentRunning(false);
        window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId, running: false } }));
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
    // True when agent returned ask_question and is waiting for user's answer
    awaitingAnswer: !!continuationRef.current,
    // Model info
    modelCapabilities,
    // Actions
    handleCommand,
    handleCommandInOverlay,
    handleAgentRun,
    handlePermission,
  };
}
