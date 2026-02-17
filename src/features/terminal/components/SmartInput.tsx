import { useState, useEffect, useRef, useCallback } from "react";
import type { KeyboardEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  isCommand,
  isDefinitelyNaturalLanguage,
  isKnownExecutable,
} from "../../../utils/commandClassifier";
import { aiService } from "../../../services/ai";
import { useHistory } from "../../../contexts/HistoryContext";
import { Terminal, Sparkles, Bot, ChevronRight } from "lucide-react";
import { useTheme } from "../../../contexts/ThemeContext";
import { useAgent } from "../../../contexts/AgentContext";
import { useLayout } from "../../../contexts/LayoutContext";
import { slideDown, fadeScale } from "../../../utils/motion";

interface SmartInputProps {
  onSend: (value: string) => void;
  onRunAgent: (prompt: string) => Promise<void>;
  isAgentRunning: boolean;
  pendingCommand: string | null;
  sessionId?: string;
}

const SmartInput: React.FC<SmartInputProps> = ({
  onSend,
  onRunAgent,
  isAgentRunning,
  pendingCommand,
  sessionId,
}) => {
  const { resolvedTheme: theme } = useTheme();
  const { activeSessionId } = useLayout();
  const { stopAgent } = useAgent(activeSessionId || "");

  const { history, addToHistory } = useHistory();
  const [value, setValue] = useState("");
  // Mode State
  const [isAuto, setIsAuto] = useState(true);
  const [mode, setMode] = useState<"command" | "advice" | "agent">("command");

  const [isLoading, setIsLoading] = useState(false);
  const [suggestedCommand, setSuggestedCommand] = useState<string | null>(null);
  const [ghostText, setGhostText] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState("");

  // Autocomplete & History State
  const [completions, setCompletions] = useState<string[]>([]);
  const [showCompletions, setShowCompletions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState("");

  // AI-generated placeholder
  const [aiPlaceholder, setAiPlaceholder] = useState("");
  const placeholderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch AI placeholder when input is empty
  useEffect(() => {
    if (placeholderTimerRef.current) clearTimeout(placeholderTimerRef.current);
    if (value.trim() !== "" || !sessionId || isAgentRunning) {
      return;
    }
    placeholderTimerRef.current = setTimeout(async () => {
      try {
        if (!window.electron?.ipcRenderer?.getHistory) return;
        const history = await window.electron.ipcRenderer.getHistory(sessionId);
        if (!history || history.length < 10) return;
        const suggestion = await aiService.generatePlaceholder(history);
        if (suggestion) setAiPlaceholder(suggestion);
      } catch {
        // Non-critical, silently ignore
      }
    }, 3000);
    return () => {
      if (placeholderTimerRef.current)
        clearTimeout(placeholderTimerRef.current);
    };
  }, [value, sessionId, isAgentRunning]);

  // Clear feedback after delay
  useEffect(() => {
    if (feedbackMsg) {
      const timer = setTimeout(() => setFeedbackMsg(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [feedbackMsg]);

  // Auto-focus when session becomes active
  useEffect(() => {
    // Check if parent container says we are active
    // We don't have explicit 'isActive' prop, but we can infer from session context if needed or assume mount.
    // However, user said "switch to tab". If SmartInput is unmounted/remounted, autoFocus works.
    // If it stays mounted (hidden), we need a signal.
    // Let's rely on the fact that `sessionId === activeSessionId` in parent prop if we passed it?
    // We passed `sessionId`. We can check if it matches `activeSessionId`.
    if (activeSessionId === sessionId && inputRef.current) {
      // Small timeout to ensure layout is ready
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [activeSessionId, sessionId]);

  // Auto-detect mode hierarchy
  useEffect(() => {
    if (!isAuto) return;

    if (value.trim() === "") {
      setMode("command");
      setCompletions([]);
      setShowCompletions(false);
      return;
    }

    // 1. If input is clearly natural language, skip everything
    if (isDefinitelyNaturalLanguage(value)) {
      setMode("agent");
      return;
    }

    // 2. Static classifier (fast, handles known commands)
    if (isCommand(value)) {
      setMode("command");
      return;
    }

    const words = value.trim().split(/\s+/);
    const firstWord = words[0];

    // 3. Known Command Fallback (Ambiguous Verbs)
    // If isCommand returned false BUT it is in the known list (e.g. "find" without flags),
    // it means we deliberately classified it as Agent. DO NOT check PATH.
    // "isKnownExecutable" needs to be imported
    if (isKnownExecutable(firstWord)) {
      setMode("agent");
      return;
    }

    // 4. Unknown Word Fallback: Check PATH dynamically
    // This covers third-party tools (ollama, aws, etc.) that aren't in the hardcoded list
    if (words.length >= 1 && window.electron?.ipcRenderer?.checkCommand) {
      window.electron.ipcRenderer
        .checkCommand(words[0])
        .then((exists: boolean) => {
          setMode(exists ? "command" : "agent");
        });
    } else {
      setMode("agent");
    }
  }, [value, isAuto]);

  // Fetch completions — works in command mode and auto mode
  const fetchCompletions = useCallback(
    (input: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const shouldComplete =
        input.trim().length > 0 &&
        !!window.electron?.ipcRenderer?.getCompletions &&
        (mode === "command" || isAuto);
      if (!shouldComplete) {
        setCompletions([]);
        setShowCompletions(false);
        setGhostText("");
        return;
      }

      debounceRef.current = setTimeout(async () => {
        try {
          const results = await window.electron.ipcRenderer.getCompletions(
            input.trim(),
            undefined,
            activeSessionId || undefined,
          );
          setCompletions(results);
          setShowCompletions(results.length > 0);
          setSelectedIndex(0);

          // Ghost text from best match
          if (results.length > 0) {
            const best = results[0];
            const parts = input.trimEnd().split(/\s+/);
            const lastWord = parts[parts.length - 1];
            if (
              best &&
              best.toLowerCase().startsWith(lastWord.toLowerCase()) &&
              best.length > lastWord.length
            ) {
              setGhostText(best.slice(lastWord.length));
            } else {
              setGhostText("");
            }
          } else {
            setGhostText("");
          }
        } catch {
          setCompletions([]);
          setShowCompletions(false);
          setGhostText("");
        }
      }, 80);
    },
    [mode, isAuto, activeSessionId],
  );

  useEffect(() => {
    fetchCompletions(value);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, fetchCompletions]);

  const acceptCompletion = (completion: string) => {
    const parts = value.trimEnd().split(/\s+/);
    parts.pop(); // Remove partial word
    parts.push(completion); // Add completion
    const newValue = parts.join(" ") + " ";
    setValue(newValue);
    setCompletions([]);
    setShowCompletions(false);
    setGhostText("");
    setSelectedIndex(0);
  };

  const handleSend = () => {
    // Trigger same logic as Enter
    handleKeyDown({ key: "Enter", preventDefault: () => {} } as any);
  };

  // Shift Key Logic: Double-tap shift to switch mode
  // Track shift press state and last tap timestamp for double-tap detection
  const shiftPressedRef = useRef(false);
  const otherKeyPressedRef = useRef(false);
  const lastShiftTapRef = useRef(0);
  const DOUBLE_TAP_THRESHOLD = 400; // ms

  const handleKeyUp = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Shift") {
      if (!otherKeyPressedRef.current && shiftPressedRef.current) {
        // Clean shift tap (no other keys pressed during hold)
        const now = Date.now();
        if (now - lastShiftTapRef.current < DOUBLE_TAP_THRESHOLD) {
          // Double-tap detected -> Switch mode
          lastShiftTapRef.current = 0; // Reset to prevent triple-tap
          if (isAuto) {
            setIsAuto(false);
            setMode("command");
          } else if (mode === "command") {
            setIsAuto(false);
            setMode("advice");
          } else if (mode === "advice") {
            setIsAuto(false);
            setMode("agent");
          } else {
            setIsAuto(true);
          }
        } else {
          lastShiftTapRef.current = now;
        }
      }
      shiftPressedRef.current = false;
      otherKeyPressedRef.current = false;
    }
  };

  const handleKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    // Track Shift key state
    if (e.key === "Shift") {
      shiftPressedRef.current = true;
      return; // Don't do anything else on Shift down
    }
    if (shiftPressedRef.current) {
      otherKeyPressedRef.current = true;
    }

    // Tab / Right Arrow: Accept Ghost Text OR Selected Completion OR Placeholder
    // Strict Tab behavior: Only accept, never cycle
    if (e.key === "Tab" || e.key === "ArrowRight") {
      if (ghostText || (showCompletions && completions.length > 0)) {
        e.preventDefault();
        if (showCompletions && completions[selectedIndex]) {
          acceptCompletion(completions[selectedIndex]);
        } else if (ghostText) {
          setValue((prev) => prev + ghostText);
          setGhostText("");
        }
      } else if (aiPlaceholder && !value) {
        // Accept AI placeholder if input is empty
        e.preventDefault();
        setValue(aiPlaceholder);
        setAiPlaceholder("");
      } else if (e.key === "Tab") {
        // If nothing to complete, prevent default Tab behavior (blur) to keep focus?
        // Or let it blur? User said "replace tab hot key for accept... use shift to switch".
        // Usually better to prevent blur in a terminal input.
        e.preventDefault();
      }
      return;
    }

    // Escape: Dismiss
    if (e.key === "Escape") {
      setCompletions([]);
      setShowCompletions(false);
      setGhostText("");
      setSuggestedCommand(null);
      return;
    }

    // Mode Switching Hotkeys
    if (e.metaKey && e.key === "1") {
      e.preventDefault();
      setIsAuto(false);
      setMode("command");
      return;
    }
    if (e.metaKey && e.key === "2") {
      e.preventDefault();
      setIsAuto(false);
      setMode("advice");
      return;
    }
    if (e.metaKey && e.key === "3") {
      e.preventDefault();
      setIsAuto(false);
      setMode("agent");
      return;
    }
    if (e.metaKey && e.key === "0") {
      e.preventDefault();
      setIsAuto(true);
      return;
    }

    // Up/Down: Priority to Dropdown, then History
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (showCompletions && completions.length > 0) {
        const newIndex =
          selectedIndex <= 0 ? completions.length - 1 : selectedIndex - 1;
        setSelectedIndex(newIndex);
      } else {
        if (history.length === 0) return;
        if (historyIndex === -1) {
          setSavedInput(value);
          const newIndex = history.length - 1;
          setHistoryIndex(newIndex);
          setValue(history[newIndex]);
        } else if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setValue(history[newIndex]);
        }
        setTimeout(() => {
          if (inputRef.current)
            inputRef.current.setSelectionRange(
              inputRef.current.value.length,
              inputRef.current.value.length,
            );
        }, 0);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (showCompletions && completions.length > 0) {
        const newIndex =
          selectedIndex >= completions.length - 1 ? 0 : selectedIndex + 1;
        setSelectedIndex(newIndex);
      } else {
        if (historyIndex === -1) return;
        if (historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          setValue(history[newIndex]);
        } else {
          setHistoryIndex(-1);
          setValue(savedInput);
        }
      }
      return;
    }

    // Enter
    if (e.key === "Enter") {
      e.stopPropagation(); // Prevent terminal from also receiving this Enter
      if (e.shiftKey) {
        e.preventDefault();
        setFeedbackMsg("Agent Started");
        onRunAgent(value);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setShowCompletions(false);
        return;
      }

      e.preventDefault();

      if (showCompletions && completions[selectedIndex]) {
        const selected = completions[selectedIndex];
        // Apply completion and EXECUTE immediately
        const parts = value.trimEnd().split(/\s+/);
        parts.pop();
        parts.push(selected);
        const finalVal = parts.join(" "); // No trailing space for execution

        if (mode === "command") {
          setFeedbackMsg("");
          addToHistory(finalVal);
          onSend(finalVal);
          setValue("");
          setCompletions([]);
          setShowCompletions(false);
          setHistoryIndex(-1);
          return;
        }

        // If not command mode (unlikely for completions?), fall through or handle similar to above
        // But completions are currently only for command/auto mode.
        // If in auto mode and we picked a completion, treat as command.
        setFeedbackMsg("");
        addToHistory(finalVal);
        onSend(finalVal);
        setValue("");
        setCompletions([]);
        setShowCompletions(false);
        setHistoryIndex(-1);
        return;
      }

      const finalVal = value.trim();
      if (finalVal === "") return;

      if (suggestedCommand) {
        const cmd = suggestedCommand;
        setSuggestedCommand(null);
        addToHistory(cmd);
        onSend(cmd);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setShowCompletions(false);
        return;
      }

      // Execute based on active mode
      if (mode === "command") {
        setFeedbackMsg("");
        addToHistory(finalVal);
        onSend(finalVal);
      } else if (mode === "agent") {
        setFeedbackMsg("Agent Started");
        onRunAgent(finalVal);
      } else if (mode === "advice") {
        setIsLoading(true);
        setFeedbackMsg("Asking AI...");
        setShowCompletions(false);
        setCompletions([]);
        setGhostText("");
        setSuggestedCommand("");
        try {
          const cmd = await aiService.generateCommand(value, (token) => {
            setSuggestedCommand((prev) => (prev || "") + token);
          });
          setSuggestedCommand(cmd);
          setFeedbackMsg("");
        } catch (err) {
          console.error(err);
          setFeedbackMsg("AI Error");
          setSuggestedCommand(null);
        } finally {
          setIsLoading(false);
        }
        return;
      }

      // Cleanup
      setValue("");
      setGhostText("");
      setCompletions([]);
      setHistoryIndex(-1);
    }
  };

  const suggestion = suggestedCommand;
  const currentCompletion =
    showCompletions && completions.length > 0
      ? completions[selectedIndex]
      : null;

  return (
    <div className="w-full flex flex-col relative gap-2 z-100">
      <div
        className={`relative w-full transition-all duration-300 rounded-lg border px-3 py-2 flex flex-col gap-1 z-10 ${
          mode === "agent"
            ? theme === "light"
              ? "bg-purple-50 border-purple-300 shadow-sm text-purple-900"
              : "bg-purple-950/40 border-purple-500/30 shadow-[0_0_20px_rgba(168,85,247,0.08)] backdrop-blur-md text-purple-100"
            : mode === "advice"
              ? theme === "light"
                ? "bg-blue-50 border-blue-300 shadow-sm text-blue-900"
                : "bg-blue-950/30 border-blue-500/25 shadow-[0_0_15px_rgba(59,130,246,0.06)] backdrop-blur-md text-blue-100"
              : theme === "light"
                ? "bg-white border-gray-200 shadow-sm text-black"
                : theme === "modern"
                  ? "bg-white/[0.03] border-white/[0.08] text-gray-100 backdrop-blur-2xl"
                  : "bg-[#0e0e0e] border-white/10 text-gray-200 shadow-xl"
        }`}
      >
        <div className="flex items-center gap-2">
          {/* Mode Switcher */}
          <div className="relative group/mode">
            <button
              className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
                isAuto
                  ? "bg-teal-500/10 text-teal-400"
                  : mode === "agent"
                    ? "bg-purple-500/10 text-purple-400"
                    : mode === "advice"
                      ? "bg-blue-500/10 text-blue-400"
                      : "bg-white/5 text-gray-400 hover:text-white"
              }`}
              onClick={() => {
                if (isAuto) {
                  setIsAuto(false);
                  setMode("command");
                } else if (mode === "command") {
                  setMode("advice");
                } else if (mode === "advice") {
                  setMode("agent");
                } else {
                  setIsAuto(true);
                }
              }}
            >
              {isAuto ? (
                <Sparkles className="w-3 h-3" />
              ) : mode === "agent" ? (
                <Bot className="w-4 h-4" />
              ) : mode === "advice" ? (
                <Sparkles className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>

            {/* Mode Dropdown */}
            <div className="absolute bottom-full left-0 hidden group-hover/mode:block z-100">
              <div
                className={`mb-0 w-36 rounded-lg shadow-xl overflow-hidden border ${
                  theme === "light"
                    ? "bg-white border-gray-200"
                    : "bg-[#1e1e1e] border-white/10"
                }`}
              >
                {[
                  {
                    id: "auto",
                    label: "Auto",
                    shortcut: "⌘0",
                    icon: <Sparkles className="w-3 h-3" />,
                  },
                  {
                    id: "command",
                    label: "Command",
                    shortcut: "⌘1",
                    icon: <ChevronRight className="w-3 h-3" />,
                  },
                  {
                    id: "advice",
                    label: "Advice",
                    shortcut: "⌘2",
                    icon: <Sparkles className="w-3 h-3" />,
                  },
                  {
                    id: "agent",
                    label: "Agent",
                    shortcut: "⌘3",
                    icon: <Bot className="w-3 h-3" />,
                  },
                ].map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      if (m.id === "auto") {
                        setIsAuto(true);
                        setMode("command");
                      } else {
                        setIsAuto(false);
                        setMode(m.id as any);
                      }
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${
                      theme === "light"
                        ? (isAuto && m.id === "auto") ||
                          (!isAuto && mode === m.id)
                          ? "text-gray-900 bg-gray-100"
                          : "text-gray-600 hover:bg-gray-50"
                        : (isAuto && m.id === "auto") ||
                            (!isAuto && mode === m.id)
                          ? "text-white bg-white/5"
                          : "text-gray-400 hover:bg-white/5"
                    }`}
                  >
                    <span className="w-4 text-center flex justify-center">
                      {m.icon}
                    </span>
                    <span className="flex-1">{m.label}</span>
                    <span className="text-[10px] opacity-40">{m.shortcut}</span>
                  </button>
                ))}
              </div>
              <div className="h-1" />
            </div>
          </div>

          <div className="relative flex-1">
            <div className="absolute inset-0 flex items-center pointer-events-none font-mono text-sm whitespace-pre overflow-hidden">
              <span className="invisible">{value}</span>
              <span className="text-gray-600 opacity-50">
                {ghostText ||
                  (currentCompletion && currentCompletion.startsWith(value)
                    ? currentCompletion.slice(value.length)
                    : "")}
              </span>
            </div>

            <input
              ref={inputRef}
              type="text"
              className={`w-full bg-transparent font-mono text-sm outline-none ${
                theme === "light"
                  ? "text-gray-900 placeholder-gray-400"
                  : "text-gray-100 placeholder-gray-500"
              }`}
              placeholder={
                aiPlaceholder ||
                (isAuto
                  ? "Type a command or ask a question..."
                  : mode === "command"
                    ? "Type a command..."
                    : mode === "agent"
                      ? "Describe a task for the agent..."
                      : "Ask AI for advice...")
              }
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setHistoryIndex(-1);
                setSuggestedCommand(null);
                if (e.target.value.trim() !== "") setAiPlaceholder("");
              }}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              autoFocus
              disabled={
                isLoading || (isAgentRunning && pendingCommand !== null)
              }
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <button
            onClick={
              isLoading || isAgentRunning
                ? () => stopAgent && stopAgent()
                : () => handleSend()
            }
            className={`p-1.5 rounded-md transition-colors ${
              theme === "light"
                ? "hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                : "hover:bg-white/10 text-gray-500 hover:text-white"
            } ${isLoading || isAgentRunning ? "text-red-400 hover:text-red-300 hover:bg-red-500/10" : ""}`}
            title={isLoading || isAgentRunning ? "Stop Agent (Ctrl+C)" : "Run"}
          >
            {isLoading || isAgentRunning ? (
              <div className="w-4 h-4 flex items-center justify-center">
                <div className="w-2.5 h-2.5 bg-current rounded-sm" />
              </div>
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Hints bar */}
      <div
        className={`flex items-center justify-between px-2 h-5 text-[10px] select-none overflow-hidden whitespace-nowrap ${
          theme === "light" ? "text-gray-500" : "text-gray-400"
        }`}
      >
        {/* Left: mode indicator + feedback */}
        <div className="flex items-center gap-2 shrink-0">
          {isAuto ? (
            <span
              className={`font-medium ${mode === "agent" ? "text-purple-400" : "text-teal-400"}`}
              title="Auto-detects command vs natural language"
            >
              auto · {mode}
            </span>
          ) : (
            <span
              className={`font-medium ${
                mode === "agent"
                  ? "text-purple-400"
                  : mode === "advice"
                    ? "text-blue-400"
                    : ""
              }`}
            >
              {mode}
            </span>
          )}
          {feedbackMsg && (
            <span className="animate-in fade-in opacity-70">{feedbackMsg}</span>
          )}
        </div>

        {/* Right: shortcuts */}
        <div
          className={`flex items-center gap-0.5 shrink-0 ${
            theme === "light" ? "opacity-70" : "opacity-80"
          }`}
        >
          <span>⇧⇧ next mode</span>
          <span className="opacity-40 mx-1">·</span>
          <span>⇧↵ agent</span>
          <span className="opacity-40 mx-1">·</span>
          <span>⌘0-3 mode</span>
          <span className="opacity-40 mx-1">·</span>
          <span>⌘T tab</span>
          <span className="opacity-40 mx-1">·</span>
          <span>⌘D split</span>
        </div>
      </div>

      {/* Completions Dropdown */}
      <AnimatePresence>
        {showCompletions && completions.length > 0 && (
          <motion.div
            key="completions"
            variants={slideDown}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute bottom-full left-0 mb-1 w-full max-w-md bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl overflow-hidden z-20 max-h-60 overflow-y-auto"
          >
            {completions.map((comp, i) => (
              <motion.div
                key={comp}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.02, duration: 0.15 }}
                className={`px-3 py-2 text-xs font-mono cursor-pointer flex items-center gap-2 ${
                  i === selectedIndex
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:bg-white/5"
                }`}
                onClick={() => {
                  acceptCompletion(comp);
                  setTimeout(() => handleSend(), 0);
                }}
              >
                <Terminal className="w-3 h-3 opacity-50" />
                {comp}
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Advice/Command Suggestion Output */}
      <AnimatePresence>
        {suggestion !== null && mode !== "agent" && (
          <motion.div
            key="suggestion"
            variants={fadeScale}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute bottom-full left-0 mb-2 w-full bg-[#1a1a1a]/90 backdrop-blur border border-purple-500/20 rounded-lg p-3 shadow-xl z-10 max-h-48 overflow-y-auto"
          >
            <div className="flex items-start gap-3">
              <Sparkles
                className={`w-4 h-4 text-purple-400 mt-0.5 shrink-0 ${isLoading ? "animate-pulse" : ""}`}
              />
              <div className="flex-1">
                <div className="text-purple-200 text-sm font-medium mb-1">
                  AI Suggestion
                </div>
                <div className="text-gray-300 text-xs leading-relaxed font-mono">
                  {suggestion ||
                    (isLoading ? (
                      <span className="text-gray-500 italic">Generating...</span>
                    ) : (
                      ""
                    ))}
                  {isLoading && suggestion && (
                    <span className="inline-block w-1.5 h-3 bg-purple-400/60 animate-pulse ml-0.5 align-middle" />
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
export default SmartInput;
