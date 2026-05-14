import { useEffect, useRef, useContext, useState, useCallback } from "react";
import { AgentContext } from "../../contexts/AgentContext";
import { useLayout } from "../../contexts/LayoutContext";
import { IPC } from "../../constants/ipc";
import type { AgentStep, Tab, LayoutNode } from "../../types";
import { detectExternalAgentSignal } from "../../utils/externalAgentStatus";
import {
  readScreenBuffer,
  isAlternateBuffer,
} from "../../services/terminalBuffer";

/** Agent status for a single terminal session */
export interface AgentStatus {
  sessionId: string;
  label: string;
  active: boolean;
  tool: string | null;
  permission: boolean;
  /** External agent only — tokens used so far this turn (parsed from spinner) */
  tokens?: number;
  /** External agent only — elapsed seconds for the current turn */
  elapsedSeconds?: number;
}

// ── Tool detection ──────────────────────────────────────────────────────────
//
// External-agent (Claude Code, Aider, etc.) signal extraction lives in
// src/utils/externalAgentStatus.ts (unit-tested). This file only orchestrates
// timing and per-session state. The legacy regex tables below are retained
// behind unused-export markers for diff readability — they aren't called any
// more but document the historical signals. Safe to delete in a follow-up.


// ── Tron agent activity derivation ──────────────────────────────────────────

function deriveActivity(
  isAgentRunning: boolean,
  isThinking: boolean,
  pendingCommand: string | null,
  steps: AgentStep[],
): { active: boolean; tool: string | null; permission: boolean } {
  if (pendingCommand !== null) return { active: true, tool: null, permission: true };
  if (!isAgentRunning) return { active: false, tool: null, permission: false };
  // isThinking takes priority — model is actively generating thinking tokens
  if (isThinking) return { active: true, tool: "thinking", permission: false };
  for (let i = steps.length - 1; i >= 0; i--) {
    const { step, payload } = steps[i];
    const tool: string | null = payload?.tool || null;
    switch (step) {
      case "executing":
      case "executed":
        return { active: true, tool, permission: false };
      case "read_terminal":
        return { active: true, tool: "read_terminal", permission: false };
      case "streaming_thinking":
      case "thinking":
        return { active: true, tool: "thinking", permission: false };
      case "streaming":
      case "streaming_response":
        // Agent is generating response text (after thinking, before tool call parsed)
        return { active: true, tool: "thinking", permission: false };
      case "thought":
      case "thinking_complete":
      case "plan":
        return { active: true, tool: null, permission: false };
      case "done":
      case "error":
      case "failed":
      case "stopped":
        // Agent finished — treat as inactive even if isAgentRunning hasn't toggled yet
        return { active: false, tool: null, permission: false };
      default:
        continue;
    }
  }
  return { active: true, tool: null, permission: false };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Find the tab title that contains a given sessionId */
function findTabTitle(tabs: Tab[], sessionId: string): string | null {
  const containsSession = (node: LayoutNode): boolean => {
    if (node.type === "leaf") return node.sessionId === sessionId;
    return node.children.some(containsSession);
  };
  for (const tab of tabs) {
    if (containsSession(tab.root)) return tab.title;
  }
  return null;
}

// ── Main hook ───────────────────────────────────────────────────────────────

/** Display the last-seen tool for this long after it was detected. Short, so
 *  the status reflects what's happening *now* rather than a stale label. */
const TOOL_STICKY_MS = 600;
/** Spinner not seen for this long → external agent treated as idle. The
 *  spinner repaints every ~100ms while Claude Code is working, so 1.5s is
 *  generous against transient WS lag without feeling stuck-on. */
const SPINNER_IDLE_GAP_MS = 1500;
/** Permission prompts are rendered UI, not transcript history. Only inspect
 *  the live tail of the terminal frame so an approved prompt doesn't stay
 *  latched from scrollback / lookback text. */
const PERMISSION_FRAME_LINES = 24;

function tailLines(text: string, lines: number): string {
  if (!text) return "";
  const parts = text.split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join("\n");
}

export function useAgentStatuses(): AgentStatus[] {
  const store = useContext(AgentContext);
  const { sessions, tabs } = useLayout();
  const [statuses, setStatuses] = useState<AgentStatus[]>([]);
  const [externalSignalVersion, setExternalSignalVersion] = useState(0);

  const terminalDetectedTool = useRef(new Map<string, string | null>());
  const terminalToolTimestamp = useRef(new Map<string, number>());
  const terminalPermission = useRef(new Map<string, boolean>());
  const terminalDataSeen = useRef(new Map<string, number>());
  /** Last time we saw the spinner / tool line — primary "working" signal. */
  const terminalSpinnerSeen = useRef(new Map<string, number>());
  /** Tokens/elapsed parsed from the spinner suffix, for display. */
  const terminalTokens = useRef(new Map<string, number>());
  const terminalElapsed = useRef(new Map<string, number>());
  /** Per-session ring of recent stripped data, for cross-chunk pattern match. */
  const lookbackRing = useRef(new Map<string, string>());

  // Track which sessions have an actively running agent (via tron:agent-activity events)
  const agentRunning = useRef(new Set<string>());

  // Track which sessions have EVER had agent activity (persists until session removed)
  const everHadAgent = useRef(new Set<string>());

  // Per-session: timestamp when detection should start (skips history replay & post-stop data)
  const sessionDetectAfter = useRef(new Map<string, number>());

  /** Grace period for history replay on page refresh / reconnect. Kept small
   *  so Claude Code's startup banner (which paints within ~200ms of `claude`
   *  being run on a fresh shell) isn't filtered out. Replay on a reconnect
   *  arrives in a single big chunk and 600ms is plenty to skip it. */
  const HISTORY_GRACE_MS = 600;
  /** Cooldown after Tron agent stops — ignore trailing terminal data */
  const STOP_COOLDOWN_MS = 2000;
  /** Lookback ring size — must be large enough to keep a full startup banner
   *  in scope for several chunks. Claude Code's welcome + logo + cwd + model
   *  line runs ~1.5KB, so 4KB gives comfortable headroom. */
  const LOOKBACK_RING_MAX = 4096;

  const updatePermissionState = useCallback((id: string, next: boolean) => {
    const prev = terminalPermission.current.get(id) ?? false;
    if (next) {
      terminalPermission.current.set(id, true);
      everHadAgent.current.add(id);
    } else {
      terminalPermission.current.delete(id);
    }
    if (prev !== next) {
      setExternalSignalVersion((v) => (v + 1) % 1_000_000);
    }
  }, []);

  // Listen for terminal incoming data — detect tools AND track activity for external agents
  useEffect(() => {
    if (!window.electron?.ipcRenderer?.on) return;
    return window.electron.ipcRenderer.on(
      IPC.TERMINAL_INCOMING_DATA,
      ({ id, data }: { id: string; data: string }) => {
        const now = Date.now();

        // On first data from a session, set a grace period to skip history replay
        if (!sessionDetectAfter.current.has(id)) {
          sessionDetectAfter.current.set(id, now + HISTORY_GRACE_MS);
        }
        const detectAfter = sessionDetectAfter.current.get(id)!;
        if (now < detectAfter) return;
        terminalDataSeen.current.set(id, now);

        // Maintain a small lookback ring per session so a spinner repaint
        // split across two chunks still matches.
        const prev = lookbackRing.current.get(id) ?? "";
        const combined = prev + data;
        const ring =
          combined.length > LOOKBACK_RING_MAX
            ? combined.slice(combined.length - LOOKBACK_RING_MAX)
            : combined;
        lookbackRing.current.set(id, ring);

        // Also pull the currently rendered screen from xterm — a Ink-based
        // CLI like Claude Code repaints to the alternate buffer using
        // cursor positioning, so the *raw* PTY chunks may contain only
        // escape codes while the *visible* screen reads cleanly. Grabbing
        // both the chunk lookback (for tool-call lines that scroll past)
        // and the rendered buffer (for static welcome banners and idle
        // frames) gives us coverage across all states.
        const rendered = readScreenBuffer(id, 60) || "";
        const liveFrame = [data, tailLines(rendered, PERMISSION_FRAME_LINES)]
          .filter(Boolean)
          .join("\n");
        const inAlt = isAlternateBuffer(id);
        const sig = detectExternalAgentSignal(ring + "\n" + rendered);
        const liveSig = detectExternalAgentSignal(liveFrame, {
          allowTersePermission: everHadAgent.current.has(id),
        });

        // Permission is a live UI state. Never derive it from the lookback
        // ring, because that ring intentionally keeps old transcript lines
        // around for tool detection and would otherwise latch onto approved
        // prompts.
        if (liveSig.permission) {
          updatePermissionState(id, true);
        } else if (
          terminalPermission.current.get(id) &&
          (liveFrame.trim() || liveSig.working || liveSig.idle || liveSig.agentPresent)
        ) {
          updatePermissionState(id, false);
        }

        // Bonus: any agent CLI runs in the alternate screen buffer (vim,
        // htop, claude, aider, codex…). Combined with ANY positive signal
        // from detector, alt-buffer is strong corroboration.
        if (inAlt && (sig.agentPresent || sig.tool || sig.working || sig.idle)) {
          everHadAgent.current.add(id);
        }

        // Any presence signal (banner, idle frame, working spinner, tool line)
        // marks this session as "an agent CLI is here" so it shows up in the
        // status bar even when not actively working.
        if (sig.agentPresent) {
          everHadAgent.current.add(id);
        }

        // Idle frame seen → Claude is showing its input prompt; mark idle
        // immediately so the dot turns gray on the same frame.
        if (sig.idle) {
          terminalSpinnerSeen.current.delete(id);
          terminalDetectedTool.current.delete(id);
          terminalTokens.current.delete(id);
          terminalElapsed.current.delete(id);
          updatePermissionState(id, false);
        }

        if (sig.working) {
          everHadAgent.current.add(id);
          terminalSpinnerSeen.current.set(id, now);
          if (sig.tokens != null) terminalTokens.current.set(id, sig.tokens);
          if (sig.elapsedSeconds != null)
            terminalElapsed.current.set(id, sig.elapsedSeconds);
          // Spinner alone implies "thinking" — but a more specific tool from
          // the same chunk wins, since tool matches are more informative.
        }

        if (sig.tool) {
          everHadAgent.current.add(id);
          // Only refresh "spinner seen" if we actually saw the spinner; a
          // bare ⏺ Read line is informational, not a heartbeat.
          if (sig.tool === "thinking") {
            // Spinner-derived "thinking" only sticks if no specific tool is
            // currently displayed (or if the previous tool sticky has expired).
            const lastTs = terminalToolTimestamp.current.get(id) ?? 0;
            if (
              now - lastTs > TOOL_STICKY_MS ||
              !terminalDetectedTool.current.get(id)
            ) {
              terminalDetectedTool.current.set(id, sig.tool);
            }
          } else {
            terminalDetectedTool.current.set(id, sig.tool);
            terminalToolTimestamp.current.set(id, now);
          }
        }
      },
    );
  }, [updatePermissionState]);

  // Listen for Tron agent activity events — authoritative source for running state
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId, running } = (e as CustomEvent).detail;
      if (running) {
        agentRunning.current.add(sessionId);
      } else {
        agentRunning.current.delete(sessionId);
        terminalDetectedTool.current.delete(sessionId);
        terminalToolTimestamp.current.delete(sessionId);
        terminalPermission.current.delete(sessionId);
        terminalDataSeen.current.delete(sessionId);
        terminalSpinnerSeen.current.delete(sessionId);
        terminalTokens.current.delete(sessionId);
        terminalElapsed.current.delete(sessionId);
        lookbackRing.current.delete(sessionId);
        sessionDetectAfter.current.set(sessionId, Date.now() + STOP_COOLDOWN_MS);
      }
    };
    window.addEventListener("tron:agent-activity", handler);
    return () => window.removeEventListener("tron:agent-activity", handler);
  }, []);

  // Reconcile on 500ms interval
  const reconcile = useCallback(() => {
    const allStates = store ? store.getSnapshot() : new Map();
    const now = Date.now();

    const result: AgentStatus[] = [];
    for (const [id] of sessions) {
      if (id === "settings" || id.startsWith("ssh-connect") || id.startsWith("browser-") || id.startsWith("editor-") || id.startsWith("pixel-agents")) continue;

      // Periodic screen-buffer scan. The chunk-based detector only fires
      // when the PTY is actively emitting bytes — but an idle Claude Code
      // session at the input prompt may go many seconds with no chunks at
      // all, and a session that was already running BEFORE the user opened
      // this Tron window has no chunk history.
      //
      // Perf: when bytes are flowing, the per-chunk handler already does the
      // heavier lookback scan. We still read a short live tail every interval
      // for permission prompts, because approval dialogs can appear/disappear
      // via cursor repaint without a clean transcript line.
      const lastChunkAt = terminalDataSeen.current.get(id) ?? 0;
      const recentChunks = now - lastChunkAt < 1000;
      const skipDeepPoll = agentRunning.current.has(id) || recentChunks;
      const screenScan = agentRunning.current.has(id)
        ? null
        : readScreenBuffer(id, skipDeepPoll ? PERMISSION_FRAME_LINES : 40);
      if (screenScan) {
        const inAlt = isAlternateBuffer(id);
        const sig2 = detectExternalAgentSignal(screenScan, {
          allowTersePermission: everHadAgent.current.has(id),
        });

        if (sig2.permission) {
          updatePermissionState(id, true);
        } else if (terminalPermission.current.get(id)) {
          updatePermissionState(id, false);
        }

        if (!skipDeepPoll) {
          if (sig2.agentPresent || (inAlt && (sig2.tool || sig2.working || sig2.idle))) {
            everHadAgent.current.add(id);
          }
          // Refresh spinner-seen timestamp if the spinner is currently visible
          // on screen — keeps the "active" dot lit even when Tron isn't
          // receiving new chunks (e.g. terminal hasn't focused recently).
          if (sig2.working) {
            terminalSpinnerSeen.current.set(id, now);
            if (sig2.tokens != null) terminalTokens.current.set(id, sig2.tokens);
            if (sig2.elapsedSeconds != null) terminalElapsed.current.set(id, sig2.elapsedSeconds);
            if (!terminalDetectedTool.current.get(id)) {
              terminalDetectedTool.current.set(id, sig2.tool || "thinking");
            }
          }
          if (sig2.idle) {
            // Only clear if the LAST signal was idle (not racing with a
            // mid-frame paint that happens to lack the spinner). The
            // chunk-based path already handles this on data arrival.
            terminalDetectedTool.current.delete(id);
            updatePermissionState(id, false);
          }
        }
      }

      // Use tab title as label (#4), fall back to session title
      const tabTitle = findTabTitle(tabs, id);
      const label = tabTitle || sessions.get(id)?.title || "Terminal";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentState = allStates.get(id) as any;

      // Mark sessions that have any agent state (running or past thread) as "ever had agent"
      if (agentState?.isAgentRunning || agentState?.pendingCommand != null || agentState?.agentThread?.length > 0) {
        everHadAgent.current.add(id);
      }

      // Tron's built-in agent (authoritative — uses AgentStore state)
      if (agentState?.isAgentRunning || agentState?.pendingCommand != null) {
        const { isAgentRunning, isThinking, pendingCommand, agentThread } = agentState;
        const act = deriveActivity(isAgentRunning, isThinking, pendingCommand, agentThread);
        // Overlay tool from terminal detection if Tron agent has no specific tool
        if (act.active && !act.tool) {
          act.tool = terminalDetectedTool.current.get(id) ?? null;
        }
        result.push({ sessionId: id, label, ...act });
        continue;
      }

      // Safety net: AgentStore says not-running, clear stale ref state.
      if (agentRunning.current.has(id) && !agentState?.isAgentRunning) {
        agentRunning.current.delete(id);
        terminalDetectedTool.current.delete(id);
        terminalToolTimestamp.current.delete(id);
        terminalPermission.current.delete(id);
        terminalDataSeen.current.delete(id);
        terminalSpinnerSeen.current.delete(id);
        terminalTokens.current.delete(id);
        terminalElapsed.current.delete(id);
        lookbackRing.current.delete(id);
      }

      // External agent (Claude Code CLI etc.) is "active" if its spinner
      // was seen within SPINNER_IDLE_GAP_MS. The spinner repaints every
      // ~100ms while working, so a 1.5s gap is the canonical idle signal.
      const spinnerSeen = terminalSpinnerSeen.current.get(id);
      const spinnerActive =
        spinnerSeen != null && now - spinnerSeen < SPINNER_IDLE_GAP_MS;
      const permissionActive = terminalPermission.current.get(id) ?? false;
      const isExternalActive =
        agentRunning.current.has(id) || spinnerActive || permissionActive;

      if (isExternalActive) {
        everHadAgent.current.add(id);
        // Drop the displayed tool if its sticky window has expired and the
        // spinner has moved on (avoids "Read" sticking after Claude is now
        // thinking).
        let tool = terminalDetectedTool.current.get(id) ?? null;
        const toolTs = terminalToolTimestamp.current.get(id) ?? 0;
        if (tool && tool !== "thinking" && now - toolTs > TOOL_STICKY_MS) {
          tool = "thinking";
          terminalDetectedTool.current.set(id, "thinking");
        }
        result.push({
          sessionId: id,
          label,
          active: true,
          tool,
          permission: permissionActive,
          tokens: terminalTokens.current.get(id),
          elapsedSeconds: terminalElapsed.current.get(id),
        });
        continue;
      }

      // Clean up stale external agent state when the spinner gap is exceeded.
      if (spinnerSeen != null && now - spinnerSeen >= SPINNER_IDLE_GAP_MS) {
        terminalSpinnerSeen.current.delete(id);
        terminalDetectedTool.current.delete(id);
        terminalToolTimestamp.current.delete(id);
        terminalTokens.current.delete(id);
        terminalElapsed.current.delete(id);
      }

      // Only show sessions that have had agent activity at some point
      if (everHadAgent.current.has(id)) {
        result.push({ sessionId: id, label, active: false, tool: null, permission: false });
      }
    }

    setStatuses(prev => {
      // Only update if something actually changed to avoid re-renders.
      // Token/elapsed are intentionally compared too — when they change the
      // user sees real-time progress; the diff is the only re-render signal.
      if (prev.length !== result.length) return result;
      for (let i = 0; i < result.length; i++) {
        const a = prev[i], b = result[i];
        if (
          a.sessionId !== b.sessionId ||
          a.active !== b.active ||
          a.tool !== b.tool ||
          a.permission !== b.permission ||
          a.label !== b.label ||
          a.tokens !== b.tokens ||
          a.elapsedSeconds !== b.elapsedSeconds
        ) {
          return result;
        }
      }
      return prev;
    });
  }, [sessions, tabs, store, updatePermissionState]);

  useEffect(() => {
    const timeout = window.setTimeout(reconcile, 0);
    const interval = setInterval(reconcile, 500);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [reconcile, externalSignalVersion]);

  return statuses;
}
