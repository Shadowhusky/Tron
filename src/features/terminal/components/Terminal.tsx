import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTheme } from "../../../contexts/ThemeContext";
import { useAgent } from "../../../contexts/AgentContext";
import { IPC, terminalEchoChannel } from "../../../constants/ipc";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  className?: string;
  sessionId: string;
}

const THEMES = {
  dark: {
    background: "#0a0a0a",
    foreground: "#e5e7eb",
    cursor: "#e5e7eb",
    selectionBackground: "#ffffff30",
  },
  modern: {
    background: "#050510",
    foreground: "#d4d4e0",
    cursor: "#a855f7",
    selectionBackground: "#a855f720",
  },
  light: {
    background: "#f9fafb",
    foreground: "#1f2937",
    cursor: "#1f2937",
    selectionBackground: "#3b82f630",
  },
};

const Terminal: React.FC<TerminalProps> = ({ className, sessionId }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Xterm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { resolvedTheme } = useTheme();
  const { isAgentRunning, stopAgent } = useAgent(sessionId);

  useEffect(() => {
    if (!terminalRef.current) return;

    const termTheme = THEMES[resolvedTheme] || THEMES.dark;

    // Initialize xterm.js
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

    // Store refs immediately
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Initial fit
    try {
      fitAddon.fit();
    } catch (e) {
      console.warn("Initial fit failed", e);
    }

    term.focus();

    // Cmd+K to clear
    term.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        term.clear();
        return false; // Prevent default
      }
      return true;
    });

    // Resize Logic
    const performResize = () => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      try {
        // 1. Fit frontend
        fitAddonRef.current.fit();

        // 2. Sync backend
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

    // Debounce resize to prevent thrashing PTY during animations
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const debouncedResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        performResize();
      }, 100); // 100ms debounce
    };

    // Initial Resizes (Multiple attempts to catch layout settlement)
    performResize();
    setTimeout(performResize, 50);
    setTimeout(performResize, 250);

    // Restore History
    if (window.electron) {
      window.electron.ipcRenderer
        .getHistory(sessionId)
        .then((history: string) => {
          if (history && xtermRef.current) {
            term.write(history);
            // Fit again after content loaded?
            setTimeout(performResize, 10);
          }
        });
    }

    // Observer
    const resizeObserver = new ResizeObserver(() => {
      debouncedResize();
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }
    window.addEventListener("resize", debouncedResize);

    // Expose write via IPC for agent echo
    const handleEcho = (_: any, data: string) => {
      term.write(data);
    };

    // Send Input
    const disposableOnData = term.onData((data) => {
      // Check for Ctrl+C to abort agent
      if (data === "\u0003" && isAgentRunning) {
        stopAgent();
      }

      if (window.electron) {
        window.electron.ipcRenderer.send(IPC.TERMINAL_WRITE, {
          id: sessionId,
          data,
        });
      }
    });

    // Receive Output
    let removeIncomingListener: (() => void) | undefined;
    let removeEchoListener: (() => void) | undefined;

    if (window.electron) {
      removeIncomingListener = window.electron.ipcRenderer.on(
        IPC.TERMINAL_INCOMING_DATA,
        ({ id, data }: { id: string; data: string }) => {
          if (id === sessionId) {
            term.write(data);
          }
        },
      );

      removeEchoListener = window.electron.ipcRenderer.on(
        terminalEchoChannel(sessionId),
        handleEcho,
      );
    } else {
      term.write("\r\n\x1b[33m[Mock Mode] Electron not detected.\x1b[0m\r\n");
    }

    return () => {
      clearTimeout(resizeTimeout);
      term.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", debouncedResize);
      if (removeIncomingListener) removeIncomingListener();
      if (removeEchoListener) removeEchoListener();
      disposableOnData.dispose();
    };
  }, [sessionId, resolvedTheme]);

  return <div className={className} ref={terminalRef} />;
};

export default Terminal;
