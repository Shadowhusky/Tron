import React, { useState, useEffect, useRef, useCallback } from "react";
import type { KeyboardEvent } from "react";

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
import { Terminal, ChevronRight, Lightbulb, ImagePlus, X } from "lucide-react";
import type { AttachedImage, AIConfig } from "../../../types";
import { useTheme } from "../../../contexts/ThemeContext";
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
  sessionAIConfig?: AIConfig;
  defaultAgentMode?: boolean;
  /** Persisted draft input from session state. */
  draftInput?: string;
  /** Callback to persist draft input. */
  onDraftChange?: (text: string | undefined) => void;
  /** Intercept slash commands (e.g. /log) before normal input routing. */
  onSlashCommand?: (command: string) => void;
  /** Agent abort function (passed from parent to avoid context re-renders). */
  stopAgent?: () => void;
  /** Whether thinking mode is enabled. */
  thinkingEnabled?: boolean;
  /** Toggle thinking mode. */
  setThinkingEnabled?: (enabled: boolean) => void;
  /** Active session ID — passed from parent to avoid useLayout() context subscription. */
  activeSessionId?: string | null;
}

const SmartInput: React.FC<SmartInputProps> = ({
  onSend,
  onRunAgent,
  isAgentRunning,
  pendingCommand,
  sessionId,
  modelCapabilities = null,
  sessionAIConfig,
  defaultAgentMode = false,
  draftInput,
  onDraftChange,
  onSlashCommand,
  stopAgent,
  thinkingEnabled = true,
  setThinkingEnabled,
  activeSessionId,
}) => {
  const { resolvedTheme: theme } = useTheme();
  const { hotkeys } = useConfig();

  const { history, addToHistory } = useHistory();
  const [value, setValue] = useState(draftInput || "");
  // Mode State
  // In agent view mode, still use auto classification so commands route to terminal
  const [isAuto, setIsAuto] = useState(true);
  const [mode, setMode] = useState<"command" | "advice" | "agent">(
    defaultAgentMode ? "agent" : "command",
  );

  // Sync draft input back to parent for session persistence (debounced long to avoid context churn)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!onDraftChangeRef.current) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      onDraftChangeRef.current?.(valueRef.current || undefined);
    }, 3000);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush draft immediately on tab switch or unmount
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      onDraftChangeRef.current?.(valueRef.current || undefined);
    };
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Track whether user explicitly navigated completions with arrow keys
  const navigatedCompletionsRef = useRef(false);

  // AI-generated placeholder / inline suggestion
  const [aiPlaceholder, setAiPlaceholder] = useState("");
  const placeholderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const placeholderAbortRef = useRef<AbortController | null>(null);
  const sessionAIConfigRef = useRef(sessionAIConfig);
  sessionAIConfigRef.current = sessionAIConfig;
  // Track whether we're navigating history (suppress completions)
  const navigatingHistoryRef = useRef(false);

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
        // Strip "data:image/png;base64," prefix
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

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const completionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestInputRef = useRef("");

  // Scroll selected completion into view
  useEffect(() => {
    if (!showCompletions || !completionsRef.current) return;
    const el = completionsRef.current.children[selectedIndex] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, showCompletions]);

  // Fetch AI suggestion — only when input is empty (idle prediction)
  // No predictions while typing to avoid lag from API calls
  useEffect(() => {
    if (placeholderTimerRef.current) clearTimeout(placeholderTimerRef.current);
    // Always abort any in-flight request when effect re-runs
    if (placeholderAbortRef.current) {
      placeholderAbortRef.current.abort();
      placeholderAbortRef.current = null;
    }

    // Clear suggestion immediately when user starts typing
    if (value.trim() !== "") {
      if (aiPlaceholder) setAiPlaceholder("");
      return;
    }

    if (!sessionId || isAgentRunning) return;

    // Create abort controller up-front so cleanup can cancel both timer and in-flight request
    const abort = new AbortController();
    placeholderAbortRef.current = abort;

    // Only predict when idle (empty input, 3s delay)
    placeholderTimerRef.current = setTimeout(async () => {
      try {
        if (abort.signal.aborted) return;
        if (!window.electron?.ipcRenderer?.getHistory) return;
        const termHistory = await window.electron.ipcRenderer.getHistory(sessionId);
        if (abort.signal.aborted) return;
        if (!termHistory || termHistory.length < 10) return;
        let accumulated = "";
        const suggestion = await aiService.generatePlaceholder(
          termHistory,
          undefined,
          sessionAIConfigRef.current,
          abort.signal,
          (token) => {
            if (abort.signal.aborted) return;
            accumulated += token;
            const preview = accumulated.replace(/^`+|`+$/g, "").split("\n")[0].trim();
            if (preview.length <= 80) {
              setAiPlaceholder(preview);
            } else {
              // Got enough text — abort the stream early to save resources
              abort.abort();
            }
          },
        );
        if (abort.signal.aborted) return;
        setAiPlaceholder(suggestion || accumulated.replace(/^`+|`+$/g, "").split("\n")[0].trim() || "");
      } catch {
        // Non-critical, silently ignore (includes AbortError from early stop)
      }
    }, 3000);
    return () => {
      if (placeholderTimerRef.current)
        clearTimeout(placeholderTimerRef.current);
      if (placeholderAbortRef.current) {
        placeholderAbortRef.current.abort();
        placeholderAbortRef.current = null;
      }
    };
  }, [value, sessionId, isAgentRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // AI ghost text — only shown when input is empty
  const aiGhostText = value.trim() === "" ? aiPlaceholder : "";

  // Clear feedback after delay
  useEffect(() => {
    if (feedbackMsg) {
      const timer = setTimeout(() => setFeedbackMsg(""), 3000);
      return () => clearTimeout(timer);
    }
  }, [feedbackMsg]);

  // Window-level hotkeys for advice suggestion (works even when input is blurred)
  useEffect(() => {
    if (!suggestedCommand || isLoading) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      // Skip if input already focused — its own onKeyDown handles it
      if (document.activeElement === inputRef.current) return;
      if (e.key === "Tab") {
        e.preventDefault();
        setValue(suggestedCommand);
        setSuggestedCommand(null);
        setIsAuto(false);
        setMode("command");
        inputRef.current?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = suggestedCommand;
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
  }, [suggestedCommand, isLoading]);

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

  // Auto-detect mode hierarchy (check last line for multi-line input)
  const modeCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isAuto) return;

    // Multiline input is almost always a natural language prompt, not a shell command
    if (value.includes('\n')) {
      setMode("agent");
      return;
    }

    // Use last line for detection (single-line at this point)
    const lastLine = value;

    if (lastLine.trim() === "") {
      setMode(defaultAgentMode ? "agent" : "command");
      return;
    }

    // Debounce classifier checks to avoid synchronous work on every keystroke
    if (modeCheckRef.current) clearTimeout(modeCheckRef.current);
    modeCheckRef.current = setTimeout(() => {
      // 1. If input is clearly natural language, skip everything
      if (isDefinitelyNaturalLanguage(lastLine)) {
        setMode("agent");
        return;
      }

      // 2. Static classifier (fast, handles known commands)
      if (isCommand(lastLine)) {
        setMode("command");
        return;
      }

      const words = lastLine.trim().split(/\s+/);
      const firstWord = words[0];

      // 3. Known Command Fallback (Ambiguous Verbs)
      if (isKnownExecutable(firstWord)) {
        setMode("agent");
        return;
      }

      // 4. Check scanned commands cache (instant, no IPC)
      if (isScannedCommand(firstWord)) {
        if (isLikelyImperative(lastLine)) {
          setMode("agent");
          return;
        }
        setMode("command");
        return;
      }

      // 5. Unknown Word Fallback: Check PATH dynamically via IPC
      if (words.length >= 1 && window.electron?.ipcRenderer?.checkCommand) {
        window.electron.ipcRenderer
          .checkCommand(words[0])
          .then((exists: boolean) => {
            setMode(exists && !isLikelyImperative(lastLine) ? "command" : "agent");
          });
      } else {
        setMode("agent");
      }
    }, 100);
    return () => {
      if (modeCheckRef.current) clearTimeout(modeCheckRef.current);
    };
  }, [value, isAuto]);

  // Use refs for values read inside fetchCompletions to avoid identity changes
  // that cascade into the completions effect
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const isAutoRef = useRef(isAuto);
  isAutoRef.current = isAuto;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // Fetch completions — works in command mode and auto mode
  // Stable identity: reads mode/isAuto/activeSessionId from refs
  const fetchCompletions = useCallback(
    (input: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      latestInputRef.current = input;
      const shouldComplete =
        input.trim().length > 0 &&
        !!window.electron?.ipcRenderer?.getCompletions &&
        (modeRef.current === "command" || isAutoRef.current);
      if (!shouldComplete) {
        // Use functional update to avoid re-render when already empty
        setCompletions(prev => prev.length === 0 ? prev : []);
        setShowCompletions(false);
        setGhostText("");
        return;
      }

      // All matching (local + IPC) behind single debounce to keep typing responsive
      debounceRef.current = setTimeout(async () => {
        try {
          const results = await window.electron.ipcRenderer.getCompletions(
            input.trim(),
            undefined,
            activeSessionIdRef.current || undefined,
          );

          // Stale check: if input changed while IPC was pending, discard results
          if (latestInputRef.current !== input) return;

          // Merge per-session history matches (prefix match, most recent first)
          const trimmedInput = input.trim().toLowerCase();
          const sessionCmds = sessionCommandsRef.current;
          const historyMatches = sessionCmds
            .filter(
              (cmd) =>
                cmd.toLowerCase().startsWith(trimmedInput) &&
                cmd.toLowerCase() !== trimmedInput,
            )
            .reverse() // most recent first
            .slice(0, 5);

          // Local known-command matches (first word only)
          const isFirstWord = !input.trim().includes(" ");
          const localCmdMatches = isFirstWord
            ? getCommandCompletions(input.trim(), 8)
            : [];

          // Dedupe: history first, then local commands, then shell completions
          const seen = new Set<string>();
          const merged: string[] = [];
          for (const h of historyMatches) {
            if (!seen.has(h)) {
              seen.add(h);
              merged.push(h);
            }
          }
          for (const c of localCmdMatches) {
            if (!seen.has(c)) {
              seen.add(c);
              merged.push(c);
            }
          }
          for (const r of results) {
            if (!seen.has(r)) {
              seen.add(r);
              merged.push(r);
            }
          }
          const finalResults = merged.slice(0, 15);

          setCompletions(finalResults);
          setShowCompletions(finalResults.length > 0);
          setSelectedIndex(0);

          // Ghost text from best match
          if (finalResults.length > 0) {
            const best = finalResults[0];
            // If best match is a full-line history match (starts with entire input)
            if (
              best &&
              best.toLowerCase().startsWith(trimmedInput) &&
              best.length > input.trim().length
            ) {
              setGhostText(best.slice(input.trim().length));
            } else {
              // Fallback: partial word completion
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
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    // Skip completions when value changed due to arrow-key history navigation
    if (navigatingHistoryRef.current) {
      navigatingHistoryRef.current = false;
      return;
    }
    const lastLine = value.split('\n').pop() || "";
    fetchCompletions(lastLine);
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

  const acceptCompletion = (completion: string) => {
    // Apply to LAST LINE only
    const lines = value.split('\n');
    const lastLine = lines.pop() || "";

    // If the completion starts with the entire current line, it's a full-line match
    if (
      completion.toLowerCase().startsWith(lastLine.trim().toLowerCase()) &&
      completion.includes(" ")
    ) {
      lines.push(completion + " ");
    } else {
      const parts = lastLine.trimEnd().split(/\s+/);
      parts.pop(); // Remove partial word
      parts.push(completion); // Add completion
      lines.push(parts.join(" ") + " ");
    }
    setValue(lines.join('\n'));
    setCompletions([]);
    setShowCompletions(false);
    setGhostText("");
    setSelectedIndex(0);
  };

  const handleSend = () => {
    // Trigger same logic as Enter
    handleKeyDown({ key: "Enter", preventDefault: () => {}, stopPropagation: () => {} } as any);
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
      // Accept advice suggestion into input box for editing
      if (e.key === "Tab" && suggestedCommand) {
        e.preventDefault();
        setValue(suggestedCommand);
        setSuggestedCommand(null);
        setIsAuto(false);
        setMode("command");
        return;
      }
      if (ghostText || aiGhostText || (showCompletions && completions.length > 0)) {
        e.preventDefault();
        if (showCompletions && completions[selectedIndex]) {
          acceptCompletion(completions[selectedIndex]);
        } else if (aiGhostText && aiPlaceholder) {
          // Accept full AI suggestion
          setValue(aiPlaceholder);
          setAiPlaceholder("");
          setGhostText("");
        } else if (ghostText) {
          setValue((prev) => prev + ghostText);
          setGhostText("");
        }
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

    // Up/Down: Priority to Dropdown, then History
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (showCompletions && completions.length > 0) {
        navigatedCompletionsRef.current = true;
        const newIndex =
          selectedIndex <= 0 ? completions.length - 1 : selectedIndex - 1;
        setSelectedIndex(newIndex);
      } else {
        if (history.length === 0) return;
        navigatingHistoryRef.current = true;
        setCompletions([]);
        setShowCompletions(false);
        setGhostText("");
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
        navigatedCompletionsRef.current = true;
        const newIndex =
          selectedIndex >= completions.length - 1 ? 0 : selectedIndex + 1;
        setSelectedIndex(newIndex);
      } else {
        if (historyIndex === -1) return;
        navigatingHistoryRef.current = true;
        setCompletions([]);
        setShowCompletions(false);
        setGhostText("");
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

      // Cmd+Enter: force send as agent
      if (e.metaKey || matchesHotkey(e, hotkeys.forceCommand)) {
        e.preventDefault();
        const finalVal = value.trim();
        const hasImages = attachedImages.length > 0;
        if (!finalVal && !hasImages) return;
        setFeedbackMsg("Agent Started");
        if (finalVal) trackCommand(finalVal);
        onRunAgent(finalVal || "Describe the attached image(s)", hasImages ? attachedImages : undefined);
        setAttachedImages([]);
        setValue("");
        setGhostText("");
        setCompletions([]);
        setShowCompletions(false);
        setHistoryIndex(-1);
        return;
      }

      // Shift+Enter: insert newline for multi-line input
      if (e.shiftKey) {
        // Allow default behavior (newline insertion in textarea)
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
        const selected = completions[selectedIndex];
        // Apply completion and EXECUTE immediately
        let finalVal: string;
        // Full-line history match: use completion as-is
        if (
          selected.toLowerCase().startsWith(value.trim().toLowerCase()) &&
          selected.includes(" ")
        ) {
          finalVal = selected.trim();
        } else {
          const parts = value.trimEnd().split(/\s+/);
          parts.pop();
          parts.push(selected);
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

      // Intercept slash commands (e.g. /log)
      if (finalVal.startsWith("/") && onSlashCommand) {
        onSlashCommand(finalVal);
        setValue("");
        setCompletions([]);
        setShowCompletions(false);
        setGhostText("");
        setHistoryIndex(-1);
        return;
      }

      if (suggestedCommand) {
        const cmd = suggestedCommand;
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
      if (mode === "command") {
        setFeedbackMsg("");
        trackCommand(finalVal);
        onSend(finalVal);
      } else if (mode === "agent") {
        setFeedbackMsg("Agent Started");
        trackCommand(finalVal);
        onRunAgent(finalVal, hasImages ? attachedImages : undefined);
        setAttachedImages([]);
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
      ? completions[selectedIndex]
      : null;

  return (
    <div
      className="w-full flex flex-col relative gap-2 z-100"
      data-tutorial="smart-input"
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
            ? "bg-cyan-50 border-cyan-400 shadow-sm text-cyan-900"
            : "bg-cyan-950/40 border-cyan-400/40 shadow-[0_0_20px_rgba(0,223,252,0.1)] backdrop-blur-md text-cyan-100"
          : mode === "advice"
            ? theme === "light"
              ? "bg-purple-50 border-purple-300 shadow-sm text-purple-900"
              : "bg-purple-950/30 border-purple-500/25 shadow-[0_0_15px_rgba(168,85,247,0.06)] backdrop-blur-md text-purple-100"
            : theme === "light"
              ? "bg-white border-gray-200 shadow-sm text-black"
              : theme === "modern"
                ? "bg-white/[0.03] border-white/[0.08] text-gray-100 backdrop-blur-2xl"
                : "bg-[#0e0e0e] border-white/10 text-gray-200 shadow-xl"
          }`}
      >
        {/* Drop zone hint */}
        {isDragOver && (
          <div className={`flex items-center justify-center py-2 text-xs font-medium ${
            theme === "light" ? "text-purple-600" : "text-purple-300"
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
                  className={`h-10 w-10 rounded object-cover border ${
                    theme === "light" ? "border-gray-200" : "border-white/10"
                  }`}
                />
                <button
                  onClick={() => removeImage(i)}
                  className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full text-white flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity shadow-sm ${
                    theme === "light" ? "bg-red-500" : "bg-red-500/90"
                  }`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          {/* Mode Switcher Removed */}


          <div className="relative flex-1 flex items-center">
            {/* Ghost Text Overlay — shows shell completions, AI suggestions, or both */}
            {(ghostText || aiGhostText || (value && currentCompletion)) && (
              <div className="absolute inset-0 pointer-events-none font-mono text-sm whitespace-pre-wrap break-words overflow-hidden">
                <span className="invisible">{value}</span>
                <span className="text-gray-500 opacity-50">
                  {ghostText || aiGhostText ||
                    (currentCompletion && currentCompletion.startsWith(value.split('\n').pop() || "")
                      ? currentCompletion.slice((value.split('\n').pop() || "").length)
                      : "")}
                </span>
              </div>
            )}

            <textarea
              ref={inputRef}
              rows={1}
              className={`w-full bg-transparent font-mono text-sm outline-none resize-none overflow-hidden ${theme === "light"
                ? "text-gray-900 placeholder-gray-400"
                : "text-gray-100 placeholder-gray-500"
                }`}
              style={{ minHeight: '1.5em', maxHeight: '8em' }}
              placeholder={
                aiGhostText
                  ? "" // AI suggestion shown via ghost text overlay
                  : isAuto
                    ? "Type a command or ask a question..."
                    : mode === "command"
                      ? "Type a command..."
                      : mode === "agent"
                        ? "Describe a task for the agent..."
                        : "Ask AI for advice..."
              }
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setHistoryIndex(-1);
                setSuggestedCommand(null);
                navigatedCompletionsRef.current = false;
                // Auto-resize textarea
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = el.scrollHeight + 'px';
              }}
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
              className={`font-medium ${mode === "agent" ? "text-cyan-400" : "text-teal-400"}`}
              title="Auto-detects command vs natural language"
            >
              auto · {mode}
            </span>
          ) : (
            <span
              className={`font-medium ${mode === "agent"
                ? "text-cyan-400"
                : mode === "advice"
                  ? "text-purple-400"
                  : ""
                }`}
            >
              {mode}
            </span>
          )}
          {feedbackMsg && (
            <span className="animate-in fade-in opacity-70">{feedbackMsg}</span>
          )}
          {mode === "agent" &&
            modelCapabilities?.includes("thinking") && (
              <button
                onClick={() => setThinkingEnabled?.(!thinkingEnabled)}
                className={`px-1 py-px rounded border transition-colors ${thinkingEnabled
                  ? theme === "light"
                    ? "border-cyan-300 text-cyan-600 bg-cyan-50"
                    : "border-cyan-500/30 text-cyan-400 bg-cyan-500/10"
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
          <span>⌘↵ agent</span>
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
                key={comp}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12 }}
                className={`px-3 py-2 text-xs font-mono cursor-pointer flex items-center gap-2 ${i === selectedIndex
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:bg-white/5"
                  }`}
                onClick={() => {
                  // Build the final command from the completion
                  const lines = value.split('\n');
                  const lastLine = lines.pop() || "";
                  let finalCmd: string;
                  if (comp.toLowerCase().startsWith(lastLine.trim().toLowerCase()) && comp.includes(" ")) {
                    lines.push(comp);
                  } else {
                    const parts = lastLine.trimEnd().split(/\s+/);
                    parts.pop();
                    parts.push(comp);
                    lines.push(parts.join(" "));
                  }
                  finalCmd = lines.join('\n').trim();
                  // Always send to terminal — completions are commands
                  setCompletions([]);
                  setShowCompletions(false);
                  setGhostText("");
                  setValue("");
                  setHistoryIndex(-1);
                  trackCommand(finalCmd);
                  onSend(finalCmd);
                }}
              >
                <Terminal className="w-3 h-3 opacity-50 shrink-0" />
                <span className="truncate">{comp}</span>
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
            className={`absolute bottom-full left-0 mb-2 w-full backdrop-blur border rounded-lg p-3 shadow-xl z-10 max-h-48 overflow-y-auto ${theme === "light"
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
                <div
                  className={`text-xs leading-relaxed font-mono ${theme === "light" ? "text-gray-700" : "text-gray-300"}`}
                >
                  {suggestion ||
                    (isLoading ? (
                      <span
                        className={`italic ${theme === "light" ? "text-gray-400" : "text-gray-500"}`}
                      >
                        Generating...
                      </span>
                    ) : (
                      ""
                    ))}
                  {isLoading && suggestion && (
                    <span className="inline-block w-1.5 h-3 bg-purple-400/60 animate-pulse ml-0.5 align-middle" />
                  )}
                </div>
                {/* Accept / Run buttons */}
                {suggestion && !isLoading && (
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/10">
                    <button
                      onClick={() => {
                        setValue(suggestion);
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
                    <button
                      onClick={() => {
                        const cmd = suggestion;
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
export default React.memo(SmartInput);
