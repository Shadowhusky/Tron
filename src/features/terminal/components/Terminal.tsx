import React, { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTheme } from "../../../contexts/ThemeContext";
import { useAgent } from "../../../contexts/AgentContext";
import { useConfig } from "../../../contexts/ConfigContext";
import { IPC, terminalEchoChannel } from "../../../constants/ipc";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  className?: string;
  sessionId: string;
  onActivity?: () => void;
  isActive?: boolean;
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

const Terminal: React.FC<TerminalProps> = ({ className, sessionId, onActivity, isActive }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Xterm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { resolvedTheme } = useTheme();
  const { isAgentRunning, stopAgent } = useAgent(sessionId);
  const { hotkeys } = useConfig();

  // Refs for values accessed inside stable closures
  const isAgentRunningRef = useRef(isAgentRunning);
  useEffect(() => { isAgentRunningRef.current = isAgentRunning; }, [isAgentRunning]);
  const stopAgentRef = useRef(stopAgent);
  useEffect(() => { stopAgentRef.current = stopAgent; }, [stopAgent]);
  const hotkeysRef = useRef(hotkeys);
  useEffect(() => { hotkeysRef.current = hotkeys; }, [hotkeys]);

  // ---- Main effect: create terminal (once per sessionId) ----
  useEffect(() => {
    if (!terminalRef.current) return;

    const termTheme = THEMES[resolvedTheme] || THEMES.dark;

    const term = new Xterm({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      theme: termTheme,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalRef.current);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Local-only fit (adjusts xterm cols/rows to container — no IPC to backend).
    // We must NOT send resize IPC before history is restored, because resizing
    // the PTY causes the shell to re-render its prompt, which appends a duplicate
    // prompt to the backend history buffer.
    try { fitAddon.fit(); } catch (e) { console.warn("Initial fit failed", e); }

    term.focus();

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
        return false;
      }
      if (matches(overlayCombo)) {
        return false;
      }
      return true;
    });

    // Resize Logic — syncs xterm dimensions to backend PTY
    const performResize = () => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      try {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
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

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const debouncedResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(performResize, 100);
    };

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
      window.electron.ipcRenderer
        .getHistory(sessionId)
        .then((history: string) => {
          if (!mounted) return; // Component unmounted before history arrived

          if (history && xtermRef.current) {
            term.write(history);
          }

          // Register the incoming data listener AFTER history is written
          removeIncomingListener = window.electron.ipcRenderer.on(
            IPC.TERMINAL_INCOMING_DATA,
            ({ id, data }: { id: string; data: string }) => {
              if (id === sessionId) {
                term.write(data);
              }
            },
          );

          // NOW sync dimensions to backend — any prompt re-renders from
          // resize go through the listener (not duplicated in history)
          performResize();
          setTimeout(performResize, 50);
          setTimeout(performResize, 250);
          // Re-focus after animation may have completed (embedded terminal in agent view)
          setTimeout(() => { if (xtermRef.current) xtermRef.current.focus(); }, 350);
        });
    } else {
      term.write("\r\n\x1b[33m[Mock Mode] Electron not detected.\x1b[0m\r\n");
    }

    // ResizeObserver
    const resizeObserver = new ResizeObserver(debouncedResize);
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }
    window.addEventListener("resize", debouncedResize);

    // Send Input
    let activityFired = false;
    const disposableOnData = term.onData((data) => {
      if (data === "\u0003" && isAgentRunningRef.current) {
        stopAgentRef.current();
      }

      if (!activityFired && data === "\r" && onActivity) {
        activityFired = true;
        onActivity();
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
      clearTimeout(resizeTimeout);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      resizeObserver.disconnect();
      window.removeEventListener("resize", debouncedResize);
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

  // ---- Focus when tab becomes active ----
  useEffect(() => {
    if (isActive && xtermRef.current) {
      xtermRef.current.focus();
    }
  }, [isActive]);

  return <div className={className} ref={terminalRef} />;
};

export default React.memo(Terminal);
