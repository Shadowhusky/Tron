import React, { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTheme } from "../../../contexts/ThemeContext";
import { useConfig } from "../../../contexts/ConfigContext";
import { IPC, terminalEchoChannel } from "../../../constants/ipc";
import { registerScreenBufferReader, unregisterScreenBufferReader, registerSelectionReader, unregisterSelectionReader } from "../../../services/terminalBuffer";
import { isElectronApp, isTouchDevice } from "../../../utils/platform";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  className?: string;
  sessionId: string;
  onActivity?: () => void;
  /** Called once when the user presses Enter in the terminal for the first time. */
  onFirstCommand?: () => void;
  isActive?: boolean;
  isAgentRunning?: boolean;
  stopAgent?: () => void;
  focusTarget?: "input" | "terminal";
  isReconnected?: boolean;
  /** Saved terminal history to write directly to xterm on mount (loaded sync tabs). */
  pendingHistory?: string;
}

const THEMES: Record<string, Xterm["options"]["theme"]> = {
  dark: {
    background: "#0a0a0a",
    foreground: "#e5e7eb",
    cursor: "#e5e7eb",
    selectionBackground: "#ffffff30",
  },
  modern: {
    background: "#040414",
    foreground: "#d4d4e0",
    cursor: "#c084fc",
    selectionBackground: "#a855f718",
  },
  light: {
    background: "#f9fafb",
    foreground: "#1f2937",
    cursor: "#1f2937",
    selectionBackground: "#3b82f630",
  },
};

const Terminal: React.FC<TerminalProps> = ({ className, sessionId, onActivity, onFirstCommand, isActive, isAgentRunning = false, stopAgent, focusTarget, isReconnected, pendingHistory }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const resizeMaskRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Xterm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { resolvedTheme } = useTheme();
  const { hotkeys } = useConfig();

  // Loading overlay — for web mode reconnected/restored sessions to mask
  // flicker from history replay / TUI redraw. Electron restores instantly.
  const showLoadingOverlay = (!!isReconnected || !!pendingHistory) && !!isActive && !isElectronApp();
  const [loading, setLoading] = useState(showLoadingOverlay);
  useEffect(() => {
    if (!showLoadingOverlay) return;
    const timer = setTimeout(() => setLoading(false), 1500);
    return () => clearTimeout(timer);
  }, [sessionId]);

  // Refs for values accessed inside stable closures
  const isAgentRunningRef = useRef(isAgentRunning);
  useEffect(() => { isAgentRunningRef.current = isAgentRunning; }, [isAgentRunning]);
  const stopAgentRef = useRef(stopAgent);
  const focusTargetRef = useRef(focusTarget);
  useEffect(() => { focusTargetRef.current = focusTarget; }, [focusTarget]);
  useEffect(() => { stopAgentRef.current = stopAgent; }, [stopAgent]);
  const hotkeysRef = useRef(hotkeys);
  useEffect(() => { hotkeysRef.current = hotkeys; }, [hotkeys]);
  // Suppress outgoing onData → PTY writes during reconnect to prevent DSR
  // response corruption (xterm responds to stale cursor-position requests)
  const suppressOutgoingRef = useRef(false);

  // ---- Main effect: create terminal (once per sessionId) ----
  useEffect(() => {
    if (!terminalRef.current) return;
    const el = terminalRef.current;

    const termTheme = THEMES[resolvedTheme] || THEMES.dark;

    const reconnecting = !!isReconnected;

    const isTouch = isTouchDevice();

    const term = new Xterm({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      theme: termTheme,
      allowProposedApi: true,
      // Reduce scrollback on mobile to save memory and speed up fit()/scroll
      ...(isTouch ? { scrollback: 1000 } : {}),
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(el);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Register screen buffer reader so the agent can read rendered TUI content
    registerScreenBufferReader(sessionId, (lines: number) => {
      const buf = term.buffer.active;
      const totalRows = buf.length;
      const start = Math.max(0, totalRows - lines);
      const result: string[] = [];
      for (let i = start; i < totalRows; i++) {
        const line = buf.getLine(i);
        if (line) result.push(line.translateToString(true));
      }
      // Trim trailing empty lines
      while (result.length > 0 && result[result.length - 1].trim() === "") {
        result.pop();
      }
      return result.join("\n");
    });

    // Register selection reader so context menu can read selected text
    registerSelectionReader(sessionId, () => term.getSelection());

    // Local-only fit (adjusts xterm cols/rows to container — no IPC to backend).
    // We must NOT send resize IPC before history is restored, because resizing
    // the PTY causes the shell to re-render its prompt, which appends a duplicate
    // prompt to the backend history buffer.
    try { fitAddon.fit(); } catch (e) { console.warn("Initial fit failed", e); }

    term.focus();

    // Save a file blob to temp via IPC and write the path to the terminal PTY.
    const saveFileAndType = async (blob: Blob, filename?: string) => {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      // Derive extension from filename or MIME type
      const ext = filename
        ? (filename.split(".").pop() || "bin")
        : (blob.type.split("/")[1]?.replace("jpeg", "jpg") || "bin");
      const filePath = await window.electron?.ipcRenderer?.invoke(
        "file.saveTempImage",
        { base64, ext },
      );
      if (filePath && window.electron) {
        window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
          id: sessionId,
          data: filePath,
        });
      }
    };

    // Custom key handling — intercept configurable hotkeys before xterm
    term.attachCustomKeyEventHandler((e) => {
      // Parse the clearTerminal hotkey to check dynamically
      const clearCombo = hotkeysRef.current.clearTerminal || "meta+k";
      const overlayCombo = hotkeysRef.current.toggleOverlay || "meta+.";

      // Helper: check if event matches a combo string
      const matches = (combo: string) => {
        const parts = combo.toLowerCase().split("+");
        const baseKey = parts[parts.length - 1];
        const needsMeta = parts.includes("meta") || parts.includes("cmd");
        const needsCtrl = parts.includes("ctrl");
        if (needsMeta && !e.metaKey) return false;
        if (needsCtrl && !e.ctrlKey) return false;
        return e.key.toLowerCase() === baseKey;
      };

      if (matches(clearCombo)) {
        term.clear();
        window.electron?.ipcRenderer?.invoke?.(IPC.TERMINAL_CLEAR_HISTORY, sessionId)?.catch?.(() => {});
        return false;
      }
      if (matches(overlayCombo)) {
        return false;
      }
      // Let xterm handle Cmd/Ctrl+V natively — its internal paste handler
      // reads clipboardData synchronously (more reliable than async Clipboard
      // API) and wraps text in bracketed paste sequences for TUI compatibility.
      // Image handling is done via the separate 'paste' event listener below.
      return true;
    });

    // Paste event listener — intercepts images/files from clipboard.
    // Text paste is handled natively by xterm (bracketed paste aware).
    // This fires on both Cmd+V and right-click paste.
    const onPaste = async (e: ClipboardEvent) => {
      const cd = e.clipboardData;
      if (!cd) return;
      // Check for image/file items in clipboardData
      for (const item of Array.from(cd.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          const file = item.getAsFile();
          if (file) await saveFileAndType(file);
          return;
        }
      }
      // Fallback: server-side clipboard read (web mode — clipboardData may be empty)
      try {
        if (window.electron?.ipcRenderer?.readClipboardImage) {
          const base64 = await window.electron.ipcRenderer.readClipboardImage();
          if (base64) {
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const blob = new Blob([bytes], { type: "image/png" });
            await saveFileAndType(blob, `paste-${Date.now()}.png`);
            return;
          }
        }
      } catch { /* IPC not available */ }
      // Text paste — let xterm handle it (default behavior)
    };
    el.addEventListener("paste", onPaste);

    // Resize Logic — syncs xterm dimensions to backend PTY.
    // During reconnect settling, ResizeObserver resizes are deferred to avoid
    // sending premature SIGWINCH while the bounce-resize is in progress.
    let reconnectSettled = !reconnecting;
    let prevCols = 0;
    let prevRows = 0;
    let resizeMaskTimer: ReturnType<typeof setTimeout> | undefined;
    const performResize = () => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      if (!reconnectSettled) return; // defer until bounce completes

      try {
        // Save scroll state BEFORE fit() — fit() recalculates rows and can
        // reset the viewport scroll position, causing a visible jump.
        const viewport = el.querySelector(".xterm-viewport");
        const wasAtBottom = !viewport || (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5);
        const savedScrollTop = viewport?.scrollTop ?? 0;

        fitAddonRef.current.fit();

        // Restore scroll position to prevent visible jump during resize.
        // If user was at the bottom, pin there; otherwise restore exact position.
        if (viewport) {
          if (wasAtBottom) {
            viewport.scrollTop = viewport.scrollHeight;
          } else {
            viewport.scrollTop = savedScrollTop;
          }
        }
        const { cols, rows } = xtermRef.current;

        // Brief mask when dimensions change significantly (e.g. split).
        // Hides TUI redraw flicker (gap between fit() and SIGWINCH redraw).
        const colDelta = Math.abs(cols - prevCols);
        const rowDelta = Math.abs(rows - prevRows);
        if (prevCols > 0 && (colDelta > 3 || rowDelta > 3)) {
          const mask = resizeMaskRef.current;
          if (mask) {
            mask.style.opacity = "1";
            clearTimeout(resizeMaskTimer);
            resizeMaskTimer = setTimeout(() => { mask.style.opacity = "0"; }, 150);
          }
        }
        prevCols = cols;
        prevRows = rows;

        if (
          window.electron &&
          Number.isInteger(cols) &&
          Number.isInteger(rows)
        ) {
          window.electron.ipcRenderer.send(IPC.TERMINAL_RESIZE, {
            id: sessionId,
            cols,
            rows,
          });
        }
      } catch (e) {
        console.error("Resize failed:", e);
      }
    };

    // Time-based trailing-edge resize debounce — limits fit() + SIGWINCH to
    // at most once per 100ms of no resize events. This is critical for TUIs
    // (Claude Code, vim, etc.) which do expensive full redraws on each
    // SIGWINCH. RAF-based debouncing would fire 60x/sec and cause visible
    // flickering as the TUI redraws on every frame.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let splitDragging = false;
    const debouncedResize = () => {
      if (splitDragging) return; // defer fit() during split drag
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(performResize, 100);
    };

    // Defer fit() during SplitPane drag to eliminate ALL xterm redraws
    const onSplitDragStart = () => { splitDragging = true; };
    const onSplitDragEnd = () => {
      splitDragging = false;
      performResize(); // one clean fit() at final size
    };
    window.addEventListener("tron:splitDragStart", onSplitDragStart);
    window.addEventListener("tron:splitDragEnd", onSplitDragEnd);

    // NOTE: No performResize() calls here! We defer until after history +
    // listener are set up (see getHistory .then() below).

    // ---- IPC Listeners ----
    let mounted = true;
    let removeIncomingListener: (() => void) | undefined;
    let removeEchoListener: (() => void) | undefined;

    if (window.electron) {
      // Echo listener (for agent writes) — safe to register immediately
      const handleEcho = (_: any, data: string) => {
        term.write(data);
      };
      removeEchoListener = window.electron.ipcRenderer.on(
        terminalEchoChannel(sessionId),
        handleEcho,
      );

      // Restore history FIRST, then register incoming data listener,
      // then resize. This order prevents:
      // 1. Duplication from listener + history race condition
      // 2. Duplicate prompts from resize-triggered shell re-renders
      const finishSetup = (history?: string, knownReconnect = false) => {
          if (!mounted) return;

          // Prefer saved history from loaded tabs (pendingHistory) over server
          // getHistory. In web mode, the fresh PTY outputs a shell prompt before
          // getHistory responds, making it non-empty and masking the saved content.
          const effectiveHistory = pendingHistory || ((history && history.length > 0) ? history : undefined);
          const isReconnect = knownReconnect || !!effectiveHistory;

          if (isReconnect) {
            // Suppress outgoing onData → PTY during bounce to prevent DSR
            // response corruption from stale escape sequences.
            suppressOutgoingRef.current = true;
          }

          // Write history to xterm BEFORE registering the incoming data listener.
          // On page reload (mobile OS kill, manual refresh), xterm is brand new
          // with an empty buffer — this restores previous terminal output.
          if (effectiveHistory) {
            term.write(effectiveHistory);
          }

          // Register the incoming data listener — data flows freely so xterm
          // renders content behind the loading overlay (no visual flicker)
          removeIncomingListener = window.electron.ipcRenderer.on(
            IPC.TERMINAL_INCOMING_DATA,
            ({ id, data }: { id: string; data: string }) => {
              if (id === sessionId) {
                term.write(data);
              }
            },
          );

          if (isReconnect) {
            // Fit locally to get correct dimensions
            try { fitAddon.fit(); } catch { /* ignore */ }

            // Force the running app to redraw via SIGWINCH bounce.
            // The kernel ignores same-size resize (no SIGWINCH), so we
            // shrink by 1 col then restore — two SIGWINCHs guaranteed.
            // The loading overlay hides the terminal, so all redraws happen
            // behind it — the user only sees the final clean state.
            const { cols, rows } = term;
            if (window.electron && cols > 2) {
              window.electron.ipcRenderer.send(IPC.TERMINAL_RESIZE, {
                id: sessionId, cols: cols - 1, rows,
              });
              setTimeout(() => {
                suppressOutgoingRef.current = false;
                window.electron?.ipcRenderer?.send(IPC.TERMINAL_RESIZE, {
                  id: sessionId, cols, rows,
                });
              }, 50);
            } else {
              suppressOutgoingRef.current = false;
              reconnectSettled = true;
              performResize();
            }

            // Allow ResizeObserver resizes after bounce settles (300ms).
            // The loading overlay handles visual hiding — no opacity manipulation needed.
            setTimeout(() => {
              reconnectSettled = true;
              performResize();
            }, 300);
          } else {
            // Fresh session — sync dimensions normally.
            // On mobile a single resize is enough; desktop does a follow-up
            // at 250ms to catch late layout settling (font load, etc.).
            performResize();
            if (!isTouch) setTimeout(performResize, 250);
          }

          // Re-focus after reconnect settles or animation completes
          setTimeout(() => {
            if (xtermRef.current && focusTargetRef.current === "terminal") {
              xtermRef.current.focus();
            }
          }, 350);
      };

      // Always fetch history — on page reload (mobile OS kill, manual refresh),
      // xterm starts with an empty buffer. Even for reconnected sessions, we
      // need history to restore previous output before doing the bounce-resize.
      window.electron.ipcRenderer
        .getHistory(sessionId)
        .then((history: string) => finishSetup(history, reconnecting))
        .catch(() => finishSetup(undefined, reconnecting));
    } else if (sessionId.startsWith("mock-")) {
      term.write("\r\n\x1b[31m[Error] Failed to connect to terminal server.\x1b[0m\r\n");
      term.write("\x1b[33mPlease reload the page to try again.\x1b[0m\r\n");
    } else {
      term.write("\r\n\x1b[33m[Mock Mode] Electron not detected.\x1b[0m\r\n");
    }

    // Touch scroll — xterm v6 has no built-in touch scroll support.
    // The .xterm-screen canvas sits on top of .xterm-viewport (the native
    // scroll container), so touch events never reach it. We manually
    // translate touch-move deltas into term.scrollLines() calls.
    let touchStartY = 0;
    let touchAccum = 0;
    const LINE_HEIGHT = term.options.fontSize ? term.options.fontSize * 1.2 : 17;

    // Suppress touch-scroll while the virtual keyboard is opening/closing.
    // The viewport resize generates touch events with large dy deltas that
    // would otherwise scroll the terminal to the top of history.
    let viewportResizing = false;
    let viewportResizeTimer: ReturnType<typeof setTimeout> | undefined;
    const vv = isTouchDevice() ? window.visualViewport : null;
    const onViewportResize = () => {
      viewportResizing = true;
      clearTimeout(viewportResizeTimer);
      viewportResizeTimer = setTimeout(() => { viewportResizing = false; }, 300);
    };
    vv?.addEventListener("resize", onViewportResize);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || viewportResizing) return;
      touchStartY = e.touches[0].clientY;
      touchAccum = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || viewportResizing) return;
      const dy = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      touchAccum += dy;
      const lines = Math.trunc(touchAccum / LINE_HEIGHT);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchAccum -= lines * LINE_HEIGHT;
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });

    // Drag-and-drop any file onto terminal — saves to temp and pastes path
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Save each dropped file
      for (const file of Array.from(files)) {
        saveFileAndType(file, file.name);
      }
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);

    // ResizeObserver — covers both window resize and container layout changes
    // (e.g. agent overlay expand/collapse). No separate window resize listener
    // needed — that would cause duplicate fit() calls on every resize event.
    const resizeObserver = new ResizeObserver(debouncedResize);
    resizeObserver.observe(el);

    // Send Input
    let activityFired = false;
    const disposableOnData = term.onData((data) => {
      // Suppress outgoing writes during reconnect (prevents DSR corruption)
      if (suppressOutgoingRef.current) return;

      if (data === "\u0003" && isAgentRunningRef.current) {
        stopAgentRef.current?.();
      }

      if (!activityFired && data === "\r") {
        activityFired = true;
        onActivity?.();
        onFirstCommand?.();
      }

      if (window.electron) {
        window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
          id: sessionId,
          data,
        });
      }
    });

    return () => {
      mounted = false;
      clearTimeout(resizeTimer);
      clearTimeout(resizeMaskTimer);
      window.removeEventListener("tron:splitDragStart", onSplitDragStart);
      window.removeEventListener("tron:splitDragEnd", onSplitDragEnd);
      unregisterScreenBufferReader(sessionId);
      unregisterSelectionReader(sessionId);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      resizeObserver.disconnect();
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      vv?.removeEventListener("resize", onViewportResize);
      clearTimeout(viewportResizeTimer);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("paste", onPaste);
      if (removeIncomingListener) removeIncomingListener();
      if (removeEchoListener) removeEchoListener();
      disposableOnData.dispose();
    };
  }, [sessionId]); // Only recreate on session change — NOT on theme change

  // ---- Listen for programmatic clear requests (from useHotkey when SmartInput has focus) ----
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === sessionId && xtermRef.current) {
        xtermRef.current.clear();
        // Also clear server-side history so it doesn't reappear after page refresh
        window.electron?.ipcRenderer?.invoke?.(IPC.TERMINAL_CLEAR_HISTORY, sessionId)?.catch?.(() => {});
      }
    };
    window.addEventListener("tron:clearTerminal", handler);
    return () => window.removeEventListener("tron:clearTerminal", handler);
  }, [sessionId]);

  // ---- Theme update — lightweight, no terminal recreation ----
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = THEMES[resolvedTheme] || THEMES.dark;
    }
  }, [resolvedTheme]);

  // ---- Focus when tab becomes active (only if user last focused terminal) ----
  useEffect(() => {
    if (isActive && xtermRef.current && focusTarget === "terminal") {
      xtermRef.current.focus();
    }
  }, [isActive, focusTarget]);

  const theme = THEMES[resolvedTheme] || THEMES.dark;

  return (
    <div className={`relative overflow-hidden ${className || ""}`} style={{ contain: "strict" }}>
      <div
        ref={terminalRef}
        className={`absolute inset-0${loading ? " transition-opacity duration-300 ease-in" : ""}`}
        style={{ opacity: loading ? 0 : 1 }}
      />
      {/* Resize mask — briefly covers terminal during significant resizes (splits)
          to hide TUI redraw flicker. Controlled imperatively from performResize(). */}
      <div
        ref={resizeMaskRef}
        className="absolute inset-0 z-[5] pointer-events-none"
        style={{ opacity: 0, backgroundColor: theme?.background, transition: "opacity 120ms ease-out" }}
      />
      {/* Loading overlay — retro bash-style spinner */}
      <div
        className={`absolute inset-0 z-10 flex items-start p-5 transition-opacity duration-300 ease-out ${
          loading ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        style={{ backgroundColor: theme?.background }}
      >
        <span
          className="font-mono text-2xl"
          style={{ color: theme?.cursor, opacity: 0.6 }}
        >
          <span className="termSpinner" />
        </span>
        <style>{`
          .termSpinner::after {
            content: "⠋";
            animation: termSpin 0.8s steps(1) infinite;
          }
          @keyframes termSpin {
            0%   { content: "⠋"; }
            12%  { content: "⠙"; }
            25%  { content: "⠹"; }
            37%  { content: "⠸"; }
            50%  { content: "⠼"; }
            62%  { content: "⠴"; }
            75%  { content: "⠦"; }
            87%  { content: "⠧"; }
          }
        `}</style>
      </div>
    </div>
  );
};

export default React.memo(Terminal);
