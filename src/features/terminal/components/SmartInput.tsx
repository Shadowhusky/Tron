import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useTransition,
  useMemo,
} from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  isCommand,
  isDefinitelyNaturalLanguage,
  isKnownExecutable,
  isScannedCommand,
  isLikelyImperative,
  loadScannedCommands,
  invalidateScannedCommands,
  getCommandCompletions,
} from "../../../utils/commandClassifier";
import { aiService } from "../../../services/ai";
import { useHistory } from "../../../contexts/HistoryContext";
import {
  Terminal,
  Bot,
  ChevronRight,
  Lightbulb,
  Zap,
  ImagePlus,
  X,
  Clock,
} from "lucide-react";
import type { AttachedImage } from "../../../types";
import { useTheme } from "../../../contexts/ThemeContext";
import { useAgent } from "../../../contexts/AgentContext";
import { useLayout } from "../../../contexts/LayoutContext";
import { useConfig } from "../../../contexts/ConfigContext";
import { matchesHotkey, formatHotkey } from "../../../hooks/useHotkey";
import { slideDown, fadeScale } from "../../../utils/motion";
import { isTouchDevice } from "../../../utils/platform";
import { stripAnsi } from "../../../utils/contextCleaner";

interface SmartInputProps {
  onSend: (value: string) => void;
  onRunAgent: (prompt: string, images?: AttachedImage[]) => Promise<void>;
  isAgentRunning: boolean;
  pendingCommand: string | null;
  sessionId?: string;
  modelCapabilities?: string[] | null;
  defaultAgentMode?: boolean;
  onSlashCommand?: (command: string) => void | Promise<void>;
  draftInput?: string;
  onDraftChange?: (draft: string | undefined) => void;
  sessionAIConfig?: any;
  stopAgent?: () => void;
  thinkingEnabled?: boolean;
  setThinkingEnabled?: (v: boolean) => void;
  activeSessionId?: string | null;
  awaitingAnswer?: boolean;
  focusTarget?: "input" | "terminal";
  onFocusInput?: () => void;
  onBlurInput?: () => void;
  noModelConfigured?: boolean;
  onNoModel?: () => void;
}

/** Thinking display for advice mode — mirrors AgentOverlay's ThinkingBlock */
const AdviceThinkingBlock: React.FC<{
  content: string;
  isLight: boolean;
  isStreaming: boolean;
}> = ({ content, isLight, isStreaming }) => {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const lines = content.split("\n");
  const isTruncated = lines.length > 2;
  const tokenCount = Math.round(content.length / 4);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = dist > 20;
  };

  useEffect(() => {
    if (!expanded) {
      if (scrollRef.current)
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      return;
    }
    if (!userScrolledUpRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, expanded]);

  return (
    <div
      className={`mb-1 rounded border p-1.5 transition-all ${
        isLight
          ? "border-purple-200/50 bg-purple-50/50"
          : "border-purple-500/10 bg-purple-950/20"
      }`}
    >
      <div className="mb-0.5 flex items-center justify-between">
        <span
          className={`text-[9px] font-semibold tracking-wider uppercase ${isLight ? "text-purple-400" : "text-purple-500/80"}`}
        >
          {isStreaming ? "Thinking..." : "Reasoning"}
          {isStreaming && (
            <span className="ml-1 inline-flex gap-0.5 align-middle">
              <span
                className="h-1 w-1 animate-bounce rounded-full bg-purple-400"
                style={{ animationDelay: "0ms" }}
              />
              <span
                className="h-1 w-1 animate-bounce rounded-full bg-purple-400"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="h-1 w-1 animate-bounce rounded-full bg-purple-400"
                style={{ animationDelay: "300ms" }}
              />
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={`font-mono text-[9px] ${isLight ? "text-purple-400" : "text-purple-500/60"}`}
          >
            {tokenCount} tokens
          </span>
          {isTruncated && (
            <button
              onClick={() => {
                setExpanded(!expanded);
                userScrolledUpRef.current = false;
              }}
              className={`text-[9px] tracking-wider uppercase opacity-60 transition-opacity hover:opacity-100 ${
                isLight ? "text-purple-600" : "text-purple-400"
              }`}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={`transition-all ${expanded ? "max-h-40 overflow-y-auto" : "max-h-[2.75rem] overflow-hidden"}`}
        style={
          !expanded && isTruncated
            ? {
                WebkitMaskImage:
                  "linear-gradient(to bottom, transparent 0%, black 60%)",
                maskImage:
                  "linear-gradient(to bottom, transparent 0%, black 60%)",
              }
            : undefined
        }
      >
        <div
          className={`text-[11px] leading-relaxed break-words whitespace-pre-wrap ${isLight ? "text-gray-700" : "text-gray-300"}`}
        >
          {content}
        </div>
      </div>
    </div>
  );
};

/** Sync fallback classification for Enter-time when mode state is stale.
 *  Called when isDefinitelyNaturalLanguage and isCommand both returned false,
 *  AND the auto-detect effect hasn't classified this exact value yet. */
function classifyAtEnter(finalVal: string): "command" | "agent" {
  const words = finalVal.split(/\s+/);
  const fw = words[0];
  // Known executable used without command syntax → agent (imperative verb)
  if (isKnownExecutable(fw)) return "agent";
  // Capitalized first word → natural language
  if (words.length >= 2 && /^[A-Z]/.test(fw)) return "agent";
  // In scanned commands cache → check if imperative use
  if (isScannedCommand(fw)) return isLikelyImperative(finalVal) ? "agent" : "command";
  // If we get here, the word isn't in any known command list.
  // The async auto-detect would also default to "agent" for unknown words.
  // Sending to agent is safe — it can execute commands if needed.
  return "agent";
}

const SmartInput: React.FC<SmartInputProps> = ({
  onSend,
  onRunAgent,
  isAgentRunning,
  pendingCommand,
  sessionId,
  modelCapabilities = [],
  defaultAgentMode = false,
  onSlashCommand,
  draftInput,
  onDraftChange,
  stopAgent: stopAgentProp,
  thinkingEnabled: thinkingEnabledProp,
  setThinkingEnabled: setThinkingEnabledProp,
  activeSessionId: activeSessionIdProp,
  awaitingAnswer = false,
  focusTarget,
  onFocusInput,
  sessionAIConfig,
  noModelConfigured = false,
  onNoModel,
}) => {
  const { resolvedTheme: theme } = useTheme();
  const { activeSessionId: layoutActiveSessionId } = useLayout();
  const activeSessionId = activeSessionIdProp ?? layoutActiveSessionId;
  const {
    stopAgent: stopAgentCtx,
    thinkingEnabled: thinkingEnabledCtx,
    setThinkingEnabled: setThinkingEnabledCtx,
    isOverlayVisible,
  } = useAgent(activeSessionId || "");
  const stopAgent = stopAgentProp ?? stopAgentCtx;
  const thinkingEnabled = thinkingEnabledProp ?? thinkingEnabledCtx;
  const setThinkingEnabled = setThinkingEnabledProp ?? setThinkingEnabledCtx;
  const { hotkeys, aiBehavior } = useConfig();

  const { history, addToHistory } = useHistory();
  const [reactValue, setReactValue] = useState("");
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizeRafRef = useRef<number>(0);

  /** Coalesce textarea auto-resize into a single rAF to avoid forced synchronous layout. */
  const resizeTextarea = useCallback((el: HTMLTextAreaElement) => {
    if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
      resizeRafRef.current = 0;
    });
  }, []);

  // Initialize from draft input (persisted across tab switches)
  const draftApplied = useRef(false);
  useEffect(() => {
    if (draftInput && !draftApplied.current) {
      draftApplied.current = true;
      setReactValue(draftInput);
      if (inputRef.current) inputRef.current.value = draftInput;
    }
  }, [draftInput]);

  const value = reactValue;
  const setValue = useCallback(
    (valOrUpdater: string | ((prev: string) => string)) => {
      setReactValue((prev) => {
        const newVal =
          typeof valOrUpdater === "function"
            ? valOrUpdater(prev)
            : valOrUpdater;
        if (inputRef.current && inputRef.current.value !== newVal) {
          inputRef.current.value = newVal;
          resizeTextarea(inputRef.current);
        }
        return newVal;
      });
    },
    [resizeTextarea],
  );

  // Sync draft persistence outside render phase to avoid setState-during-render
  useEffect(() => {
    onDraftChange?.(reactValue || undefined);
  }, [reactValue, onDraftChange]);

  // Mode State
  const [isAuto, setIsAuto] = useState(true);
  const [mode, setMode] = useState<"command" | "advice" | "agent">(
    defaultAgentMode ? "agent" : "command",
  );
  // Track which value the mode was last classified for — detects stale mode at Enter time
  const modeClassifiedForRef = useRef("");

  const [isLoading, setIsLoading] = useState(false);
  const adviceAbortRef = useRef<AbortController | null>(null);
  const [suggestedCommand, setSuggestedCommand] = useState<string | null>(null);
  const [adviceThinking, setAdviceThinking] = useState("");
  const [ghostText, setGhostText] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState("");

  // Clear advice state when switching away from advice mode
  useEffect(() => {
    if (mode !== "advice") {
      if (adviceAbortRef.current) adviceAbortRef.current.abort();
      setSuggestedCommand(null);
      setAdviceThinking("");
      setIsLoading(false);
    }
  }, [mode]);

  /** Parse "COMMAND: ... TEXT: ..." format from advice mode response.
   *  Handles thinking models that dump reasoning before the structured output. */
  const parsedSuggestion = useMemo(() => {
    if (!suggestedCommand) return null;
    // Strip <think>...</think> tags from thinking models
    const cleaned = suggestedCommand.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!cleaned) return null;
    // Try to find COMMAND:/TEXT: anywhere in the response (thinking models may prepend reasoning)
    const cmdMatch = cleaned.match(
      /COMMAND:\s*([\s\S]*?)(?:\s*TEXT:\s*([\s\S]*))?$/i,
    );
    if (cmdMatch) {
      return { command: cmdMatch[1].trim(), text: cmdMatch[2]?.trim() || "" };
    }
    const textMatch = cleaned.match(/TEXT:\s*([\s\S]*)$/i);
    if (textMatch) {
      return { command: "", text: textMatch[1].trim() };
    }
    // No COMMAND/TEXT format found — detect reasoning/thinking dumps and discard
    // Matches: thinking process keywords, markdown headers, numbered steps, conversational openers,
    // bullet points, "Goal:", "Determine", question phrasing, asterisk emphasis
    if (/^(thinking|##|\*\*|\*\s|step\s+\d|let me|okay|here|i |the user|we |so |first|now|to |determine|goal:|>\s)/i.test(cleaned)) {
      return null;
    }
    // Multi-line output without COMMAND: is likely reasoning, not a command
    if (cleaned.split("\n").length > 3) {
      return null;
    }
    return { command: cleaned, text: "" };
  }, [suggestedCommand]);

  // Autocomplete & History State
  type CompletionItem = {
    text: string;
    source: "history" | "suggestion" | "shell-history";
  };
  const [completions, setCompletions] = useState<CompletionItem[]>([]);
  const [showCompletions, setShowCompletions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState("");
  // Track whether user explicitly navigated completions with arrow keys
  const navigatedCompletionsRef = useRef(false);
  // Suppress next fetchCompletions call (after accepting a completion)
  const suppressNextFetchRef = useRef(false);
  // Only trigger completions when the user actually typed (not on draft restore/tab switch)
  const inputTriggeredByUserRef = useRef(false);

  // Image attachment state
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
  const MAX_IMAGES = 5;
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

  const readFileAsBase64 = (file: File): Promise<AttachedImage> =>
    new Promise((resolve, reject) => {
      if (file.size > MAX_IMAGE_SIZE) {
        reject(new Error(`File ${file.name} exceeds 20MB limit`));
        return;
      }
      if (!ALLOWED_TYPES.includes(file.type)) {
        reject(new Error(`Unsupported image type: ${file.type}`));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1];
        resolve({ base64, mediaType: file.type, name: file.name });
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });

  const handleImageFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter((f) =>
      ALLOWED_TYPES.includes(f.type),
    );
    const remaining = MAX_IMAGES - attachedImages.length;
    if (remaining <= 0) return;
    const toProcess = fileArray.slice(0, remaining);
    const newImages: AttachedImage[] = [];
    for (const file of toProcess) {
      try {
        newImages.push(await readFileAsBase64(file));
      } catch {
        // Skip failed files silently
      }
    }
    if (newImages.length > 0) {
      setAttachedImages((prev) => [...prev, ...newImages]);
    }
  };

  const removeImage = (index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const supportsVision =
    modelCapabilities === null || modelCapabilities?.includes("vision");

  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // AI-generated placeholder
  const [aiPlaceholder, setAiPlaceholder] = useState("");
  const placeholderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Track current sessionAIConfig via ref so placeholder timer uses up-to-date model
  const sessionAIConfigRef = useRef(sessionAIConfig);
  sessionAIConfigRef.current = sessionAIConfig;
  // Track whether user has sent any command in this session — skip AI
  // placeholder on fresh terminals (no useful context to suggest from)
  const hasActivityRef = useRef(false);

  // Reset activity tracking when session changes
  const prevSessionIdRef = useRef(sessionId);
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId;
    hasActivityRef.current = false;
  }

  // Per-session command history (for completions — not global)
  const sessionCommandsRef = useRef<string[]>([]);

  // Shell history (loaded once from ~/.zsh_history, ~/.bash_history, etc.)
  const shellHistoryRef = useRef<string[]>([]);
  const shellHistoryLoaded = useRef(false);
  useEffect(() => {
    if (shellHistoryLoaded.current) return;
    shellHistoryLoaded.current = true;
    window.electron?.ipcRenderer
      ?.getShellHistory?.()
      .then((cmds: string[]) => {
        if (cmds?.length) shellHistoryRef.current = cmds;
      })
      .catch(() => {});
  }, []);

  // Scan system commands on mount and rescan periodically
  const commandsScanDone = useRef(false);
  const CACHE_KEY = "tron.scannedCommands";
  const CACHE_TS_KEY = "tron.scannedCommandsTs";
  const CACHE_TTL = 600_000; // 10 minutes

  const doScanCommands = useCallback(() => {
    window.electron?.ipcRenderer
      ?.scanCommands?.()
      .then((cmds: string[]) => {
        if (cmds.length > 0) {
          loadScannedCommands(cmds);
          localStorage.setItem(CACHE_KEY, JSON.stringify(cmds));
          localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
        }
      })
      .catch(() => {
        /* non-critical */
      });
  }, []);

  useEffect(() => {
    if (commandsScanDone.current) return;
    commandsScanDone.current = true;

    // Check localStorage cache first
    const cached = localStorage.getItem(CACHE_KEY);
    const cachedTs = Number(localStorage.getItem(CACHE_TS_KEY) || 0);
    if (cached && Date.now() - cachedTs < CACHE_TTL) {
      try {
        loadScannedCommands(JSON.parse(cached));
        return;
      } catch {
        /* re-scan */
      }
    }

    doScanCommands();
  }, [doScanCommands]);

  // Rescan when agent finishes (newly installed tools become available)
  const prevAgentRunning = useRef(isAgentRunning);
  useEffect(() => {
    if (prevAgentRunning.current && !isAgentRunning) {
      // Agent just finished — rescan commands in background
      invalidateScannedCommands();
      doScanCommands();
    }
    prevAgentRunning.current = isAgentRunning;
  }, [isAgentRunning, doScanCommands]);

  const completionsRef = useRef<HTMLDivElement>(null);
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestInputRef = useRef("");

  /** Cancel any in-flight completion fetches so stale results can't re-show the popover. */
  const cancelPendingCompletions = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    latestInputRef.current = "";
  }, []);

  // Scroll selected completion into view
  useEffect(() => {
    if (!showCompletions || !completionsRef.current) return;
    const el = completionsRef.current.children[selectedIndex] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, showCompletions]);

  // Fetch AI placeholder when input is empty (skip on fresh sessions — no context yet)
  useEffect(() => {
    if (placeholderTimerRef.current) clearTimeout(placeholderTimerRef.current);
    if (
      !hasActivityRef.current ||
      !aiBehavior.ghostText ||
      value.trim() !== "" ||
      !sessionId ||
      isAgentRunning
    ) {
      // Clear stale AI placeholder when input is non-empty or conditions no longer met
      if (value.trim() !== "") setAiPlaceholder("");
      return;
    }
    placeholderTimerRef.current = setTimeout(async () => {
      try {
        if (!window.electron?.ipcRenderer?.getHistory) return;
        const history = await window.electron.ipcRenderer.getHistory(sessionId);
        if (!history || history.length < 10) return;
        const suggestion = await aiService.generatePlaceholder(
          history,
          undefined,
          sessionAIConfigRef.current,
        );
        // Stale check: only set if input is still empty
        if (suggestion && !inputRef.current?.value?.trim())
          setAiPlaceholder(suggestion);
      } catch {
        // Non-critical, silently ignore
      }
    }, 500);
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

  // Window-level hotkeys for advice suggestion (works even when input is blurred)
  useEffect(() => {
    if (!parsedSuggestion?.command || isLoading) return;
    const cmd = parsedSuggestion.command;
    const handler = (e: globalThis.KeyboardEvent) => {
      // Skip if input already focused — its own onKeyDown handles it
      if (document.activeElement === inputRef.current) return;
      if (e.key === "Tab") {
        e.preventDefault();
        setValue(cmd);
        setSuggestedCommand(null);
        setIsAuto(false);
        setMode("command");
        inputRef.current?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        setSuggestedCommand(null);
        trackCommand(cmd);
        onSend(cmd);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setShowCompletions(false);
      } else if (e.key === "Escape") {
        setSuggestedCommand(null);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [parsedSuggestion, isLoading]);

  // Auto-focus when session becomes active (unless user last focused the terminal)
  useEffect(() => {
    if (
      activeSessionId === sessionId &&
      inputRef.current &&
      focusTarget !== "terminal"
    ) {
      // Small timeout to ensure layout is ready
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [activeSessionId, sessionId, focusTarget]);

  // Listen for "Add to Input" events from the pane context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === sessionId && detail?.text) {
        setValue((prev) => (prev ? prev + "\n" + detail.text : detail.text));
        inputRef.current?.focus();
      }
    };
    window.addEventListener("tron:addToInput", handler);
    return () => window.removeEventListener("tron:addToInput", handler);
  }, [sessionId, setValue]);

  // Auto-detect mode hierarchy
  useEffect(() => {
    if (!isAuto) return;

    const classifyAndSet = (m: "command" | "advice" | "agent") => {
      setMode(m);
      modeClassifiedForRef.current = value;
    };

    // When auto-detect is disabled, exit auto mode entirely
    if (!aiBehavior.autoDetect) {
      setIsAuto(false);
      classifyAndSet("command");
      return;
    }

    if (value.trim() === "") {
      classifyAndSet("command");
      setCompletions([]);
      setShowCompletions(false);
      return;
    }

    // 1. If input is clearly natural language, skip everything
    if (isDefinitelyNaturalLanguage(value)) {
      classifyAndSet("agent");
      return;
    }

    // 2. Static classifier (fast, handles known commands)
    if (isCommand(value)) {
      classifyAndSet("command");
      return;
    }

    const words = value.trim().split(/\s+/);
    const firstWord = words[0];

    // 3. Known Command Fallback (Ambiguous Verbs)
    // If isCommand returned false BUT it is in the known list (e.g. "find" without flags),
    // it means we deliberately classified it as Agent. DO NOT check PATH.
    // "isKnownExecutable" needs to be imported
    if (isKnownExecutable(firstWord)) {
      classifyAndSet("agent");
      return;
    }

    // 3b. Capitalized first word = natural language sentence, not a shell command.
    // Executables are case-sensitive and virtually always lowercase on Unix;
    // a capitalized word like "Find" or "Install" would fail in the shell anyway.
    // Exception: known executables with genuine uppercase (e.g. "Rscript").
    if (
      words.length >= 2 &&
      /^[A-Z]/.test(firstWord) &&
      !isKnownExecutable(firstWord)
    ) {
      classifyAndSet("agent");
      return;
    }

    // 4. Check scanned commands cache (instant, no IPC)
    if (isScannedCommand(firstWord)) {
      if (isLikelyImperative(value)) {
        classifyAndSet("agent");
        return;
      }
      classifyAndSet("command");
      return;
    }

    // 5. Unknown Word Fallback: Check PATH dynamically via IPC
    // This covers commands not yet in the scanned cache
    const checkTimeout = setTimeout(() => {
      if (words.length >= 1 && window.electron?.ipcRenderer?.checkCommand) {
        window.electron.ipcRenderer
          .checkCommand(words[0])
          .then((exists: boolean) => {
            classifyAndSet(exists && !isLikelyImperative(value) ? "command" : "agent");
          })
          .catch(() => classifyAndSet("agent"));
      } else {
        classifyAndSet("agent");
      }
    }, 150);

    return () => clearTimeout(checkTimeout);
  }, [value, isAuto]);

  // Fetch completions — works in command mode and auto mode
  const fetchCompletions = useCallback(
    (input: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      latestInputRef.current = input;

      // Suppress fetch after accepting a completion (prevents re-triggering)
      if (suppressNextFetchRef.current) {
        suppressNextFetchRef.current = false;
        return;
      }

      const trimmedInput = input.trim().toLowerCase();

      // When input is empty: clear completions (don't auto-show on tab switch / new tab)
      if (!trimmedInput) {
        setCompletions([]);
        setShowCompletions(false);
        setSelectedIndex(0);
        setGhostText("");
        return;
      }

      const shouldComplete =
        !!window.electron?.ipcRenderer?.getCompletions &&
        (mode === "command" || isAuto);

      // Global history matches (prefix match, most recent first, deduped)
      const globalHistoryMatches: CompletionItem[] = [];
      const histSeen = new Set<string>();
      for (
        let i = history.length - 1;
        i >= 0 && globalHistoryMatches.length < 5;
        i--
      ) {
        const cmd = history[i];
        const lower = cmd.toLowerCase();
        if (
          lower.startsWith(trimmedInput) &&
          lower !== trimmedInput &&
          !histSeen.has(lower)
        ) {
          histSeen.add(lower);
          globalHistoryMatches.push({ text: cmd, source: "history" });
        }
      }

      // Shell history matches (from ~/.zsh_history etc., lower priority than in-app history)
      const shellMatches: CompletionItem[] = [];
      const shellCmds = shellHistoryRef.current;
      for (let i = 0; i < shellCmds.length && shellMatches.length < 5; i++) {
        const cmd = shellCmds[i];
        const lower = cmd.toLowerCase();
        if (
          lower.startsWith(trimmedInput) &&
          lower !== trimmedInput &&
          !histSeen.has(lower)
        ) {
          histSeen.add(lower);
          shellMatches.push({ text: cmd, source: "shell-history" });
        }
      }

      if (!shouldComplete) {
        // No smart completions available — show history + shell history matches
        const combined = [...globalHistoryMatches, ...shellMatches];
        setCompletions(combined);
        setShowCompletions(combined.length > 0);
        setSelectedIndex(0);
        setGhostText("");
        return;
      }

      // Show history + shell history matches immediately (no debounce)
      const immediateResults = [...globalHistoryMatches, ...shellMatches];
      if (immediateResults.length > 0) {
        setCompletions(immediateResults);
        setShowCompletions(true);
        setSelectedIndex(0);
      }

      debounceRef.current = setTimeout(
        async () => {
          try {
            const results = await window.electron.ipcRenderer.getCompletions(
              input.trim(),
              undefined,
              activeSessionId || undefined,
            );

            // Stale check: if input changed while IPC was pending, discard results
            if (latestInputRef.current !== input) return;

            // Local known-command matches (first word only)
            const isFirstWord = !input.trim().includes(" ");
            const localCmdMatches = isFirstWord
              ? getCommandCompletions(input.trim(), 8)
              : [];

            // Build suggestion list (deduped against history + shell history)
            const seen = new Set([
              ...globalHistoryMatches.map((h) => h.text.toLowerCase()),
              ...shellMatches.map((h) => h.text.toLowerCase()),
            ]);
            const suggestions: CompletionItem[] = [];
            for (const c of localCmdMatches) {
              if (!seen.has(c)) {
                seen.add(c);
                suggestions.push({ text: c, source: "suggestion" });
              }
            }
            for (const r of results) {
              if (!seen.has(r.toLowerCase())) {
                seen.add(r.toLowerCase());
                suggestions.push({ text: r, source: "suggestion" });
              }
            }

            // History at top, shell history next, suggestions below
            const finalResults = [
              ...globalHistoryMatches,
              ...shellMatches,
              ...suggestions,
            ].slice(0, 15);

            setCompletions(finalResults);
            setShowCompletions(finalResults.length > 0);
            // Default selection = first smart suggestion (history items are above, reachable via ArrowUp)
            const historyCount =
              globalHistoryMatches.length + shellMatches.length;
            setSelectedIndex(suggestions.length > 0 ? historyCount : 0);

            // Ghost text from best suggestion (prefer suggestions over history for ghost)
            const bestSuggestion =
              suggestions[0]?.text || globalHistoryMatches[0]?.text;
            if (bestSuggestion) {
              if (
                bestSuggestion.toLowerCase().startsWith(trimmedInput) &&
                bestSuggestion.length > input.trim().length
              ) {
                setGhostText(bestSuggestion.slice(input.trim().length));
              } else {
                const parts = input.trimEnd().split(/\s+/);
                const lastWord = parts[parts.length - 1];
                if (
                  bestSuggestion
                    .toLowerCase()
                    .startsWith(lastWord.toLowerCase()) &&
                  bestSuggestion.length > lastWord.length
                ) {
                  setGhostText(bestSuggestion.slice(lastWord.length));
                } else {
                  setGhostText("");
                }
              }
            } else {
              setGhostText("");
            }
          } catch {
            setCompletions([]);
            setShowCompletions(false);
            setGhostText("");
          }
        },
        isTouchDevice() ? 400 : 80,
      );
    },
    [mode, isAuto, activeSessionId, history],
  );

  useEffect(() => {
    if (!inputTriggeredByUserRef.current) {
      // Value changed programmatically (draft restore, tab switch, etc.) — don't show completions
      return;
    }
    inputTriggeredByUserRef.current = false;
    fetchCompletions(value);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, fetchCompletions]);

  // Helper: add command to both global and per-session history
  const trackCommand = (cmd: string) => {
    addToHistory(cmd);
    const sc = sessionCommandsRef.current;
    if (sc.length === 0 || sc[sc.length - 1] !== cmd) {
      sessionCommandsRef.current = [...sc, cmd];
    }
  };

  /** Replace only the last path segment of the last word with the completion. */
  const buildCompletionValue = (input: string, completion: string): string => {
    // History items or full-line matches: replace the entire input
    if (
      completion.toLowerCase().startsWith(input.trim().toLowerCase()) &&
      completion.includes(" ")
    ) {
      return completion + " ";
    }
    const parts = input.trimEnd().split(/\s+/);
    const lastWord = parts[parts.length - 1] || "";
    parts.pop();

    // If the last word contains a path separator and completion is just a name,
    // preserve the directory prefix (e.g. "C:/Users/HAOYA/S" + "SentinelClassifier"
    // → "C:/Users/HAOYA/SentinelClassifier")
    const pathSepIdx = Math.max(
      lastWord.lastIndexOf("/"),
      lastWord.lastIndexOf("\\"),
    );
    if (
      pathSepIdx >= 0 &&
      !completion.includes("/") &&
      !completion.includes("\\")
    ) {
      parts.push(lastWord.substring(0, pathSepIdx + 1) + completion);
    } else {
      parts.push(completion);
    }
    return parts.join(" ") + " ";
  };

  const acceptCompletion = (item: CompletionItem) => {
    const completion = item.text;
    // Suppress the fetch that setValue will trigger
    suppressNextFetchRef.current = true;
    if (item.source === "history" || item.source === "shell-history") {
      setValue(completion + " ");
    } else {
      setValue(buildCompletionValue(value, completion));
    }
    setCompletions([]);
    setShowCompletions(false);
    setGhostText("");
    setSelectedIndex(0);
    // Refocus input (clicking a dropdown item steals focus)
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSend = () => {
    // Trigger same logic as Enter
    handleKeyDown({
      key: "Enter",
      preventDefault: () => {},
      stopPropagation: () => {},
    } as any);
  };

  const handleKeyDown = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+C: Stop agent if running
    if (e.key === "c" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (isLoading || isAgentRunning)) {
      e.preventDefault();
      if (isLoading && adviceAbortRef.current) {
        adviceAbortRef.current.abort();
      } else {
        stopAgent?.();
      }
      return;
    }

    // Tab / Right Arrow: Accept Ghost Text OR Selected Completion OR Placeholder
    // Strict Tab behavior: Only accept, never cycle
    if (
      e.key === "Tab" ||
      (e.key === "ArrowRight" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey)
    ) {
      // Accept advice suggestion command into input box for editing
      if (e.key === "Tab" && parsedSuggestion?.command) {
        e.preventDefault();
        setValue(parsedSuggestion.command);
        setSuggestedCommand(null);
        setIsAuto(false);
        setMode("command");
        return;
      }
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

    // Readline-style editing hotkeys
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const ta = inputRef.current;
      if (!ta) {
        /* fall through */
      } else if (e.key === "u") {
        // Ctrl+U — kill line before cursor
        e.preventDefault();
        const pos = ta.selectionStart;
        setValue((prev) => prev.slice(pos));
        setTimeout(() => ta.setSelectionRange(0, 0), 0);
        return;
      } else if (e.key === "k") {
        // Ctrl+K — kill line after cursor
        e.preventDefault();
        const pos = ta.selectionStart;
        setValue((prev) => prev.slice(0, pos));
        return;
      } else if (e.key === "a") {
        // Ctrl+A — move to start of line
        e.preventDefault();
        ta.setSelectionRange(0, 0);
        return;
      } else if (e.key === "e") {
        // Ctrl+E — move to end of line
        e.preventDefault();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
        return;
      } else if (e.key === "w") {
        // Ctrl+W — delete word before cursor
        e.preventDefault();
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        // Skip trailing spaces, then delete to previous space/start
        const trimmed = before.replace(/\s+$/, "");
        const wordStart = Math.max(0, trimmed.lastIndexOf(" ") + 1);
        setValue((prev) => prev.slice(0, wordStart) + prev.slice(pos));
        setTimeout(() => ta.setSelectionRange(wordStart, wordStart), 0);
        return;
      }
    }

    // Mode Switching Hotkeys (from config)
    if (matchesHotkey(e, hotkeys.modeCommand)) {
      e.preventDefault();
      setIsAuto(false);
      setMode("command");
      return;
    }
    if (matchesHotkey(e, hotkeys.modeAdvice)) {
      e.preventDefault();
      setIsAuto(false);
      setMode("advice");
      return;
    }
    if (matchesHotkey(e, hotkeys.modeAgent)) {
      e.preventDefault();
      setIsAuto(false);
      setMode("agent");
      return;
    }
    if (matchesHotkey(e, hotkeys.modeAuto)) {
      e.preventDefault();
      setIsAuto(true);
      return;
    }
    if (hotkeys.cycleMode && matchesHotkey(e, hotkeys.cycleMode)) {
      e.preventDefault();
      if (isAuto) {
        setIsAuto(false);
        setMode("command");
      } else if (mode === "command") {
        setIsAuto(false);
        setMode(aiBehavior.adviceMode ? "advice" : "agent");
      } else if (mode === "advice") {
        setIsAuto(false);
        setMode("agent");
      } else {
        setIsAuto(true);
      }
      return;
    }

    // Up/Down: navigate completions dropdown when visible, otherwise navigate history.
    // Pass through to native behavior when modifier keys are held
    // (Cmd+Up/Down = go to start/end, Shift+Up/Down = text selection).
    if (
      e.key === "ArrowUp" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      if (showCompletions && completions.length > 0) {
        navigatedCompletionsRef.current = true;
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      // No dropdown — navigate global history
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
      return;
    }

    if (
      e.key === "ArrowDown" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      if (showCompletions && completions.length > 0) {
        navigatedCompletionsRef.current = true;
        setSelectedIndex((prev) => Math.min(completions.length - 1, prev + 1));
        return;
      }
      // No dropdown — navigate global history
      if (historyIndex === -1) return;
      if (historyIndex < history.length - 1) {
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        setValue(history[newIndex]);
      } else {
        setHistoryIndex(-1);
        setValue(savedInput);
      }
      return;
    }

    // Force send as command (default: Cmd+Shift+Enter)
    if (matchesHotkey(e, hotkeys.forceCommand)) {
      e.preventDefault();
      e.stopPropagation();
      cancelPendingCompletions();
      const finalVal = value.trim();
      if (!finalVal) return;
      setFeedbackMsg("");
      trackCommand(finalVal);
      onSend(finalVal);
      setValue("");
      setGhostText("");
      setSuggestedCommand(null);
      setCompletions([]);
      setShowCompletions(false);
      setHistoryIndex(-1);
      return;
    }

    // Force agent (default: Cmd+Enter)
    if (matchesHotkey(e, hotkeys.forceAgent)) {
      e.preventDefault();
      e.stopPropagation();
      cancelPendingCompletions();
      if (noModelConfigured) {
        onNoModel?.();
        return;
      }
      const hasImgs = attachedImages.length > 0;
      setFeedbackMsg("Agent Started");
      if (value.trim()) addToHistory(value.trim());
      onRunAgent(value, hasImgs ? attachedImages : undefined);
      if (hasImgs) setAttachedImages([]);
      setValue("");
      setGhostText("");
      setSuggestedCommand(null);
      setCompletions([]);
      setShowCompletions(false);
      return;
    }

    // Enter
    if (e.key === "Enter") {
      e.stopPropagation(); // Prevent terminal from also receiving this Enter

      // Shift+Enter (without Cmd): insert newline.
      // Let the browser's default textarea behavior handle it —
      // manual insertion via e.preventDefault() + DOM manipulation
      // fails on some platforms. The onChange handler syncs React state.
      if (e.shiftKey && !e.metaKey) {
        return; // don't preventDefault — browser inserts newline natively
      }

      // Cancel any in-flight completion fetches so stale results can't re-show after send
      cancelPendingCompletions();

      e.preventDefault();

      // Dismiss stale completions — only use completion if user actively navigated with arrow keys
      if (showCompletions && !navigatedCompletionsRef.current) {
        setCompletions([]);
        setShowCompletions(false);
        setGhostText("");
      }

      if (
        showCompletions &&
        navigatedCompletionsRef.current &&
        completions[selectedIndex]
      ) {
        const item = completions[selectedIndex];
        // Apply completion and EXECUTE immediately
        let finalVal: string;
        if (item.source === "history" || item.source === "shell-history") {
          finalVal = item.text.trim();
        } else {
          finalVal = buildCompletionValue(value, item.text).trim();
        }

        setFeedbackMsg("");
        trackCommand(finalVal);
        onSend(finalVal);
        setValue("");
        setCompletions([]);
        setShowCompletions(false);
        setHistoryIndex(-1);
        navigatedCompletionsRef.current = false;
        return;
      }

      // Read from DOM textarea directly — React state `value` may be stale
      // when the user types fast and hits Enter before startTransition flushes.
      const domVal = (inputRef.current?.value ?? "").trim();
      const finalVal = domVal || value.trim();
      const hasImages = attachedImages.length > 0;
      if (finalVal === "" && !hasImages) return;

      // Sync React state to the DOM value we're about to send
      if (domVal && domVal !== value.trim()) {
        setValue(domVal);
      }

      // Mark session as active (enables AI placeholder after first command)
      hasActivityRef.current = true;

      // Intercept slash commands (e.g. /log, /clear) before mode routing.
      // Only match known commands exactly — not file paths like /usr/bin/node or /Volumes/...
      const slashCmd = finalVal.split(/\s+/)[0];
      if ((slashCmd === "/log" || slashCmd === "/clear") && onSlashCommand) {
        onSlashCommand(finalVal);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setShowCompletions(false);
        setHistoryIndex(-1);
        return;
      }

      if (parsedSuggestion?.command) {
        const cmd = parsedSuggestion.command;
        setSuggestedCommand(null);
        trackCommand(cmd);
        onSend(cmd);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setShowCompletions(false);
        return;
      }

      // If images attached with no text, force agent mode
      if (hasImages && finalVal === "") {
        if (noModelConfigured) {
          onNoModel?.();
          return;
        }
        setFeedbackMsg("Agent Started");
        onRunAgent("Describe the attached image(s)", attachedImages);
        setAttachedImages([]);
        setValue("");
        setGhostText("");
        setAiPlaceholder("");
        setSuggestedCommand(null);
        setCompletions([]);
        setShowCompletions(false);
        setHistoryIndex(-1);
        return;
      }

      // Execute based on active mode.
      // Re-classify synchronously because onChange uses startTransition,
      // so React state (`value`, `mode`) may lag the DOM when typing fast.
      // `finalVal` reads from DOM first, so it's always current.
      const effectiveMode = isAuto
        ? isDefinitelyNaturalLanguage(finalVal)
          ? "agent"
          : isCommand(finalVal)
            ? "command"
            // If mode was classified for this exact input, trust it;
            // otherwise fall back to full sync classification
            : modeClassifiedForRef.current === finalVal
              ? mode
              : classifyAtEnter(finalVal)
        : mode;

      // When awaiting an agent answer (continuation), force agent mode regardless of classifier
      if (awaitingAnswer || effectiveMode === "agent") {
        if (noModelConfigured) {
          onNoModel?.();
          return;
        }
        setFeedbackMsg("Agent Started");
        addToHistory(finalVal);
        onRunAgent(finalVal, hasImages ? attachedImages : undefined);
        if (hasImages) setAttachedImages([]);
      } else if (effectiveMode === "command") {
        setFeedbackMsg("");
        trackCommand(finalVal);
        onSend(finalVal);
      } else if (effectiveMode === "advice") {
        if (noModelConfigured) {
          onNoModel?.();
          return;
        }
        setIsLoading(true);
        setShowCompletions(false);
        setCompletions([]);
        setGhostText("");
        setSuggestedCommand("");
        setAdviceThinking("");
        const ac = new AbortController();
        adviceAbortRef.current = ac;
        try {
          // Gather session context for advice
          let cwd: string | undefined;
          let terminalHistory: string | undefined;
          if (sessionId) {
            try {
              cwd =
                (await window.electron?.ipcRenderer?.getCwd(sessionId)) ??
                undefined;
              const hist =
                await window.electron?.ipcRenderer?.getHistory(sessionId);
              if (hist) {
                // Strip ANSI codes and take last 15 lines — raw escapes bloat token count
                const stripped = stripAnsi(hist);
                const lines = stripped.split("\n").filter((l) => l.trim());
                terminalHistory = lines.slice(-15).join("\n").trim();
              }
            } catch {
              /* non-critical */
            }
          }
          // Detect thinking tags in token stream for providers that don't
          // separate thinking (e.g. LM Studio outputs <think> as regular content)
          let tokenBuf = "";
          let inThinkTag = false;
          const thinkOpenRe = /^<(think|thinking|thought)>/i;
          const thinkCloseRe = /<\/(think|thinking|thought)>/i;
          const cmd = await aiService.generateCommand(
            value,
            (token) => {
              tokenBuf += token;
              // Detect opening thinking tag at start of stream
              if (!inThinkTag && tokenBuf.length <= 30) {
                if (thinkOpenRe.test(tokenBuf.trimStart())) {
                  inThinkTag = true;
                  // Persist this model as a thinking model for future sessions
                  const cfg = sessionAIConfig || aiService.getConfig();
                  if (cfg.provider && cfg.model) aiService.markModelAsThinking(cfg.provider, cfg.model);
                  // Route everything so far to thinking
                  const afterTag = tokenBuf.trimStart().replace(thinkOpenRe, "");
                  if (afterTag) setAdviceThinking((prev) => prev + afterTag);
                  return;
                }
                // Still accumulating — might be a partial tag like "<thin"
                if (/^<(t|th|thi|thin|think|thinki|thinkin|thinking|thou|thoug|though|thought)$/i.test(tokenBuf.trimStart())) {
                  return; // wait for more tokens
                }
              }
              if (inThinkTag) {
                // Check for closing tag
                const closeMatch = tokenBuf.match(thinkCloseRe);
                if (closeMatch) {
                  const closeIdx = tokenBuf.indexOf(closeMatch[0]);
                  const thinkPart = token.substring(0, token.length - (tokenBuf.length - closeIdx - closeMatch[0].length));
                  const afterClose = tokenBuf.substring(closeIdx + closeMatch[0].length);
                  inThinkTag = false;
                  // Route remaining thinking text
                  if (thinkPart) setAdviceThinking((prev) => prev + thinkPart.replace(thinkCloseRe, ""));
                  // Content after closing tag goes to suggestion
                  if (afterClose.trim()) setSuggestedCommand((prev) => (prev || "") + afterClose);
                } else {
                  setAdviceThinking((prev) => prev + token);
                }
                return;
              }
              setSuggestedCommand((prev) => (prev || "") + token);
            },
            { cwd, terminalHistory },
            sessionAIConfig,
            ac.signal,
            {
              thinking: thinkingEnabled,
              onThinking: (text) => {
                setAdviceThinking((prev) => prev + text);
              },
            },
          );
          // Final result: strip thinking tags and set clean command
          const cleanCmd = cmd
            .replace(/<(think|thinking|thought)>[\s\S]*?<\/(think|thinking|thought)>/gi, "")
            .trim();
          setSuggestedCommand(cleanCmd);
        } catch (err: any) {
          if (err?.name === "AbortError") {
            setSuggestedCommand(null);
          } else {
            console.error(err);
            setSuggestedCommand(null);
          }
        } finally {
          adviceAbortRef.current = null;
          setIsLoading(false);
          // Re-focus input after suggestion arrives (disabled state lost focus)
          setTimeout(() => inputRef.current?.focus(), 50);
        }
        return;
      }

      // Cleanup
      setValue("");
      setGhostText("");
      setAiPlaceholder("");
      setSuggestedCommand(null);
      setCompletions([]);
      setShowCompletions(false);
      setHistoryIndex(-1);
    }
  };

  const suggestion = suggestedCommand;

  const currentCompletion =
    showCompletions && completions.length > 0
      ? completions[selectedIndex]?.text
      : null;

  // Memoize ghost text to avoid redundant string ops on every render
  const displayedGhost = useMemo(() => {
    if (ghostText) return ghostText;
    if (!value && aiPlaceholder) return aiPlaceholder;
    if (currentCompletion) {
      const lastLine = value.split("\n").pop() || "";
      if (currentCompletion.startsWith(lastLine)) {
        return currentCompletion.slice(lastLine.length);
      }
    }
    return "";
  }, [ghostText, value, aiPlaceholder, currentCompletion]);

  return (
    <div
      className="relative z-100 flex w-full flex-col gap-2"
      data-tutorial="smart-input"
      data-testid="smart-input"
    >
      <div
        onDragEnter={(e) => {
          if (!supportsVision) return;
          e.preventDefault();
          dragCounterRef.current++;
          if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
        }}
        onDragOver={(e) => {
          if (!supportsVision) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragCounterRef.current--;
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDragOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragCounterRef.current = 0;
          setIsDragOver(false);
          if (!supportsVision || !e.dataTransfer.files.length) return;
          handleImageFiles(e.dataTransfer.files);
        }}
        className={`relative z-10 flex w-full flex-col gap-1 rounded-lg border px-3 py-2 transition-all duration-300 ${
          isDragOver
            ? theme === "light"
              ? "border-dashed border-purple-400 bg-purple-50 shadow-sm ring-2 ring-purple-300/50"
              : "border-dashed border-purple-400/50 bg-purple-950/50 shadow-[0_0_20px_rgba(168,85,247,0.15)] ring-2 ring-purple-500/30"
            : mode === "agent"
              ? theme === "light"
                ? "border-purple-300 bg-purple-50 text-purple-900 shadow-sm"
                : "border-purple-500/30 bg-purple-950/40 text-purple-100 shadow-[0_0_20px_rgba(168,85,247,0.08)]"
              : mode === "advice"
                ? theme === "light"
                  ? "border-blue-300 bg-blue-50 text-blue-900 shadow-sm"
                  : "border-blue-500/25 bg-blue-950/30 text-blue-100 shadow-[0_0_15px_rgba(59,130,246,0.06)]"
                : theme === "light"
                  ? "border-gray-200 bg-white text-black shadow-sm"
                  : theme === "modern"
                    ? "border-white/[0.08] bg-white/[0.03] text-gray-100"
                    : "border-white/10 bg-[#0e0e0e] text-gray-200 shadow-xl"
        }`}
      >
        {/* Drop zone hint */}
        {isDragOver && (
          <div
            className={`flex items-center justify-center py-2 text-xs font-medium ${
              theme === "light" ? "text-purple-600" : "text-purple-300"
            }`}
          >
            <ImagePlus className="mr-1.5 h-4 w-4 opacity-70" />
            Drop image here
          </div>
        )}

        {/* Image thumbnail strip */}
        {attachedImages.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto px-1 pt-1 pb-1">
            {attachedImages.map((img, i) => (
              <div key={i} className="group/thumb relative shrink-0">
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.name}
                  className={`h-10 w-10 rounded border object-cover ${
                    theme === "light" ? "border-gray-200" : "border-white/10"
                  }`}
                />
                <button
                  onClick={() => removeImage(i)}
                  className={`absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full text-white opacity-0 shadow-sm transition-opacity group-hover/thumb:opacity-100 ${
                    theme === "light" ? "bg-red-500" : "bg-red-500/90"
                  }`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          {/* Mode Switcher */}
          <div className="relative">
            <button
              ref={modeBtnRef}
              data-tutorial="mode-switcher"
              data-testid="mode-button"
              className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                isAuto
                  ? "bg-teal-500/10 text-teal-400"
                  : mode === "agent"
                    ? "bg-purple-500/10 text-purple-400"
                    : mode === "advice"
                      ? "bg-blue-500/10 text-blue-400"
                      : "bg-white/5 text-gray-400 hover:text-white"
              }`}
              onClick={() => setShowModeMenu((v) => !v)}
            >
              {isAuto ? (
                <Zap className="h-3 w-3" />
              ) : mode === "agent" ? (
                <Bot className="h-4 w-4" />
              ) : mode === "advice" ? (
                <Lightbulb className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>

            {/* Mode Dropdown — portal to escape stacking context */}
            {showModeMenu &&
              createPortal(
                <>
                  <div
                    className="fixed inset-0 z-[998]"
                    onClick={() => setShowModeMenu(false)}
                  />
                  <div
                    data-testid="mode-menu"
                    className={`fixed z-[999] w-36 overflow-hidden rounded-lg border shadow-xl ${
                      theme === "light"
                        ? "border-gray-200 bg-white"
                        : "border-white/10 bg-[#1e1e1e]"
                    }`}
                    style={{
                      ...(modeBtnRef.current
                        ? (() => {
                            const rect =
                              modeBtnRef.current!.getBoundingClientRect();
                            return {
                              bottom: window.innerHeight - rect.top + 4,
                              left: rect.left,
                            };
                          })()
                        : {}),
                    }}
                  >
                    {[
                      {
                        id: "auto",
                        label: "Auto",
                        shortcut: "⌘0",
                        icon: <Zap className="h-3 w-3" />,
                      },
                      {
                        id: "command",
                        label: "Command",
                        shortcut: "⌘1",
                        icon: <ChevronRight className="h-3 w-3" />,
                      },
                      ...(aiBehavior.adviceMode
                        ? [
                            {
                              id: "advice",
                              label: "Advice",
                              shortcut: "⌘2",
                              icon: <Lightbulb className="h-3 w-3" />,
                            },
                          ]
                        : []),
                      {
                        id: "agent",
                        label: "Agent",
                        shortcut: "⌘3",
                        icon: <Bot className="h-3 w-3" />,
                      },
                    ].map((m) => (
                      <button
                        key={m.id}
                        data-testid={`mode-option-${m.id}`}
                        onClick={() => {
                          if (m.id === "auto") {
                            setIsAuto(true);
                            setMode("command");
                          } else {
                            setIsAuto(false);
                            setMode(m.id as any);
                          }
                          setShowModeMenu(false);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${
                          theme === "light"
                            ? (isAuto && m.id === "auto") ||
                              (!isAuto && mode === m.id)
                              ? "bg-gray-100 text-gray-900"
                              : "text-gray-600 hover:bg-gray-50"
                            : (isAuto && m.id === "auto") ||
                                (!isAuto && mode === m.id)
                              ? "bg-white/5 text-white"
                              : "text-gray-400 hover:bg-white/5"
                        }`}
                      >
                        <span className="flex w-4 justify-center text-center">
                          {m.icon}
                        </span>
                        <span className="flex-1">{m.label}</span>
                        <span className="text-[10px] opacity-40">
                          {m.shortcut}
                        </span>
                      </button>
                    ))}
                  </div>
                </>,
                document.body,
              )}
          </div>

          <div className="relative flex flex-1 items-center">
            {/* Ghost Text Overlay — tappable on touch devices to accept suggestion */}
            {displayedGhost && (
              <div className="pointer-events-none absolute inset-0 overflow-hidden font-mono text-sm break-words whitespace-pre-wrap">
                <span className="invisible">{value}</span>
                <span className="text-gray-500 opacity-50">
                  {displayedGhost}
                </span>
                {isTouchDevice() && (
                  <span
                    className="pointer-events-auto ml-1.5 inline-flex cursor-pointer items-center rounded bg-gray-500/20 px-1.5 py-0 align-middle text-[10px] font-medium text-gray-400 active:bg-gray-500/40"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (ghostText) {
                        setValue((prev) => prev + ghostText);
                        setGhostText("");
                      } else if (aiPlaceholder && !value) {
                        setValue(aiPlaceholder);
                        setAiPlaceholder("");
                      }
                      setTimeout(() => inputRef.current?.focus(), 0);
                    }}
                  >
                    Tab ↹
                  </span>
                )}
              </div>
            )}

            <textarea
              ref={inputRef}
              data-testid="smart-input-textarea"
              rows={1}
              className={`w-full resize-none overflow-hidden bg-transparent font-mono text-sm outline-none ${
                theme === "light"
                  ? "text-gray-900 placeholder-gray-400"
                  : "text-gray-100 placeholder-gray-500"
              }`}
              style={{ minHeight: "1.5em", maxHeight: "8em" }}
              placeholder={
                aiPlaceholder
                  ? "" // AI suggestion shown via ghost text overlay
                  : isAuto
                    ? "Type a command or ask a question..."
                    : mode === "command"
                      ? "Type a command..."
                      : mode === "agent"
                        ? "Describe a task for the agent..."
                        : "Ask AI for advice..."
              }
              // Value is deliberately uncontrolled to allow native DOM updates for typing performance
              // while React state catches up in a transition
              onChange={(e) => {
                const val = e.target.value;
                inputTriggeredByUserRef.current = true;
                onFocusInput?.();
                // Clear ghost/placeholder immediately (outside transition) to prevent
                // overlap with native placeholder when input is cleared quickly
                if (val.trim() === "") {
                  setGhostText("");
                  setAiPlaceholder("");
                }
                startTransition(() => {
                  setReactValue(val);
                  setHistoryIndex(-1);
                  setSuggestedCommand(null);
                  navigatedCompletionsRef.current = false;
                  if (val.trim() !== "") setAiPlaceholder("");
                  // Note: onDraftChange fires via the useEffect on reactValue — no need to call here
                });
                resizeTextarea(e.target);
              }}
              onFocus={() => onFocusInput?.()}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                // Check both clipboardData.files (direct file paste) and
                // clipboardData.items (screenshot paste — some browsers only
                // expose images via items, not files).
                if (!supportsVision) return; // let native text paste happen
                let imageFiles: File[] = [];
                const files = e.clipboardData?.files;
                if (files && files.length > 0) {
                  imageFiles = Array.from(files).filter((f) =>
                    ALLOWED_TYPES.includes(f.type),
                  );
                }
                if (imageFiles.length === 0 && e.clipboardData?.items) {
                  for (const item of Array.from(e.clipboardData.items)) {
                    if (
                      item.kind === "file" &&
                      ALLOWED_TYPES.includes(item.type)
                    ) {
                      const file = item.getAsFile();
                      if (file) imageFiles.push(file);
                    }
                  }
                }
                if (imageFiles.length > 0) {
                  e.preventDefault();
                  handleImageFiles(imageFiles);
                  return;
                }
                // No images in clipboardData — try server-side IPC first (most
                // reliable in web mode), then navigator.clipboard.read() as
                // fallback. Don't preventDefault — let native text paste happen.
                // Skip async image check if the paste event carries any text or
                // file data — prevents attaching a stale clipboard image when user
                // copies a file in Finder (macOS puts file icon on clipboard).
                const cd = e.clipboardData;
                if (cd && (cd.getData("text/plain") || cd.getData("text/uri-list")
                    || cd.types.includes("Files"))) return;
                (async () => {
                  // IPC: server reads system clipboard directly (bypasses browser restrictions)
                  try {
                    if (window.electron?.ipcRenderer?.readClipboardImage) {
                      const base64 =
                        await window.electron.ipcRenderer.readClipboardImage();
                      if (base64) {
                        const byteChars = atob(base64);
                        const bytes = new Uint8Array(byteChars.length);
                        for (let i = 0; i < byteChars.length; i++)
                          bytes[i] = byteChars.charCodeAt(i);
                        const blob = new Blob([bytes], { type: "image/png" });
                        const file = new File(
                          [blob],
                          `paste-${Date.now()}.png`,
                          { type: "image/png" },
                        );
                        handleImageFiles([file]);
                        return;
                      }
                    }
                  } catch {
                    /* IPC not available */
                  }
                  // Fallback: navigator.clipboard.read() (needs secure context)
                  try {
                    if (navigator.clipboard?.read) {
                      const items = await navigator.clipboard.read();
                      for (const item of items) {
                        const imageType = item.types.find((t: string) =>
                          t.startsWith("image/"),
                        );
                        if (imageType) {
                          const blob = await item.getType(imageType);
                          const ext =
                            imageType.split("/")[1]?.replace("jpeg", "jpg") ||
                            "png";
                          const file = new File(
                            [blob],
                            `paste-${Date.now()}.${ext}`,
                            { type: imageType },
                          );
                          handleImageFiles([file]);
                          return;
                        }
                      }
                    }
                  } catch {
                    /* not available or permission denied */
                  }
                })();
              }}
              autoFocus
              disabled={
                isLoading || (isAgentRunning && pendingCommand !== null)
              }
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {/* Image upload button — visible when model supports vision */}
          {supportsVision && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) handleImageFiles(e.target.files);
                  e.target.value = ""; // Reset so same file can be re-selected
                }}
              />
              <button
                data-testid="image-upload-button"
                onClick={() => fileInputRef.current?.click()}
                className={`rounded-md p-1.5 transition-colors ${
                  theme === "light"
                    ? "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    : "text-gray-500 hover:bg-white/10 hover:text-gray-300"
                }`}
                title={`Attach image (${attachedImages.length}/${MAX_IMAGES})`}
              >
                <ImagePlus className="h-4 w-4" />
              </button>
            </>
          )}

          <button
            data-testid={
              isLoading || isAgentRunning ? "stop-button" : "send-button"
            }
            onPointerDown={(e) => {
              e.preventDefault(); // Prevent blur/keyboard-dismiss on mobile
              if (isLoading && adviceAbortRef.current) {
                // Stop advice generation first
                adviceAbortRef.current.abort();
              } else if (isLoading || isAgentRunning) {
                stopAgent && stopAgent();
              } else {
                handleSend();
              }
            }}
            className={`rounded-md p-1.5 transition-colors ${
              theme === "light"
                ? "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                : "text-gray-500 hover:bg-white/10 hover:text-white"
            } ${isLoading || isAgentRunning ? "text-red-400 hover:bg-red-500/10 hover:text-red-300" : ""}`}
            title={isLoading || isAgentRunning ? "Stop Agent (Ctrl+C)" : "Run"}
          >
            {isLoading || isAgentRunning ? (
              <div className="flex h-4 w-4 items-center justify-center">
                <div className="h-2.5 w-2.5 rounded-sm bg-current" />
              </div>
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Hints bar — hidden on touch devices to reduce footer clutter */}
      {aiBehavior.inputHints && !isTouchDevice() && (
        <div
          className={`flex h-5 items-center justify-between overflow-hidden px-2 text-[10px] whitespace-nowrap select-none ${
            theme === "light" ? "text-gray-500" : "text-gray-400"
          }`}
        >
          {/* Left: mode indicator + feedback */}
          <div className="flex shrink-0 items-center gap-2">
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
            {modelCapabilities?.includes("thinking") && !isOverlayVisible && mode !== "command" && (
              <button
                onClick={() => setThinkingEnabled(!thinkingEnabled)}
                className={`rounded border px-1 py-px transition-colors ${
                  thinkingEnabled
                    ? theme === "light"
                      ? "border-purple-300 bg-purple-50 text-purple-600"
                      : "border-purple-500/30 bg-purple-500/10 text-purple-400"
                    : theme === "light"
                      ? "border-gray-300 bg-gray-50 text-gray-400"
                      : "border-white/10 bg-white/5 text-gray-500"
                }`}
                title={thinkingEnabled ? "Disable thinking" : "Enable thinking"}
              >
                think {thinkingEnabled ? "on" : "off"}
              </button>
            )}
          </div>

          {/* Right: shortcuts (hidden on touch/mobile — not useful without keyboard) */}
          {!isTouchDevice() && (
            <div
              className={`flex shrink-0 items-center gap-0.5 ${
                theme === "light" ? "opacity-70" : "opacity-80"
              }`}
            >
              {hotkeys.cycleMode && (
                <>
                  <span>{formatHotkey(hotkeys.cycleMode)} cycle</span>
                  <span className="mx-1 opacity-40">·</span>
                </>
              )}
              <span>⇧↵ newline</span>
              <span className="mx-1 opacity-40">·</span>
              <span>{formatHotkey(hotkeys.forceAgent)} agent</span>
              <span className="mx-1 opacity-40">·</span>
              <span>{formatHotkey(hotkeys.forceCommand)} cmd</span>
              <span className="mx-1 opacity-40">·</span>
              <span>{formatHotkey(hotkeys.newTab)} tab</span>
              <span className="mx-1 opacity-40">·</span>
              <span>{formatHotkey(hotkeys.splitHorizontal)} split</span>
            </div>
          )}
        </div>
      )}

      {/* Completions Dropdown */}
      <AnimatePresence>
        {showCompletions && completions.length > 0 && (
          <motion.div
            key="completions"
            variants={slideDown}
            initial="hidden"
            animate="visible"
            exit="exit"
            ref={completionsRef}
            className="absolute bottom-full left-0 z-20 mb-1 max-h-60 w-full max-w-md overflow-hidden overflow-y-auto rounded-lg border border-white/10 bg-[#1a1a1a] shadow-xl"
          >
            {completions.map((comp, i) => (
              <motion.div
                key={`${comp.source}-${comp.text}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12 }}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 font-mono text-xs ${
                  i === selectedIndex
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:bg-white/5"
                }`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  acceptCompletion(comp);
                }}
              >
                {comp.source === "history" ? (
                  <Clock className="h-3 w-3 shrink-0 opacity-50" />
                ) : comp.source === "shell-history" ? (
                  <Clock className="h-3 w-3 shrink-0 opacity-30" />
                ) : (
                  <Terminal className="h-3 w-3 shrink-0 opacity-50" />
                )}
                <span
                  className={`truncate${comp.source === "shell-history" ? "opacity-70" : ""}`}
                >
                  {comp.text}
                </span>
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
            className={`absolute bottom-full left-0 z-10 mb-2 flex max-h-64 w-full flex-col rounded-lg border p-3 pb-2 shadow-xl ${
              theme === "light"
                ? "border-blue-200 bg-white/95"
                : "border-purple-500/20 bg-[#1a1a1a]/90"
            }`}
          >
            {/* Fixed header */}
            <div className="mb-3 flex shrink-0 items-center gap-3">
              <Lightbulb
                className={`h-4 w-4 shrink-0 text-purple-400 ${isLoading ? "animate-pulse" : ""}`}
              />
              <div
                className={`text-sm font-medium ${theme === "light" ? "text-purple-700" : "text-purple-200"}`}
              >
                AI Suggestion
              </div>
            </div>
            {/* Scrollable middle content */}
            <div className="min-h-0 flex-1 overflow-hidden">
              <div className="flex-1">
                {adviceThinking && isLoading && (
                  <AdviceThinkingBlock
                    content={adviceThinking}
                    isLight={theme === "light"}
                    isStreaming={isLoading}
                  />
                )}
                {isLoading && !adviceThinking && (
                  <div
                    className={`text-xs italic ${theme === "light" ? "text-gray-400" : "text-gray-500"}`}
                  >
                    Generating...
                  </div>
                )}
                {parsedSuggestion && (
                  <div className="flex flex-col gap-1">
                    {parsedSuggestion.command && (
                      <div
                        className={`rounded px-2 py-1 font-mono text-xs leading-relaxed ${
                          theme === "light"
                            ? "bg-gray-100 text-gray-800"
                            : "bg-white/5 text-gray-200"
                        }`}
                      >
                        {parsedSuggestion.command}
                      </div>
                    )}
                    {parsedSuggestion.text && (
                      <div
                        className={`text-xs leading-relaxed ${
                          theme === "light" ? "text-gray-500" : "text-gray-400"
                        }`}
                      >
                        {parsedSuggestion.text}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* Fixed footer buttons */}
            {suggestion && !isLoading && (
              <div className="mt-2 flex shrink-0 items-center gap-2 border-t border-white/10 pt-2">
                {parsedSuggestion?.command && (
                  <button
                    onClick={() => {
                      setValue(parsedSuggestion.command);
                      setSuggestedCommand(null);
                      setIsAuto(false);
                      setMode("command");
                      inputRef.current?.focus();
                    }}
                    className={`flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      theme === "light"
                        ? "border border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-200"
                        : "border border-white/10 bg-white/10 text-gray-300 hover:bg-white/15"
                    }`}
                  >
                    <span
                      className={`rounded px-1 py-px text-[9px] ${theme === "light" ? "bg-gray-200 text-gray-500" : "bg-white/10 text-gray-500"}`}
                    >
                      Tab
                    </span>
                    Edit
                  </button>
                )}
                {parsedSuggestion?.command && (
                  <button
                    onClick={() => {
                      const cmd = parsedSuggestion.command;
                      setSuggestedCommand(null);
                      trackCommand(cmd);
                      onSend(cmd);
                      setValue("");
                      setGhostText("");
                      setCompletions([]);
                      setShowCompletions(false);
                    }}
                    className={`flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      theme === "light"
                        ? "border border-blue-200 bg-blue-100 text-blue-700 hover:bg-blue-200"
                        : "border border-purple-500/20 bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                    }`}
                  >
                    <span
                      className={`rounded px-1 py-px text-[9px] ${theme === "light" ? "bg-blue-200 text-blue-500" : "bg-purple-500/20 text-purple-400"}`}
                    >
                      ↵
                    </span>
                    Run
                  </button>
                )}
                <button
                  onClick={() => {
                    setSuggestedCommand(null);
                    inputRef.current?.focus();
                  }}
                  className={`rounded px-2 py-1 text-[11px] transition-colors ${
                    theme === "light"
                      ? "text-gray-400 hover:text-gray-600"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  Dismiss
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
export default SmartInput;
