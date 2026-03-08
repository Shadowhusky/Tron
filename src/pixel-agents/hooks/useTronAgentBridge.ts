import { useEffect, useRef, useContext, useState, useCallback } from "react";
import { AgentContext } from "../../contexts/AgentContext";
import { useLayout } from "../../contexts/LayoutContext";
import { IPC } from "../../constants/ipc";
import type { AgentStep } from "../../types";
import { OfficeState } from "../engine/officeState";
import { createDefaultLayout } from "../layout/layoutSerializer";

/** Map the latest agent thread step to character activity */
function deriveActivity(
  isAgentRunning: boolean,
  isThinking: boolean,
  pendingCommand: string | null,
  steps: AgentStep[],
): {
  isActive: boolean;
  tool: string | null;
  bubbleType: "permission" | "waiting" | null;
} {
  if (pendingCommand !== null) {
    return { isActive: true, tool: null, bubbleType: "permission" };
  }
  if (!isAgentRunning) {
    return { isActive: false, tool: null, bubbleType: null };
  }
  // Check thread steps for the most recent actionable step
  for (let i = steps.length - 1; i >= 0; i--) {
    const { step, payload } = steps[i];
    const tool: string | null = payload?.tool || null;
    switch (step) {
      case "executing":
      case "executed":
        return { isActive: true, tool, bubbleType: null };
      case "read_terminal":
        return { isActive: true, tool: "read_terminal", bubbleType: null };
      case "streaming":
      case "streaming_response":
        return { isActive: true, tool: null, bubbleType: null };
      case "thinking":
      case "streaming_thinking":
      case "thought":
      case "thinking_complete":
        return { isActive: true, tool: isThinking ? "thinking" : null, bubbleType: null };
      case "done":
      case "error":
      case "failed":
        return { isActive: true, tool: null, bubbleType: null };
      case "plan":
        return { isActive: true, tool: null, bubbleType: "waiting" };
      default:
        continue;
    }
  }
  // No actionable step — fall back to thinking state
  if (isThinking) {
    return { isActive: true, tool: "thinking", bubbleType: null };
  }
  return { isActive: true, tool: null, bubbleType: null };
}

/** Cooldown (ms) after last terminal data before marking session inactive */
const TERMINAL_IDLE_MS = 3000;

/** ANSI escape code stripper — handles CSI, OSC, charset, mode, and doubled escapes */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[a-zA-Z]|\x1B\].*?(?:\x07|\x1B\\)|\x1B[()][0-2]|\x1B[>=<]|\x1B\x1B|\x0F|\x0E/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ""); }

/**
 * Detect tool usage from Claude Code CLI terminal output.
 *
 * Claude Code CLI renders tool calls as:
 *   ⏺ Read(src/foo.ts)           — ⏺ (U+23FA) prefix + PascalCase tool name + parens
 *   ⏺ Bash(echo hello)
 *   ⏺ WebSearch("query")
 * Results appear as:
 *   ⎿  (output)                   — ⎿ (U+23BF) prefix
 * Thinking indicator:
 *   ✻ Pondering…                  — spinner char (· ✢ ✳ ✶ ✻ ✽) + random verb + …
 *   (184 possible verbs: Pondering, Cogitating, Noodling, Thinking, Brewing, etc.)
 *
 * Terminal data arrives in small chunks, so we keep a small lookback buffer
 * per session to catch tool headers split across chunk boundaries.
 */

// ── Claude Code CLI tool call prefix: ⏺ (U+23FA) ──
// Also accept similar-looking chars in case of font/rendering variations
const CC_PREFIX = `[⏺⏵►▶●]`;

// Tool patterns: ⏺ + ToolName + ( — high specificity, no false positives
const TOOL_CALL_RE: [RegExp, string][] = [
  [new RegExp(`${CC_PREFIX}\\s*Read\\b`), "read_file"],
  [new RegExp(`${CC_PREFIX}\\s*Glob\\b`), "list_dir"],
  [new RegExp(`${CC_PREFIX}\\s*Grep\\b`), "search_dir"],
  [new RegExp(`${CC_PREFIX}\\s*WebSearch\\b`), "web_search"],
  [new RegExp(`${CC_PREFIX}\\s*WebFetch\\b`), "web_search"],
  [new RegExp(`${CC_PREFIX}\\s*Agent\\b`), "agent"],
  [new RegExp(`${CC_PREFIX}\\s*Explore\\b`), "search_dir"],
  [new RegExp(`${CC_PREFIX}\\s*Write\\b`), "write_file"],
  [new RegExp(`${CC_PREFIX}\\s*Edit\\b`), "edit_file"],
  [new RegExp(`${CC_PREFIX}\\s*Bash\\b`), "execute_command"],
  [new RegExp(`${CC_PREFIX}\\s*Plan\\b`), "thinking"],
  [new RegExp(`${CC_PREFIX}\\s*Skill\\b`), "execute_command"],
  [new RegExp(`${CC_PREFIX}\\s*NotebookEdit\\b`), "edit_file"],
  [new RegExp(`${CC_PREFIX}\\s*TaskCreate\\b`), "write_file"],
  [new RegExp(`${CC_PREFIX}\\s*TaskUpdate\\b`), "edit_file"],
  [new RegExp(`${CC_PREFIX}\\s*TaskList\\b`), "list_dir"],
  [new RegExp(`${CC_PREFIX}\\s*TaskGet\\b`), "read_file"],
  [new RegExp(`${CC_PREFIX}\\s*AskUser`), "ask_question"],
  // Also match "Web Search" with space (seen in some versions)
  [new RegExp(`${CC_PREFIX}\\s*Web\\s+Search\\b`), "web_search"],
  [new RegExp(`${CC_PREFIX}\\s*Web\\s+Fetch\\b`), "web_search"],
];

// Additional patterns without prefix (JSON, Tron agent, etc.)
const EXTRA_TOOL_RE: [RegExp, string][] = [
  // JSON tool call patterns
  [/"tool":\s*"(Read|read_file)"/, "read_file"],
  [/"tool":\s*"(Write|write_file)"/, "write_file"],
  [/"tool":\s*"(Edit|edit_file)"/, "edit_file"],
  [/"tool":\s*"(Bash|execute_command|run_in_terminal)"/, "execute_command"],
  [/"tool":\s*"(Glob|list_dir)"/, "list_dir"],
  [/"tool":\s*"(Grep|search_dir)"/, "search_dir"],
  [/"tool":\s*"(WebSearch|WebFetch|web_search)"/, "web_search"],
  [/"tool":\s*"(Agent|Explore)"/, "agent"],
  // Tron's built-in agent tool patterns
  [/\bexecuting.*?execute_command\b/i, "execute_command"],
  [/\bexecuting.*?read_file\b/i, "read_file"],
  [/\bexecuting.*?write_file\b/i, "write_file"],
  [/\bexecuting.*?edit_file\b/i, "edit_file"],
  [/\bexecuting.*?search_dir\b/i, "search_dir"],
  [/\bexecuting.*?list_dir\b/i, "list_dir"],
  [/\bexecuting.*?web_search\b/i, "web_search"],
  [/\bexecuting.*?ask_question\b/i, "ask_question"],
];

/**
 * Claude Code thinking indicator: spinner char + random verb + ellipsis.
 * Spinner chars: · ✢ ✳ ✶ ✻ ✽
 * Verbs: ~184 words like Pondering, Cogitating, Noodling, Brewing, Thinking, etc.
 * Match: any of those spinner chars followed by a capitalized word and … or ...
 */
const THINKING_RE = /[·✢✳✶✻✽]\s+[A-Z][a-z]+[….]/;

/** Per-session lookback for cross-chunk tool header detection */
const sessionLookback = new Map<string, string>();
const LOOKBACK_MAX = 150;

/**
 * Detect tool from the current data chunk + small lookback.
 * Checks ⏺-prefixed tool patterns first (high priority), then thinking (low priority).
 * Returns null if nothing matches.
 */
function detectToolFromChunk(sessionId: string, rawData: string): string | null {
  const stripped = stripAnsi(rawData);
  const prev = sessionLookback.get(sessionId) || "";
  const text = prev + stripped;

  // Update lookback (keep tail only)
  sessionLookback.set(sessionId, text.length > LOOKBACK_MAX
    ? text.slice(text.length - LOOKBACK_MAX) : text);

  // 1. ⏺-prefixed tool calls (checked against lookback + chunk for cross-chunk splits)
  for (const [re, tool] of TOOL_CALL_RE) {
    if (re.test(text)) return tool;
  }

  // 2. Extra patterns (JSON, Tron agent — current chunk only)
  for (const [re, tool] of EXTRA_TOOL_RE) {
    if (re.test(stripped)) return tool;
  }

  // 3. Low priority: Claude Code thinking indicator (spinner char + verb)
  if (THINKING_RE.test(stripped)) return "thinking";

  return null;
}


export interface BridgeDebugInfo {
  storeExists: boolean;
  version: number;
  layoutSessionCount: number;
  storeId: string;
  terminalActive: string[];
  trackedSessions: { sessionId: string; charId: number; agentActive: boolean; termActive: boolean; tool: string | null; charState: number; isActive: boolean }[];
}

export function useTronAgentBridge(officeState: OfficeState): BridgeDebugInfo {
  const store = useContext(AgentContext);
  const { sessions, tabs } = useLayout();
  const sessionToCharId = useRef(new Map<string, number>());
  const nextCharId = useRef(1);

  // Track terminal activity via IPC data events
  const terminalLastActive = useRef(new Map<string, number>());
  const terminalDetectedTool = useRef(new Map<string, string | null>());
  /** Timestamp of last specific (non-thinking) tool detection per session */
  const terminalToolTimestamp = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);

  /** How long a specific tool detection stays "sticky" before "thinking" can override */
  const TOOL_STICKY_MS = 2000;

  // Ref to track if data changed since last reconciliation (avoids React batching issues)
  const dataChangedRef = useRef(false);

  // Listen for terminal incoming data — marks sessions as active + detects tools
  useEffect(() => {
    if (!window.electron?.ipcRenderer?.on) return;
    const cleanup = window.electron.ipcRenderer.on(
      IPC.TERMINAL_INCOMING_DATA,
      ({ id, data }: { id: string; data: string }) => {
        terminalLastActive.current.set(id, Date.now());
        const tool = detectToolFromChunk(id, data);
        if (tool) {
          if (tool === "thinking") {
            const lastSpecificTs = terminalToolTimestamp.current.get(id) ?? 0;
            if (Date.now() - lastSpecificTs > TOOL_STICKY_MS) {
              terminalDetectedTool.current.set(id, tool);
            }
          } else {
            terminalDetectedTool.current.set(id, tool);
            terminalToolTimestamp.current.set(id, Date.now());
          }
        } else if (terminalDetectedTool.current.get(id) === "thinking") {
          // Active output with no tool match — model is working, not thinking
          terminalDetectedTool.current.set(id, null);
        }
        dataChangedRef.current = true;
      },
    );
    return cleanup;
  }, []);

  // Listen for direct agent activity events from useAgentRunner
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId, running } = (e as CustomEvent).detail;
      if (running) {
        terminalLastActive.current.set(sessionId, Date.now());
      }
      dataChangedRef.current = true;
    };
    window.addEventListener("tron:agent-activity", handler);
    return () => window.removeEventListener("tron:agent-activity", handler);
  }, []);

  // Initialize layout on mount
  useEffect(() => {
    if (!officeState.layout) {
      officeState.rebuildFromLayout(createDefaultLayout());
    }
  }, [officeState]);

  // Reconcile sessions → characters on a 500ms interval.
  // This avoids React state batching issues — terminal data events update refs
  // directly, and the interval picks up changes reliably.
  const reconcile = useCallback(() => {
    if (!officeState.layout) {
      officeState.rebuildFromLayout(createDefaultLayout());
    }
    const map = sessionToCharId.current;
    const allStates = store ? store.getSnapshot() : new Map();
    const now = Date.now();

    // Get all terminal session IDs (exclude pseudo-sessions)
    const activeSessionIds = new Set<string>();
    for (const [id] of sessions) {
      if (id === "settings" || id.startsWith("ssh-connect") || id.startsWith("browser-") || id.startsWith("editor-") || id.startsWith("pixel-agents")) continue;
      activeSessionIds.add(id);
    }

    // Build a label for each session from its tab title
    // Walk each tab's layout tree to map leaf sessionIds to the tab's title
    const sessionToTabTitle = new Map<string, string>();
    const collectLeaves = (node: any, title: string) => {
      if (node.type === "leaf") {
        sessionToTabTitle.set(node.sessionId, title);
      } else if (node.children) {
        for (const child of node.children) collectLeaves(child, title);
      }
    };
    for (const tab of tabs) {
      collectLeaves(tab.root, tab.title || "Terminal");
    }

    const sessionTitles = new Map<string, string>();
    const titleCounts = new Map<string, number>();
    for (const sessionId of activeSessionIds) {
      const baseTitle = sessionToTabTitle.get(sessionId) || sessions.get(sessionId)?.title || "Terminal";
      titleCounts.set(baseTitle, (titleCounts.get(baseTitle) || 0) + 1);
    }
    const titleIndex = new Map<string, number>();
    for (const sessionId of activeSessionIds) {
      const baseTitle = sessionToTabTitle.get(sessionId) || sessions.get(sessionId)?.title || "Terminal";
      if ((titleCounts.get(baseTitle) || 0) > 1) {
        const idx = (titleIndex.get(baseTitle) || 0) + 1;
        titleIndex.set(baseTitle, idx);
        sessionTitles.set(sessionId, `${baseTitle} ${idx}`);
      } else {
        sessionTitles.set(sessionId, baseTitle);
      }
    }

    // Add new sessions as characters
    for (const sessionId of activeSessionIds) {
      if (!map.has(sessionId)) {
        const charId = nextCharId.current++;
        map.set(sessionId, charId);
        const label = sessionTitles.get(sessionId) || `Session ${charId}`;
        officeState.addAgent(charId, label);
      }
    }

    // Remove departed sessions
    for (const [sessionId, charId] of map) {
      if (!activeSessionIds.has(sessionId)) {
        officeState.removeAgent(charId);
        map.delete(sessionId);
        terminalToolTimestamp.current.delete(sessionId);
        sessionLookback.delete(sessionId);
      }
    }

    // Update activity based on terminal data + agent state
    for (const [sessionId, charId] of map) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentState = allStates.get(sessionId) as any;
      const lastActive = terminalLastActive.current.get(sessionId);
      const isTerminalActive = lastActive != null && (now - lastActive) < TERMINAL_IDLE_MS;

      // Update label (uses disambiguated title)
      const ch = officeState.characters.get(charId);
      if (ch) {
        ch.label = sessionTitles.get(sessionId) || `Session ${charId}`;
      }

      // Terminal data activity takes priority (covers external tools like Claude CLI)
      if (isTerminalActive && !agentState?.isAgentRunning) {
        const detectedTool = terminalDetectedTool.current.get(sessionId) ?? null;
        officeState.setAgentActive(charId, true, detectedTool);
        officeState.setBubble(charId, null);
        continue;
      }

      // Then check AgentStore for Tron's built-in agent
      if (agentState) {
        const { isAgentRunning, isThinking, pendingCommand, agentThread } = agentState;
        const activity = deriveActivity(isAgentRunning, isThinking, pendingCommand, agentThread);
        officeState.setAgentActive(charId, activity.isActive, activity.tool);
        officeState.setBubble(charId, activity.bubbleType);
        continue;
      }

      // No activity
      officeState.setAgentActive(charId, false);
      officeState.setBubble(charId, null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, tabs, store, officeState]);

  // Run reconciliation on a 500ms interval — picks up terminal data ref changes,
  // agent store changes, and decays idle sessions, all in one loop.
  useEffect(() => {
    reconcile(); // initial run
    const interval = setInterval(() => {
      // Decay idle terminal sessions
      const now = Date.now();
      for (const [id, lastTs] of terminalLastActive.current) {
        if (now - lastTs > TERMINAL_IDLE_MS) {
          terminalLastActive.current.delete(id);
          terminalDetectedTool.current.delete(id);
          terminalToolTimestamp.current.delete(id);
          sessionLookback.delete(id);
          dataChangedRef.current = true;
        }
      }
      reconcile();
      if (dataChangedRef.current) {
        setVersion(v => v + 1); // trigger re-render for debug info
        dataChangedRef.current = false;
      }
    }, 500);
    return () => clearInterval(interval);
  }, [reconcile]);

  // Compute debug info during render
  const allStates = store ? store.getSnapshot() : new Map<string, unknown>();
  const now = Date.now();
  const debugInfo: BridgeDebugInfo = {
    storeExists: !!store,
    version,
    layoutSessionCount: sessions.size,
    storeId: store?.storeId ?? "none",
    terminalActive: Array.from(terminalLastActive.current.entries())
      .filter(([, ts]) => now - ts < TERMINAL_IDLE_MS)
      .map(([id]) => id.slice(0, 8)),
    trackedSessions: Array.from(sessionToCharId.current.entries()).map(([sid, cid]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentState = allStates.get(sid) as any;
      const ch = officeState.characters.get(cid);
      const lastActive = terminalLastActive.current.get(sid);
      const isTermActive = lastActive != null && (now - lastActive) < TERMINAL_IDLE_MS;
      return {
        sessionId: sid.slice(0, 8),
        charId: cid,
        agentActive: agentState?.isAgentRunning ?? false,
        termActive: isTermActive,
        tool: terminalDetectedTool.current.get(sid) ?? (agentState?.isAgentRunning ? (ch?.currentTool ?? null) : null),
        charState: ch?.state ?? -1,
        isActive: ch?.isActive ?? false,
      };
    }),
  };
  return debugInfo;
}
