import React, { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { useTheme } from "../../../contexts/ThemeContext";
import { useConfig } from "../../../contexts/ConfigContext";
import { IPC, terminalEchoChannel } from "../../../constants/ipc";
import { registerScreenBufferReader, unregisterScreenBufferReader, registerSelectionReader, unregisterSelectionReader, registerViewportTextReader, unregisterViewportTextReader } from "../../../services/terminalBuffer";
import { isElectronApp, isTouchDevice, normalizePath } from "../../../utils/platform";
import { isRemoteSession } from "../../../services/remote-bridge";
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
  /** Called when user scrolls up/down — true = scrolled up from bottom */
  onScrolledUpChange?: (scrolledUp: boolean) => void;
  /** When true, touch events are handled by the native text overlay instead of scrolling. */
  selectionMode?: boolean;
}

const THEMES: Record<string, Xterm["options"]["theme"]> = {
  dark: {
    background: "#0a0a0a",
    foreground: "#e5e7eb",
    cursor: "#e5e7eb",
    selectionBackground: "#ffffff40",
  },
  modern: {
    background: "#040414",
    foreground: "#d4d4e0",
    cursor: "#c084fc",
    selectionBackground: "#a855f740",
  },
  light: {
    background: "#f9fafb",
    foreground: "#1f2937",
    cursor: "#1f2937",
    selectionBackground: "#3b82f640",
  },
};

const Terminal: React.FC<TerminalProps> = ({ className, sessionId, onActivity, onFirstCommand, isActive, isAgentRunning = false, stopAgent, focusTarget, isReconnected, pendingHistory, onScrolledUpChange, selectionMode }) => {
  const terminalRef = useRef<HTMLDivElement>(null);

  const xtermRef = useRef<Xterm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const { resolvedTheme } = useTheme();
  const { hotkeys } = useConfig();

  // Search bar state
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Loading overlay — for web mode reconnected/restored sessions to mask
  // flicker from history replay / TUI redraw. Electron restores instantly.
  const showLoadingOverlay = (!!isReconnected || !!pendingHistory) && !!isActive && !isElectronApp();
  const [loading, setLoading] = useState(showLoadingOverlay);
  useEffect(() => {
    if (!showLoadingOverlay) return;
    const timer = setTimeout(() => setLoading(false), 1500);
    return () => clearTimeout(timer);
  }, [sessionId]);

  // Ref for onScrolledUpChange to avoid re-creating the main effect
  const onScrolledUpChangeRef = useRef(onScrolledUpChange);
  useEffect(() => { onScrolledUpChangeRef.current = onScrolledUpChange; }, [onScrolledUpChange]);

  // Refs for selection mode (touch-to-select) — accessed inside stable closures
  const selectionModeRef = useRef(selectionMode);
  useEffect(() => { selectionModeRef.current = selectionMode; }, [selectionMode]);

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
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      // Dispatch event so parent can show link popover at click position
      const me = event as MouseEvent;
      window.dispatchEvent(new CustomEvent("tron:linkClicked", {
        detail: { url: uri, x: me.clientX, y: me.clientY, sessionId },
      }));
    });

    const searchAddon = new SearchAddon();
    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";
    searchAddonRef.current = searchAddon;

    // File path link provider — makes file paths clickable in terminal output.
    // Supports absolute (/foo/bar.ts, C:\foo\bar.ts) and relative paths
    // (src/components/DataTable.tsx, routes/$id/index.tsx, app/[slug]/page.tsx).
    // Relative paths resolved against session CWD at click time.
    //
    // Segment chars: \w . $ @ + ~ - [ ] ( ) '  — covers Remix ($id), Next.js
    // ([id]), SvelteKit (+page), route groups ((auth)), scoped pkgs (@foo),
    // macOS iCloud paths (com~apple~CloudDocs), possessives ("Husky's SSD").
    // Spaces allowed within interior segments (between two /) but not in the
    // final segment, to avoid capturing trailing sentence text.
    const S = "[\\w.$@+~\\-\\[\\]()\']"; // path segment char (no space)
    const interiorSeg = "/" + S + "+(?:\\s+" + S + "+)*(?=/)"; // spaces ok, lookahead for next /
    const finalSeg = "/" + S + "+"; // no spaces in last segment
    const absUnixRe  = new RegExp("(?:" + interiorSeg + ")+" + finalSeg + "(?:\\.\\w+)?", "g");
    const winRe      = new RegExp("[A-Z]:\\\\(?:" + S + "+\\\\)*" + S + "+(?:\\.\\w+)?", "gi");
    const relRe      = new RegExp("(?:\\.\\/)?(?:" + S + "+\\/){1,}" + S + "+\\.\\w+", "g");

    const editorExts = new Set([
      "js","mjs","cjs","jsx","ts","mts","cts","tsx","py","pyw","json","jsonc",
      "c","h","cpp","cc","cxx","hpp","hxx","html","htm","svg","xml",
      "css","scss","less","md","mdx","rs","java","yaml","yml","toml","ini",
      "cfg","conf","sh","bash","zsh","fish","txt","log","env","sql",
      "vue","svelte","rb","php","go","swift","kt","kts",
    ]);
    const editorFiles = new Set(["Makefile","Dockerfile",".gitignore",".dockerignore"]);
    const knownExts = new Set([...editorExts, "app","dmg","exe","pkg","deb","rpm","zip","tar","gz","bz2","xz","7z","rar","iso","img","bin","so","dylib","dll","o","a","wasm","map","lock","pid"]);

    /** Strip trailing sentence punctuation that isn't part of a real file extension. */
    const cleanTrailing = (p: string): string => {
      // Repeatedly strip trailing punctuation: .  ,  ;  :  !  ?  )
      // But preserve if the part after last / contains a known extension ending
      let cleaned = p;
      while (/[.,;:!?)\]}>]$/.test(cleaned)) {
        const candidate = cleaned.slice(0, -1);
        // If stripping would remove a known extension's last char, check if the
        // original ending is actually part of a valid ext (e.g. "file.app" — don't strip)
        const ext = cleaned.split(".").pop()?.toLowerCase() || "";
        if (knownExts.has(ext)) break;
        cleaned = candidate;
      }
      return cleaned;
    };

    const activateFilePath = async (filePath: string) => {
      let resolved = filePath;

      // Resolve relative paths against session CWD
      const isRelative = !filePath.startsWith("/") && !/^[A-Z]:\\/i.test(filePath);
      if (isRelative) {
        try {
          const cwd = await window.electron?.ipcRenderer?.getCwd?.(sessionId);
          if (cwd) {
            resolved = normalizePath(cwd.replace(/\/+$/, "") + "/" + filePath);
          }
        } catch { /* use as-is */ }
      }

      const ext = resolved.split(".").pop()?.toLowerCase() || "";
      const baseName = resolved.split(/[/\\]/).pop() || "";

      if (editorExts.has(ext) || editorFiles.has(baseName)) {
        // Pass sourceSessionId so CodeEditorPane can route file reads
        // through the remote bridge when this is a remote terminal session.
        window.dispatchEvent(new CustomEvent("tron:openEditorTab", {
          detail: { filePath: resolved, sourceSessionId: sessionId },
        }));
      } else {
        // Non-editor file or directory — open directly in system file manager
        if (window.electron?.ipcRenderer) {
          window.electron.ipcRenderer.invoke("shell.showItemInFolder", resolved)?.catch(() => {
            window.electron?.ipcRenderer?.invoke("shell.openPath", resolved)?.catch(() => {});
          });
        }
      }
    };

    term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const buf = term.buffer.active;
        const cols = term.cols;

        // Gather the logical line: join this row with any continuation rows
        // that have isWrapped=true. Also track the starting row.
        let startRow = lineNumber - 1;
        // Walk backwards to find the first row of this logical line
        while (startRow > 0) {
          const prev = buf.getLine(startRow);
          if (!prev || !prev.isWrapped) break;
          startRow--;
        }
        // Only process from the first row of each logical line to avoid duplicates
        if (startRow !== lineNumber - 1) { callback(undefined); return; }

        const rowTexts: string[] = [];
        let row = startRow;
        do {
          const rl = buf.getLine(row);
          if (!rl) break;
          rowTexts.push(rl.translateToString());
          row++;
        } while (row < buf.length && buf.getLine(row)?.isWrapped);
        const fullText = rowTexts.join("");
        const totalRows = rowTexts.length;

        // Collect raw matches with character offsets, then deduplicate overlaps
        const rawMatches: { start: number; end: number; text: string }[] = [];
        for (const regex of [absUnixRe, winRe, relRe]) {
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(fullText)) !== null) {
            let matched = m[0];
            if (/^https?:\/\//i.test(matched)) continue;
            matched = cleanTrailing(matched);
            if (matched.length < 3) continue;
            if (regex === relRe) {
              const ext = matched.split(".").pop()?.toLowerCase() || "";
              if (!editorExts.has(ext)) continue;
            }
            rawMatches.push({ start: m.index, end: m.index + matched.length, text: matched });
          }
        }

        // Deduplicate: when matches overlap, keep the longest one
        rawMatches.sort((a, b) => a.start - b.start || b.end - a.end);
        const deduped: typeof rawMatches = [];
        for (const m of rawMatches) {
          const prev = deduped[deduped.length - 1];
          if (prev && m.start < prev.end) {
            // Overlapping — keep the longer match
            if (m.end - m.start > prev.end - prev.start) {
              deduped[deduped.length - 1] = m;
            }
          } else {
            deduped.push(m);
          }
        }

        const links: import("@xterm/xterm").ILink[] = [];
        for (const { start: matchStart, end: matchEnd, text: matched } of deduped) {
          if (totalRows === 1) {
            links.push({
              range: { start: { x: matchStart + 1, y: lineNumber }, end: { x: matchEnd, y: lineNumber } },
              text: matched,
              activate() { activateFilePath(matched); },
            });
          } else {
            const startY = startRow + 1 + Math.floor(matchStart / cols);
            const startX = (matchStart % cols) + 1;
            const endY = startRow + 1 + Math.floor((matchEnd - 1) / cols);
            const endX = ((matchEnd - 1) % cols) + 1;
            links.push({
              range: { start: { x: startX, y: startY }, end: { x: endX, y: endY } },
              text: matched,
              activate() { activateFilePath(matched); },
            });
          }
        }
        callback(links.length > 0 ? links : undefined);
      },
    });

    term.open(el);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // On mobile, disable ALL native touch panning on xterm elements.
    // CSS @media(pointer:coarse) sets touch-action:none !important,
    // but xterm may recreate elements — belt-and-suspenders via JS too.
    // Also prevent page-level scroll (SPA should never scroll the page).
    if (isTouch) {
      for (const sel of [".xterm-screen", ".xterm-viewport"]) {
        const node = el.querySelector(sel) as HTMLElement | null;
        if (node) node.style.setProperty("touch-action", "none", "important");
      }
    }

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

    // Register viewport text reader — returns only the currently visible lines
    registerViewportTextReader(sessionId, () => {
      const buf = term.buffer.active;
      const start = buf.viewportY;
      const end = start + term.rows;
      const lines: string[] = [];
      for (let i = start; i < end; i++) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : "");
      }
      return lines.join("\n");
    });

    // Local-only fit (adjusts xterm cols/rows to container — no IPC to backend).
    // We must NOT send resize IPC before history is restored, because resizing
    // the PTY causes the shell to re-render its prompt, which appends a duplicate
    // prompt to the backend history buffer.
    try { fitAddon.fit(); } catch (e) { console.warn("Initial fit failed", e); }

    // Skip initial focus on mobile — prevents keyboard from opening on mount
    if (!isTouch) term.focus();

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
      // Cmd+F / Ctrl+F — open terminal search
      if (e.type === "keydown" && e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        window.dispatchEvent(new CustomEvent("tron:terminalSearch", { detail: { sessionId } }));
        return false;
      }
      // Escape — close search if open
      if (e.type === "keydown" && e.key === "Escape") {
        window.dispatchEvent(new CustomEvent("tron:terminalSearchClose", { detail: { sessionId } }));
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
    // Use capture phase so we intercept images BEFORE xterm's internal paste
    // handler (which may stopPropagation, preventing bubbling to this container).
    el.addEventListener("paste", onPaste, true);

    // Prevent scroll-to-top on click/tap: when the user interacts with the
    // terminal, xterm focuses its helper textarea. The browser auto-scrolls
    // .xterm-viewport to bring the textarea into view, jumping to the top of
    // the scrollback buffer.
    const xtermViewport = el.querySelector(".xterm-viewport") as HTMLElement | null;
    const xtermTextarea = el.querySelector(".xterm-helper-textarea") as HTMLElement | null;

    // MOBILE SCROLL-TO-TOP FIX: block textarea focus entirely.
    // Tapping the terminal causes xterm to focus its hidden textarea →
    // virtual keyboard opens → viewport resizes → scroll jumps.
    // On mobile, all typing goes through SmartInput, so the textarea
    // focus is unnecessary. Also set position:fixed as extra safety
    // and prevent page-level scroll (SPA should never scroll).
    const origTextareaFocus = xtermTextarea
      ? HTMLElement.prototype.focus.bind(xtermTextarea) : null;
    const preventPageScroll = isTouch ? () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    } : null;
    if (preventPageScroll) window.addEventListener("scroll", preventPageScroll);
    // MOBILE SCROLL-TO-TOP FIX:
    // On mobile, tapping the terminal can cause scroll-to-top via multiple paths
    // (native focus, xterm internals, React re-renders from focusTarget state).
    // Fix: completely block xterm textarea focus + continuously guard scroll position.
    let mobileScrollObserver: MutationObserver | null = null;
    if (isTouch && xtermTextarea) {
      // Make textarea completely unfocusable from taps
      xtermTextarea.style.setProperty("pointer-events", "none", "important");
      xtermTextarea.style.setProperty("position", "fixed", "important");
      xtermTextarea.style.setProperty("top", "-9999px", "important");
      xtermTextarea.tabIndex = -1;

      // Smart keyboard: allow focus in normal buffer (at bottom) and alternate
      // buffer (TUI apps like vim, Claude Code need text input).
      // Block only when scrolled up in normal buffer or in selection mode.
      xtermTextarea.focus = (opts?: FocusOptions) => {
        if (selectionModeRef.current) return;
        if (!origTextareaFocus) return;
        const buf = term.buffer.active;
        if (buf.type === "normal") {
          const isAtBottom = buf.viewportY >= buf.baseY - 2;
          if (!isAtBottom) return;
        }
        origTextareaFocus(opts);
      };

      // Continuous scroll guard: use MutationObserver + scroll listener to catch
      // ANY scroll-to-top regardless of cause (focus, re-render, layout shift)
      if (xtermViewport) {
        let guardedScrollTop = xtermViewport.scrollTop;
        // Update guarded position when user intentionally scrolls (touch handler)
        const updateGuard = () => { guardedScrollTop = xtermViewport!.scrollTop; };
        const checkScroll = () => {
          if (xtermViewport && guardedScrollTop > 50 &&
              xtermViewport.scrollTop === 0) {
            // Jumped to top — revert
            xtermViewport.scrollTop = guardedScrollTop;
          } else if (xtermViewport) {
            guardedScrollTop = xtermViewport.scrollTop;
          }
        };
        xtermViewport.addEventListener("scroll", checkScroll);
        // Also observe DOM changes that might cause layout shifts
        mobileScrollObserver = new MutationObserver(checkScroll);
        mobileScrollObserver.observe(el, { childList: true, subtree: true, attributes: true });
        // Update guard when user scrolls via our touch handler
        term.onScroll(updateGuard);
      }
    }

    // DESKTOP GUARD: persistent scroll guard that catches sudden scroll-to-top
    // jumps from ANY cause — user interaction, xterm internals (alternate buffer
    // switches, TUI redraws), or focus events. Tracks last known good position
    // and reverts jumps >50px to scrollTop=0.
    let desktopGuardPos = 0;
    let desktopGuardRaf = 0;
    const desktopScrollGuard = !isTouch && xtermViewport ? () => {
      const vp = xtermViewport!;
      if (desktopGuardPos > 50 && vp.scrollTop === 0) {
        // Sudden jump to top — revert on next frame to avoid fighting xterm
        cancelAnimationFrame(desktopGuardRaf);
        const restoreTo = desktopGuardPos;
        desktopGuardRaf = requestAnimationFrame(() => { vp.scrollTop = restoreTo; });
      } else {
        desktopGuardPos = vp.scrollTop;
      }
    } : null;
    if (desktopScrollGuard) {
      xtermViewport!.addEventListener("scroll", desktopScrollGuard);
    }

    // Track whether user is scrolled up from bottom (for scroll-to-bottom button).
    // Use xterm's onScroll API instead of DOM scroll events — term.scrollLines()
    // (used by our touch handler) may not fire native scroll events on .xterm-viewport.
    let lastScrolledUp = false;
    const checkScrolledUp = () => {
      const buf = term.buffer.active;
      const isUp = buf.viewportY < buf.baseY;
      if (isUp !== lastScrolledUp) {
        lastScrolledUp = isUp;
        onScrolledUpChangeRef.current?.(isUp);
      }
    };
    const disposableOnScroll = term.onScroll(checkScrolledUp);
    // Also check on lineFeed — when new content arrives while scrolled up,
    // baseY increases but viewportY stays, keeping isUp = true.
    const disposableOnLineFeed = term.onLineFeed(checkScrolledUp);

    // Listen for scrollToBottom requests from parent (via window event)
    const handleScrollToBottom = (e: Event) => {
      if ((e as CustomEvent).detail?.sessionId === sessionId) {
        term.scrollToBottom();
      }
    };
    window.addEventListener("tron:scrollTermToBottom", handleScrollToBottom);

    // Resize Logic — syncs xterm dimensions to backend PTY.
    // During reconnect settling, ResizeObserver resizes are deferred to avoid
    // sending premature SIGWINCH while the bounce-resize is in progress.
    let reconnectSettled = !reconnecting;
    // Declared here (before performResize) so it can be checked during resize.
    // Set true while the virtual keyboard is opening/closing on mobile.
    let viewportResizing = false;
    // Track last container dimensions to skip no-op fit() calls that would
    // trigger ResizeObserver → fit() → ResizeObserver feedback loops.
    let lastContainerW = 0;
    let lastContainerH = 0;
    const performResize = () => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      if (!reconnectSettled) return; // defer until bounce completes
      if (viewportResizing) return; // skip fit() during keyboard open/close (mobile)

      // Skip if container dimensions haven't changed (prevents resize loops)
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw === lastContainerW && ch === lastContainerH && lastContainerW > 0) return;
      // Minimum height guard: if container is too small (< 80px ≈ 4 rows),
      // skip resize entirely. Prevents absurd 1-2 row terminals that cause
      // massive reflow and flicker. The PTY keeps its previous dimensions.
      const fontSize = xtermRef.current?.options.fontSize || 14;
      if (ch < fontSize * 5) return;
      lastContainerW = cw;
      lastContainerH = ch;

      try {
        // Save scroll state BEFORE fit() — fit() recalculates rows and can
        // reset the viewport scroll position, causing a visible jump.
        // Use xterm's buffer API (stable across versions) instead of DOM scraping.
        const buf = xtermRef.current.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;
        const savedViewportY = buf.viewportY;

        // Suppress desktop scroll guard during fit() — fit() may briefly set
        // scrollTop to 0 before we restore it, which would trigger the guard.
        desktopGuardPos = 0;
        fitAddonRef.current.fit();

        // Restore scroll position to prevent visible jump during resize.
        // If user was at the bottom, pin there; otherwise restore exact line.
        if (wasAtBottom) {
          xtermRef.current.scrollToBottom();
        } else {
          xtermRef.current.scrollToLine(savedViewportY);
        }
        // Re-arm guard with restored position
        if (xtermViewport) desktopGuardPos = xtermViewport.scrollTop;
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
      // Longer debounce on mobile — fit() is expensive and keyboard transitions
      // generate many resize events. 250ms prevents layout thrashing.
      resizeTimer = setTimeout(performResize, isTouch ? 250 : 100);
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

      // In web mode (WS bridge) or Electron remote sessions, register the
      // incoming data listener IMMEDIATELY to capture PTY output during the
      // async getHistory() round-trip. Over WebSocket, the latency is high
      // enough that the shell prompt arrives before getHistory resolves and
      // is lost. In local Electron mode, IPC is near-instant so we register
      // after history (original behavior — prevents duplication on reconnect).
      const isWebBridge = !isElectronApp() || isRemoteSession(sessionId);
      let earlyDataBuf: string[] | null = isWebBridge ? [] : null;

      if (isWebBridge) {
        removeIncomingListener = window.electron.ipcRenderer.on(
          IPC.TERMINAL_INCOMING_DATA,
          ({ id, data }: { id: string; data: string }) => {
            if (id === sessionId) {
              if (earlyDataBuf) {
                earlyDataBuf.push(data);
              } else {
                term.write(data);
              }
            }
          },
        );
      }

      const finishSetup = (history?: string, knownReconnect = false) => {
          if (!mounted) return;

          // Prefer saved history from loaded tabs (pendingHistory) over server
          // getHistory. In web mode, the fresh PTY outputs a shell prompt before
          // getHistory responds, making it non-empty and masking the saved content.
          let effectiveHistory = pendingHistory || ((history && history.length > 0) ? history : undefined);
          const isReconnect = knownReconnect || !!effectiveHistory;

          // On mobile, truncate history to reduce write time and layout thrashing.
          // Scrollback is limited to 1000 lines anyway, so excess data is discarded.
          if (effectiveHistory && isTouch && effectiveHistory.length > 20000) {
            effectiveHistory = effectiveHistory.slice(-20000);
          }

          if (isReconnect) {
            // Suppress outgoing onData → PTY during bounce to prevent DSR
            // response corruption from stale escape sequences.
            suppressOutgoingRef.current = true;
          }

          // Write history to xterm first (restores previous output on reload)
          if (effectiveHistory) {
            term.write(effectiveHistory);
          }

          // Web mode: flush early data that arrived during getHistory round-trip
          if (earlyDataBuf && earlyDataBuf.length > 0) {
            for (const chunk of earlyDataBuf) term.write(chunk);
          }
          earlyDataBuf = null; // switch to direct write mode

          // Electron mode: register listener after history (original behavior)
          if (!isWebBridge) {
            removeIncomingListener = window.electron.ipcRenderer.on(
              IPC.TERMINAL_INCOMING_DATA,
              ({ id, data }: { id: string; data: string }) => {
                if (id === sessionId) {
                  term.write(data);
                }
              },
            );
          }

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

    // Suppress touch-scroll AND fit()/resize while the virtual keyboard is
    // opening/closing. The viewport resize generates touch events with large
    // dy deltas that would otherwise scroll the terminal to the top of history.
    // Additionally, fit() during keyboard animation causes expensive forced
    // synchronous layout on every frame, making input feel laggy on mobile.
    //
    // Strategy: completely freeze terminal dimensions during keyboard transitions.
    // The container shrinks/grows naturally (CSS), clipping the xterm canvas.
    // After the keyboard fully settles, do ONE masked resize: briefly hide xterm
    // with opacity:0 so the reflow is invisible, then fade back in.
    let viewportResizeTimer: ReturnType<typeof setTimeout> | undefined;
    const vv = isTouch ? window.visualViewport : null;
    const onViewportResize = () => {
      viewportResizing = true;
      // Reset dimension cache so the settle resize always runs
      lastContainerW = 0;
      lastContainerH = 0;
      // Cancel any pending debounced resize — the settle timeout handles it
      clearTimeout(resizeTimer);
      clearTimeout(viewportResizeTimer);
      // Wait 800ms after the LAST viewport resize event. iOS keyboard animation
      // can take 300-500ms and fires many events; 800ms ensures it's truly done.
      viewportResizeTimer = setTimeout(() => {
        viewportResizing = false;
        // Mask the reflow: hide xterm → resize → show. This prevents the user
        // from seeing content reflow/jump when row count changes drastically.
        el.style.opacity = "0";
        // Resize in next frame so opacity:0 paints first
        requestAnimationFrame(() => {
          performResize();
          // Pin scroll to bottom so cursor stays visible
          const viewport = el.querySelector(".xterm-viewport");
          if (viewport) viewport.scrollTop = viewport.scrollHeight;
          // Reveal after one more frame (resize has painted)
          requestAnimationFrame(() => { el.style.opacity = "1"; });
        });
      }, 800);
    };
    vv?.addEventListener("resize", onViewportResize);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || viewportResizing) return;
      // In selection mode, touch is handled by the native text overlay — skip
      if (selectionModeRef.current) return;
      touchStartY = e.touches[0].clientY;
      touchAccum = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || viewportResizing || selectionModeRef.current) return;
      const touch = e.touches[0];
      const dy = touchStartY - touch.clientY;
      touchStartY = touch.clientY;
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

      // Ctrl+C in terminal only sends to PTY — agent stop is handled by SmartInput only

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
      window.removeEventListener("tron:splitDragStart", onSplitDragStart);
      window.removeEventListener("tron:splitDragEnd", onSplitDragEnd);
      unregisterScreenBufferReader(sessionId);
      unregisterSelectionReader(sessionId);
      unregisterViewportTextReader(sessionId);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      resizeObserver.disconnect();
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      vv?.removeEventListener("resize", onViewportResize);
      clearTimeout(viewportResizeTimer);
      if (preventPageScroll) window.removeEventListener("scroll", preventPageScroll);
      if (desktopScrollGuard) {
        xtermViewport?.removeEventListener("scroll", desktopScrollGuard);
        cancelAnimationFrame(desktopGuardRaf);
      }
      // Restore original textarea focus + clean up mobile listeners
      if (xtermTextarea && origTextareaFocus) {
        xtermTextarea.focus = origTextareaFocus;
      }
      if (mobileScrollObserver) mobileScrollObserver.disconnect();
      disposableOnScroll.dispose();
      disposableOnLineFeed.dispose();
      window.removeEventListener("tron:scrollTermToBottom", handleScrollToBottom);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("paste", onPaste, true);
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

  // ---- Terminal search open/close listeners ----
  useEffect(() => {
    const openHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === sessionId) {
        setSearchVisible(true);
        // Pre-fill with xterm selection if any
        const sel = xtermRef.current?.getSelection();
        if (sel) setSearchQuery(sel);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };
    const closeHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === sessionId) {
        setSearchVisible(false);
        searchAddonRef.current?.clearDecorations();

        xtermRef.current?.focus();
      }
    };
    window.addEventListener("tron:terminalSearch", openHandler);
    window.addEventListener("tron:terminalSearchClose", closeHandler);
    return () => {
      window.removeEventListener("tron:terminalSearch", openHandler);
      window.removeEventListener("tron:terminalSearchClose", closeHandler);
    };
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

  // Search handlers
  const doSearch = useCallback((query: string, direction: "next" | "prev" = "next") => {
    if (!searchAddonRef.current || !query) {
      searchAddonRef.current?.clearDecorations();
      return;
    }
    const opts = { regex: false, caseSensitive: false, incremental: direction === "next", decorations: { matchOverviewRuler: "#888", activeMatchColorOverviewRuler: "#ffcc00", matchBackground: "#ffffff30", activeMatchBackground: "#ffcc0060" } };
    if (direction === "prev") {
      searchAddonRef.current.findPrevious(query, opts);
    } else {
      searchAddonRef.current.findNext(query, opts);
    }
  }, []);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    searchAddonRef.current?.clearDecorations();
    xtermRef.current?.focus();
  }, []);

  return (
    <div
      className={`relative overflow-hidden ${className || ""}`}
      style={{
        contain: "strict",
        // Match terminal theme background so canvas clear during fit() resize
        // is invisible — no overlay/mask needed. The container background fills
        // the gap between canvas clear and redraw.
        backgroundColor: theme?.background,
      }}
    >
      <div
        ref={terminalRef}
        className={`absolute inset-0${loading ? " transition-opacity duration-300 ease-in" : ""}`}
        style={{ opacity: loading ? 0 : 1 }}
      />
      {/* Terminal search bar */}
      {searchVisible && (
        <div
          className="absolute top-1 right-2 z-20 flex items-center gap-1 rounded-lg px-2 py-1 shadow-lg border"
          style={{
            backgroundColor: theme?.background || "#0a0a0a",
            borderColor: "rgba(255,255,255,0.15)",
          }}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              doSearch(e.target.value, "next");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doSearch(searchQuery, e.shiftKey ? "prev" : "next");
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Find…"
            className="bg-transparent text-xs outline-none w-36 font-mono"
            style={{ color: theme?.foreground || "#e5e7eb" }}
            spellCheck={false}
            autoFocus
          />
          <button
            onClick={() => doSearch(searchQuery, "prev")}
            className="p-0.5 rounded hover:bg-white/10 text-xs"
            style={{ color: theme?.foreground || "#e5e7eb" }}
            title="Previous (Shift+Enter)"
          >
            ▲
          </button>
          <button
            onClick={() => doSearch(searchQuery, "next")}
            className="p-0.5 rounded hover:bg-white/10 text-xs"
            style={{ color: theme?.foreground || "#e5e7eb" }}
            title="Next (Enter)"
          >
            ▼
          </button>
          <button
            onClick={closeSearch}
            className="p-0.5 rounded hover:bg-white/10 text-xs ml-0.5"
            style={{ color: theme?.foreground || "#e5e7eb" }}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      )}
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
