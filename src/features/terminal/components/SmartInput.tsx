import { useState, useEffect, useRef, useCallback, useTransition, useMemo } from "react";
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
import { Terminal, Bot, ChevronRight, Lightbulb, Zap, ImagePlus, X, Clock } from "lucide-react";
import type { AttachedImage } from "../../../types";
import { useTheme } from "../../../contexts/ThemeContext";
import { useAgent } from "../../../contexts/AgentContext";
import { useLayout } from "../../../contexts/LayoutContext";
import { useConfig } from "../../../contexts/ConfigContext";
import { matchesHotkey } from "../../../hooks/useHotkey";
import { slideDown, fadeScale } from "../../../utils/motion";

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
  const { hotkeys } = useConfig();

  const { history, addToHistory } = useHistory();
  const [reactValue, setReactValue] = useState("");
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
          // Reset textarea height when clearing
          if (!newVal) {
            inputRef.current.style.height = 'auto';
          }
        }
        // Sync draft persistence whenever value changes programmatically
        onDraftChange?.(newVal || undefined);
        return newVal;
      });
    },
    [onDraftChange],
  );

  // Mode State
  const [isAuto, setIsAuto] = useState(!defaultAgentMode);
  const [mode, setMode] = useState<"command" | "advice" | "agent">(
    defaultAgentMode ? "agent" : "command",
  );

  const [isLoading, setIsLoading] = useState(false);
  const [suggestedCommand, setSuggestedCommand] = useState<string | null>(null);
  const [ghostText, setGhostText] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState("");

  /** Parse "COMMAND: ... TEXT: ..." format from advice mode response. */
  const parsedSuggestion = useMemo(() => {
    if (!suggestedCommand) return null;
    const cmdMatch = suggestedCommand.match(/^COMMAND:\s*([\s\S]*?)(?:\s*TEXT:\s*([\s\S]*))?$/i);
    if (cmdMatch) {
      return { command: cmdMatch[1].trim(), text: cmdMatch[2]?.trim() || "" };
    }
    const textMatch = suggestedCommand.match(/^TEXT:\s*([\s\S]*)$/i);
    if (textMatch) {
      return { command: "", text: textMatch[1].trim() };
    }
    return { command: suggestedCommand.trim(), text: "" };
  }, [suggestedCommand]);

  // Autocomplete & History State
  type CompletionItem = { text: string; source: "history" | "suggestion" };
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
    const fileArray = Array.from(files).filter(f => ALLOWED_TYPES.includes(f.type));
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
      setAttachedImages(prev => [...prev, ...newImages]);
    }
  };

  const removeImage = (index: number) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index));
  };

  const supportsVision = modelCapabilities === null || modelCapabilities?.includes("vision");

  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // AI-generated placeholder
  const [aiPlaceholder, setAiPlaceholder] = useState("");
  const placeholderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Per-session command history (for completions — not global)
  const sessionCommandsRef = useRef<string[]>([]);

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

  // Scroll selected completion into view
  useEffect(() => {
    if (!showCompletions || !completionsRef.current) return;
    const el = completionsRef.current.children[selectedIndex] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, showCompletions]);

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
    if (activeSessionId === sessionId && inputRef.current && focusTarget !== "terminal") {
      // Small timeout to ensure layout is ready
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [activeSessionId, sessionId, focusTarget]);

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

    // 4. Check scanned commands cache (instant, no IPC)
    if (isScannedCommand(firstWord)) {
      if (isLikelyImperative(value)) {
        setMode("agent");
        return;
      }
      setMode("command");
      return;
    }

    // 5. Unknown Word Fallback: Check PATH dynamically via IPC
    // This covers commands not yet in the scanned cache
    const checkTimeout = setTimeout(() => {
      if (words.length >= 1 && window.electron?.ipcRenderer?.checkCommand) {
        window.electron.ipcRenderer
          .checkCommand(words[0])
          .then((exists: boolean) => {
            setMode(exists && !isLikelyImperative(value) ? "command" : "agent");
          });
      } else {
        setMode("agent");
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
      for (let i = history.length - 1; i >= 0 && globalHistoryMatches.length < 5; i--) {
        const cmd = history[i];
        const lower = cmd.toLowerCase();
        if (lower.startsWith(trimmedInput) && lower !== trimmedInput && !histSeen.has(lower)) {
          histSeen.add(lower);
          globalHistoryMatches.push({ text: cmd, source: "history" });
        }
      }

      if (!shouldComplete) {
        // No smart completions available — show history matches only
        setCompletions(globalHistoryMatches);
        setShowCompletions(globalHistoryMatches.length > 0);
        setSelectedIndex(0);
        setGhostText("");
        return;
      }

      // Show history matches immediately (no debounce)
      if (globalHistoryMatches.length > 0) {
        setCompletions(globalHistoryMatches);
        setShowCompletions(true);
        setSelectedIndex(0);
      }

      debounceRef.current = setTimeout(async () => {
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

          // Build suggestion list (deduped against history)
          const seen = new Set(globalHistoryMatches.map(h => h.text.toLowerCase()));
          const suggestions: CompletionItem[] = [];
          for (const c of localCmdMatches) {
            if (!seen.has(c)) { seen.add(c); suggestions.push({ text: c, source: "suggestion" }); }
          }
          for (const r of results) {
            if (!seen.has(r.toLowerCase())) { seen.add(r.toLowerCase()); suggestions.push({ text: r, source: "suggestion" }); }
          }

          // History at top, suggestions below
          const finalResults = [
            ...globalHistoryMatches,
            ...suggestions,
          ].slice(0, 15);

          setCompletions(finalResults);
          setShowCompletions(finalResults.length > 0);
          // Default selection = first smart suggestion (history items are above, reachable via ArrowUp)
          setSelectedIndex(suggestions.length > 0 ? globalHistoryMatches.length : 0);

          // Ghost text from best suggestion (prefer suggestions over history for ghost)
          const bestSuggestion = suggestions[0]?.text || globalHistoryMatches[0]?.text;
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
                bestSuggestion.toLowerCase().startsWith(lastWord.toLowerCase()) &&
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
      }, 80);
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

  const acceptCompletion = (item: CompletionItem) => {
    const completion = item.text;
    // Suppress the fetch that setValue will trigger
    suppressNextFetchRef.current = true;
    // History items or full-line matches: replace the entire input
    if (
      item.source === "history" ||
      (completion.toLowerCase().startsWith(value.trim().toLowerCase()) &&
        completion.includes(" "))
    ) {
      setValue(completion + " ");
    } else {
      const parts = value.trimEnd().split(/\s+/);
      parts.pop(); // Remove partial word
      parts.push(completion); // Add completion
      setValue(parts.join(" ") + " ");
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
    handleKeyDown({ key: "Enter", preventDefault: () => { }, stopPropagation: () => { } } as any);
  };

  // Shift Key Logic: Double-tap shift to switch mode
  // Track shift press state and last tap timestamp for double-tap detection
  const shiftPressedRef = useRef(false);
  const otherKeyPressedRef = useRef(false);
  const lastShiftTapRef = useRef(0);
  const DOUBLE_TAP_THRESHOLD = 400; // ms

  const handleKeyUp = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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

  const handleKeyDown = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
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

    // Up/Down: navigate completions dropdown when visible, otherwise navigate history
    if (e.key === "ArrowUp") {
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

    if (e.key === "ArrowDown") {
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

    // Enter
    if (e.key === "Enter") {
      e.stopPropagation(); // Prevent terminal from also receiving this Enter

      // Shift+Enter (without Cmd): insert newline
      if (e.shiftKey && !e.metaKey) {
        // Let the textarea handle the newline naturally
        return;
      }

      // Cmd+Shift+Enter: force send as command
      if (e.metaKey && e.shiftKey) {
        e.preventDefault();
        const finalVal = value.trim();
        if (!finalVal) return;
        setFeedbackMsg("");
        trackCommand(finalVal);
        onSend(finalVal);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setShowCompletions(false);
        setHistoryIndex(-1);
        return;
      }

      // Cmd+Enter: force agent
      if (e.metaKey) {
        e.preventDefault();
        const hasImgs = attachedImages.length > 0;
        setFeedbackMsg("Agent Started");
        if (value.trim()) addToHistory(value.trim());
        onRunAgent(value, hasImgs ? attachedImages : undefined);
        if (hasImgs) setAttachedImages([]);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setShowCompletions(false);
        return;
      }

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
        // History items or full-line matches: use text as-is
        if (
          item.source === "history" ||
          (item.text.toLowerCase().startsWith(value.trim().toLowerCase()) &&
            item.text.includes(" "))
        ) {
          finalVal = item.text.trim();
        } else {
          const parts = value.trimEnd().split(/\s+/);
          parts.pop();
          parts.push(item.text);
          finalVal = parts.join(" ").trim();
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

      const finalVal = value.trim();
      const hasImages = attachedImages.length > 0;
      if (finalVal === "" && !hasImages) return;

      // Intercept slash commands (e.g. /log) before mode routing
      if (finalVal.startsWith("/") && onSlashCommand) {
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
        setFeedbackMsg("Agent Started");
        onRunAgent("Describe the attached image(s)", attachedImages);
        setAttachedImages([]);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setHistoryIndex(-1);
        return;
      }

      // Execute based on active mode
      // When awaiting an agent answer (continuation), force agent mode regardless of classifier
      if (awaitingAnswer || mode === "agent") {
        setFeedbackMsg("Agent Started");
        addToHistory(finalVal);
        onRunAgent(finalVal, hasImages ? attachedImages : undefined);
        if (hasImages) setAttachedImages([]);
      } else if (mode === "command") {
        setFeedbackMsg("");
        trackCommand(finalVal);
        onSend(finalVal);
      } else if (mode === "advice") {
        setIsLoading(true);
        setFeedbackMsg("Asking AI...");
        setShowCompletions(false);
        setCompletions([]);
        setGhostText("");
        setSuggestedCommand("");
        try {
          // Gather session context for advice
          let cwd: string | undefined;
          let terminalHistory: string | undefined;
          if (sessionId) {
            try {
              cwd = (await window.electron?.ipcRenderer?.getCwd(sessionId)) ?? undefined;
              const hist = await window.electron?.ipcRenderer?.getHistory(sessionId);
              if (hist) {
                // Last 30 lines for context
                const lines = hist.split("\n");
                terminalHistory = lines.slice(-30).join("\n").trim();
              }
            } catch { /* non-critical */ }
          }
          const cmd = await aiService.generateCommand(value, (token) => {
            setSuggestedCommand((prev) => (prev || "") + token);
          }, { cwd, terminalHistory });
          setSuggestedCommand(cmd);
          setFeedbackMsg("");
        } catch (err) {
          console.error(err);
          setFeedbackMsg("AI Error");
          setSuggestedCommand(null);
        } finally {
          setIsLoading(false);
          // Re-focus input after suggestion arrives (disabled state lost focus)
          setTimeout(() => inputRef.current?.focus(), 50);
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
      ? completions[selectedIndex]?.text
      : null;

  return (
    <div
      className="w-full flex flex-col relative gap-2 z-100"
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
        className={`relative w-full transition-all duration-300 rounded-lg border px-3 py-2 flex flex-col gap-1 z-10 ${isDragOver
          ? theme === "light"
            ? "bg-purple-50 border-purple-400 border-dashed shadow-sm ring-2 ring-purple-300/50"
            : "bg-purple-950/50 border-purple-400/50 border-dashed shadow-[0_0_20px_rgba(168,85,247,0.15)] ring-2 ring-purple-500/30"
          : mode === "agent"
            ? theme === "light"
              ? "bg-purple-50 border-purple-300 shadow-sm text-purple-900"
              : "bg-purple-950/40 border-purple-500/30 shadow-[0_0_20px_rgba(168,85,247,0.08)] text-purple-100"
            : mode === "advice"
              ? theme === "light"
                ? "bg-blue-50 border-blue-300 shadow-sm text-blue-900"
                : "bg-blue-950/30 border-blue-500/25 shadow-[0_0_15px_rgba(59,130,246,0.06)] text-blue-100"
              : theme === "light"
                ? "bg-white border-gray-200 shadow-sm text-black"
                : theme === "modern"
                  ? "bg-white/[0.03] border-white/[0.08] text-gray-100"
                  : "bg-[#0e0e0e] border-white/10 text-gray-200 shadow-xl"
          }`}
      >
        {/* Drop zone hint */}
        {isDragOver && (
          <div className={`flex items-center justify-center py-2 text-xs font-medium ${theme === "light" ? "text-purple-600" : "text-purple-300"
            }`}>
            <ImagePlus className="w-4 h-4 mr-1.5 opacity-70" />
            Drop image here
          </div>
        )}

        {/* Image thumbnail strip */}
        {attachedImages.length > 0 && (
          <div className="flex items-center gap-1.5 px-1 pt-1 pb-1 overflow-x-auto">
            {attachedImages.map((img, i) => (
              <div key={i} className="relative shrink-0 group/thumb">
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.name}
                  className={`h-10 w-10 rounded object-cover border ${theme === "light" ? "border-gray-200" : "border-white/10"
                    }`}
                />
                <button
                  onClick={() => removeImage(i)}
                  className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full text-white flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity shadow-sm ${theme === "light" ? "bg-red-500" : "bg-red-500/90"
                    }`}
                >
                  <X className="w-2.5 h-2.5" />
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
              className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors ${isAuto
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
                <Zap className="w-3 h-3" />
              ) : mode === "agent" ? (
                <Bot className="w-4 h-4" />
              ) : mode === "advice" ? (
                <Lightbulb className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
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
                    className={`fixed w-36 rounded-lg shadow-xl overflow-hidden border z-[999] ${theme === "light"
                        ? "bg-white border-gray-200"
                        : "bg-[#1e1e1e] border-white/10"
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
                        icon: <Zap className="w-3 h-3" />,
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
                        icon: <Lightbulb className="w-3 h-3" />,
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
                        className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${theme === "light"
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

          <div className="relative flex-1 flex items-center">
            {/* Ghost Text Overlay */}
            {(value.length > 0 || (!value && aiPlaceholder)) && (
              <div className="absolute inset-0 pointer-events-none font-mono text-sm whitespace-pre-wrap break-words overflow-hidden">
                <span className="invisible">{value}</span>
                <span className="text-gray-500 opacity-50">
                  {ghostText ||
                    (!value && aiPlaceholder ? aiPlaceholder : "") ||
                    (currentCompletion && currentCompletion.startsWith(value.split('\n').pop() || "")
                      ? currentCompletion.slice((value.split('\n').pop() || "").length)
                      : "")}
                </span>
              </div>
            )}

            <textarea
              ref={inputRef}
              data-testid="smart-input-textarea"
              rows={1}
              className={`w-full bg-transparent font-mono text-sm outline-none resize-none overflow-hidden ${theme === "light"
                  ? "text-gray-900 placeholder-gray-400"
                  : "text-gray-100 placeholder-gray-500"
                }`}
              style={{ minHeight: '1.5em', maxHeight: '8em' }}
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
                startTransition(() => {
                  setReactValue(val);
                  setHistoryIndex(-1);
                  setSuggestedCommand(null);
                  navigatedCompletionsRef.current = false;
                  if (val.trim() !== "") setAiPlaceholder("");
                  onDraftChange?.(val || undefined);
                });
                // Auto-resize textarea
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = el.scrollHeight + 'px';
              }}
              onFocus={() => onFocusInput?.()}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onPaste={(e) => {
                const items = e.clipboardData?.files;
                if (items && items.length > 0) {
                  const imageFiles = Array.from(items).filter(f => ALLOWED_TYPES.includes(f.type));
                  if (imageFiles.length > 0 && supportsVision) {
                    e.preventDefault();
                    handleImageFiles(imageFiles);
                  }
                }
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
                className={`p-1.5 rounded-md transition-colors ${theme === "light"
                  ? "hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                  : "hover:bg-white/10 text-gray-500 hover:text-gray-300"
                  }`}
                title={`Attach image (${attachedImages.length}/${MAX_IMAGES})`}
              >
                <ImagePlus className="w-4 h-4" />
              </button>
            </>
          )}

          <button
            data-testid={isLoading || isAgentRunning ? "stop-button" : "send-button"}
            onClick={
              isLoading || isAgentRunning
                ? () => stopAgent && stopAgent()
                : () => handleSend()
            }
            className={`p-1.5 rounded-md transition-colors ${theme === "light"
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
        className={`flex items-center justify-between px-2 h-5 text-[10px] select-none overflow-hidden whitespace-nowrap ${theme === "light" ? "text-gray-500" : "text-gray-400"
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
              className={`font-medium ${mode === "agent"
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
          {modelCapabilities?.includes("thinking") && !isOverlayVisible && (
            <button
              onClick={() => setThinkingEnabled(!thinkingEnabled)}
              className={`px-1 py-px rounded border transition-colors ${thinkingEnabled
                  ? theme === "light"
                    ? "border-purple-300 text-purple-600 bg-purple-50"
                    : "border-purple-500/30 text-purple-400 bg-purple-500/10"
                  : theme === "light"
                    ? "border-gray-300 text-gray-400 bg-gray-50"
                    : "border-white/10 text-gray-500 bg-white/5"
                }`}
              title={thinkingEnabled ? "Disable thinking" : "Enable thinking"}
            >
              think {thinkingEnabled ? "on" : "off"}
            </button>
          )}
        </div>

        {/* Right: shortcuts */}
        <div
          className={`flex items-center gap-0.5 shrink-0 ${theme === "light" ? "opacity-70" : "opacity-80"
            }`}
        >
          <span>⇧⇧ next mode</span>
          <span className="opacity-40 mx-1">·</span>
          <span>⇧↵ newline</span>
          <span className="opacity-40 mx-1">·</span>
          <span>⌘↵ agent</span>
          <span className="opacity-40 mx-1">·</span>
          <span>⌘⇧↵ cmd</span>
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
            ref={completionsRef}
            className="absolute bottom-full left-0 mb-1 w-full max-w-md bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl overflow-hidden z-20 max-h-60 overflow-y-auto"
          >
            {completions.map((comp, i) => (
              <motion.div
                key={`${comp.source}-${comp.text}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12 }}
                className={`px-3 py-2 text-xs font-mono cursor-pointer flex items-center gap-2 ${i === selectedIndex
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:bg-white/5"
                  }`}
                onClick={() => {
                  acceptCompletion(comp);
                  setTimeout(() => handleSend(), 0);
                }}
              >
                {comp.source === "history" ? (
                  <Clock className="w-3 h-3 opacity-50 shrink-0" />
                ) : (
                  <Terminal className="w-3 h-3 opacity-50 shrink-0" />
                )}
                <span className="truncate">{comp.text}</span>
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
            className={`absolute bottom-full left-0 mb-2 w-full border rounded-lg p-3 shadow-xl z-10 max-h-48 overflow-y-auto ${theme === "light"
                ? "bg-white/95 border-blue-200"
                : "bg-[#1a1a1a]/90 border-purple-500/20"
              }`}
          >
            <div className="flex items-start gap-3">
              <Lightbulb
                className={`w-4 h-4 text-purple-400 mt-0.5 shrink-0 ${isLoading ? "animate-pulse" : ""}`}
              />
              <div className="flex-1">
                <div
                  className={`text-sm font-medium mb-1 ${theme === "light" ? "text-purple-700" : "text-purple-200"}`}
                >
                  AI Suggestion
                </div>
                {!suggestion && isLoading && (
                  <div className={`text-xs italic ${theme === "light" ? "text-gray-400" : "text-gray-500"}`}>
                    Generating...
                  </div>
                )}
                {parsedSuggestion && (
                  <div className="flex flex-col gap-1">
                    {parsedSuggestion.command && (
                      <div
                        className={`text-xs leading-relaxed font-mono px-2 py-1 rounded ${theme === "light"
                            ? "bg-gray-100 text-gray-800"
                            : "bg-white/5 text-gray-200"
                          }`}
                      >
                        {parsedSuggestion.command}
                        {isLoading && (
                          <span className="inline-block w-1.5 h-3 bg-purple-400/60 animate-pulse ml-0.5 align-middle" />
                        )}
                      </div>
                    )}
                    {parsedSuggestion.text && (
                      <div
                        className={`text-xs leading-relaxed ${theme === "light" ? "text-gray-500" : "text-gray-400"
                          }`}
                      >
                        {parsedSuggestion.text}
                      </div>
                    )}
                    {!parsedSuggestion.command && !parsedSuggestion.text && isLoading && (
                      <span className="inline-block w-1.5 h-3 bg-purple-400/60 animate-pulse" />
                    )}
                  </div>
                )}
                {/* Accept / Run buttons */}
                {suggestion && !isLoading && (
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/10">
                    {parsedSuggestion?.command && (
                      <button
                        onClick={() => {
                          setValue(parsedSuggestion.command);
                          setSuggestedCommand(null);
                          setIsAuto(false);
                          setMode("command");
                          inputRef.current?.focus();
                        }}
                        className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors flex items-center gap-1 ${theme === "light"
                            ? "bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-200"
                            : "bg-white/10 hover:bg-white/15 text-gray-300 border border-white/10"
                          }`}
                      >
                        <span
                          className={`text-[9px] px-1 py-px rounded ${theme === "light" ? "bg-gray-200 text-gray-500" : "bg-white/10 text-gray-500"}`}
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
                        className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors flex items-center gap-1 ${theme === "light"
                            ? "bg-blue-100 hover:bg-blue-200 text-blue-700 border border-blue-200"
                            : "bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/20"
                          }`}
                      >
                        <span
                          className={`text-[9px] px-1 py-px rounded ${theme === "light" ? "bg-blue-200 text-blue-500" : "bg-purple-500/20 text-purple-400"}`}
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
                      className={`px-2 py-1 text-[11px] rounded transition-colors ${theme === "light"
                          ? "text-gray-400 hover:text-gray-600"
                          : "text-gray-500 hover:text-gray-300"
                        }`}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
export default SmartInput;
