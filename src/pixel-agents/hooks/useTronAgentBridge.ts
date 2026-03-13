import { useEffect, useRef, useContext, useState, useCallback } from "react";
import { AgentContext } from "../../contexts/AgentContext";
import { useLayout } from "../../contexts/LayoutContext";
import { IPC } from "../../constants/ipc";
import type { AgentStep, Tab, LayoutNode } from "../../types";

/** Agent status for a single terminal session */
export interface AgentStatus {
  sessionId: string;
  label: string;
  active: boolean;
  tool: string | null;
  permission: boolean;
}

// ── Tool detection ──────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[a-zA-Z]|\x1B\].*?(?:\x07|\x1B\\)|\x1B[()][0-2]|\x1B[>=<]|\x1B\x1B|\x0F|\x0E/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ""); }

/** Claude Code tool bullet — must appear at start-of-line (after newline or start of chunk).
 *  Using `(?:^|\\n)\\s*` anchor prevents matching tool names in mid-line prose. */
const CC_PREFIX = `(?:^|\\n)\\s*[⏺⏵►▶●]`;

/** All known Claude Code tool display names → internal category.
 *  Covers both old names (WebFetch, WebSearch) and new short names (Fetch, Search). */
const TOOL_NAMES: [string, string][] = [
  // File operations
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Edit", "edit_file"],
  ["MultiEdit", "edit_file"],
  // Search / browse
  ["Glob", "list_dir"],
  ["Grep", "search_dir"],
  ["LS", "list_dir"],
  ["ToolSearch", "search_dir"],
  // Shell
  ["Bash", "execute_command"],
  ["BashOutput", "execute_command"],
  ["KillShell", "execute_command"],
  ["Skill", "execute_command"],
  ["SlashCommand", "execute_command"],
  // Web — both old (WebSearch/WebFetch) and new (Search/Fetch) display names
  ["WebSearch", "web_search"],
  ["WebFetch", "web_search"],
  ["Search", "web_search"],
  ["Fetch", "web_search"],
  // Agents / tasks
  ["Agent", "agent"],
  ["Explore", "search_dir"],
  ["Task", "agent"],
  ["TaskCreate", "agent"],
  ["TaskUpdate", "agent"],
  ["TaskList", "agent"],
  ["TaskGet", "agent"],
  ["TaskOutput", "agent"],
  ["TaskStop", "agent"],
  // Notebook
  ["NotebookEdit", "edit_file"],
  ["NotebookRead", "read_file"],
  // Todo
  ["TodoRead", "read_file"],
  ["TodoWrite", "write_file"],
  // Planning / thinking
  ["Plan", "thinking"],
  ["ExitPlanMode", "thinking"],
  ["EnterPlanMode", "thinking"],
  // Cron
  ["CronCreate", "execute_command"],
  ["CronDelete", "execute_command"],
  ["CronList", "list_dir"],
  // User interaction
  ["AskUser", "ask_question"],
  ["AskUserQuestion", "ask_question"],
];

// Build regex arrays — longer names first to avoid prefix conflicts
const sortedToolNames = [...TOOL_NAMES].sort((a, b) => b[0].length - a[0].length);

const TOOL_CALL_RE: [RegExp, string][] = sortedToolNames.map(([name, cat]) =>
  [new RegExp(`${CC_PREFIX}\\s*${name}\\b`), cat],
);
// Also match "Web Search" / "Web Fetch" (space-separated display variants)
TOOL_CALL_RE.push(
  [new RegExp(`${CC_PREFIX}\\s*Web\\s+Search\\b`), "web_search"],
  [new RegExp(`${CC_PREFIX}\\s*Web\\s+Fetch\\b`), "web_search"],
);

// Compact/gerund-form tool display: "⏺ Reading 1 file…", "⏺ Writing to 2 files…",
// "⏺ Editing 3 files…", "⏺ Searching…", "⏺ Running…", etc.
const GERUND_TOOL_RE: [RegExp, string][] = [
  [new RegExp(`${CC_PREFIX}\\s*Reading\\b`), "read_file"],
  [new RegExp(`${CC_PREFIX}\\s*Writing\\b`), "write_file"],
  [new RegExp(`${CC_PREFIX}\\s*Editing\\b`), "edit_file"],
  [new RegExp(`${CC_PREFIX}\\s*Searching\\b`), "search_dir"],
  [new RegExp(`${CC_PREFIX}\\s*Running\\b`), "execute_command"],
  [new RegExp(`${CC_PREFIX}\\s*Listing\\b`), "list_dir"],
  [new RegExp(`${CC_PREFIX}\\s*Fetching\\b`), "web_search"],
  [new RegExp(`${CC_PREFIX}\\s*Launching\\b`), "agent"],
  [new RegExp(`${CC_PREFIX}\\s*Spawning\\b`), "agent"],
  [new RegExp(`${CC_PREFIX}\\s*Planning\\b`), "thinking"],
  [new RegExp(`${CC_PREFIX}\\s*Thinking\\b`), "thinking"],
];

const EXTRA_TOOL_RE: [RegExp, string][] = [
  [/"tool":\s*"(Read|read_file|NotebookRead|TodoRead)"/, "read_file"],
  [/"tool":\s*"(Write|write_file|TodoWrite)"/, "write_file"],
  [/"tool":\s*"(Edit|MultiEdit|edit_file|NotebookEdit)"/, "edit_file"],
  [/"tool":\s*"(Bash|BashOutput|KillShell|execute_command|run_in_terminal|Skill|SlashCommand)"/, "execute_command"],
  [/"tool":\s*"(Glob|LS|list_dir)"/, "list_dir"],
  [/"tool":\s*"(Grep|ToolSearch|search_dir)"/, "search_dir"],
  [/"tool":\s*"(WebSearch|WebFetch|Search|Fetch|web_search)"/, "web_search"],
  [/"tool":\s*"(Agent|Explore|Task|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|TaskStop)"/, "agent"],
  [/"tool":\s*"(Plan|ExitPlanMode|EnterPlanMode|exit_plan_mode)"/, "thinking"],
  [/"tool":\s*"(AskUser|AskUserQuestion|ask_question)"/, "ask_question"],
  [/"tool":\s*"(CronCreate|CronDelete|CronList)"/, "execute_command"],
];

/** Claude Code thinking: spinner chars (· ✢ ✳ ✶ ✻ ✽) + random verb + … */
const THINKING_RE = /[·✢✳✶✻✽]\s+[A-Z][a-z]+[….]/;

/** Claude Code permission prompt — "Allow ToolName(...)" or "Allow mcp__..." */
const PERMISSION_RE = /Allow\s+(?:Bash|Read|Edit|MultiEdit|Write|Glob|Grep|Fetch|Search|WebFetch|WebSearch|Agent|Explore|Task|Skill|NotebookEdit|mcp__)\b/;

/** Known AI agent names / banners that indicate an agent session.
 *  Matching any of these marks the session as "has agent" so subsequent
 *  terminal activity is tracked as working status. */
const AGENT_NAME_RE = /\bclaude\s*code\b|\bclaude\b|\bcopilot\b|\bcursor\b|\baider\b|\bcody\b|\bcodex\b|\bgithub\s*copilot\b|\bcontinue\b|\btabby\b|\bdevin\b|\bwindsurf\b/i;

/** Generic interactive prompts that indicate the terminal needs user input.
 *  Covers npm init, Claude Code, cargo, pip, docker, git, etc. */
const GENERIC_PERMISSION_PATTERNS = [
  /do you want to proceed\??/i,
  /would you like to proceed\??/i,
  /do you want to continue\??/i,
  /are you sure\??/i,
  /\(y\/n\)\s*\??/i,
  /\[y\/n\]\s*\??/i,
  /\[yes\/no\]\s*\??/i,
  /continue\?\s*\(y\/n\)/i,
  /allow this action\??/i,
  /press enter to continue/i,
  /[❯►]\s*\d+\.\s+(?:Yes|No|Cancel|Skip|Continue|Abort)/i,
  /[●○]\s+(?:Yes|No|Cancel|Skip|Continue|Abort)/i,
  /◆\s+\S/,
];

const sessionLookback = new Map<string, string>();
const LOOKBACK_MAX = 150;

interface DetectResult {
  tool: string | null;
  permission: boolean;
}

function detectToolFromChunk(sessionId: string, rawData: string): DetectResult {
  const stripped = stripAnsi(rawData);
  const prev = sessionLookback.get(sessionId) || "";
  const text = prev + stripped;

  // Check for permission prompt first (highest priority)
  // Includes both Claude Code specific "Allow ..." and generic interactive prompts
  const hasPermission = PERMISSION_RE.test(text) ||
    GENERIC_PERMISSION_PATTERNS.some(p => p.test(text));

  // Check for tool patterns in the combined lookback + current chunk
  for (const [re, tool] of TOOL_CALL_RE) {
    if (re.test(text)) {
      sessionLookback.delete(sessionId);
      return { tool, permission: hasPermission };
    }
  }
  for (const [re, tool] of GERUND_TOOL_RE) {
    if (re.test(text)) {
      sessionLookback.delete(sessionId);
      return { tool, permission: hasPermission };
    }
  }
  for (const [re, tool] of EXTRA_TOOL_RE) {
    if (re.test(stripped)) {
      sessionLookback.delete(sessionId);
      return { tool, permission: hasPermission };
    }
  }
  if (THINKING_RE.test(stripped)) {
    sessionLookback.delete(sessionId);
    return { tool: "thinking", permission: false };
  }
  // Permission prompt without a tool match — still counts as activity
  if (hasPermission) {
    sessionLookback.delete(sessionId);
    return { tool: null, permission: true };
  }
  // Agent name/banner detected — no specific tool, but marks the session as agent
  if (AGENT_NAME_RE.test(stripped)) {
    sessionLookback.delete(sessionId);
    return { tool: "agent_detected", permission: false };
  }

  // No match — keep the lookback for the next chunk (tool name may be split)
  sessionLookback.set(sessionId, text.length > LOOKBACK_MAX
    ? text.slice(text.length - LOOKBACK_MAX) : text);
  return { tool: null, permission: false };
}

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

const TOOL_STICKY_MS = 2000;
/** How long after last terminal data before we consider an external agent idle */
const EXTERNAL_IDLE_MS = 5000;

export function useAgentStatuses(): AgentStatus[] {
  const store = useContext(AgentContext);
  const { sessions, tabs } = useLayout();
  const [statuses, setStatuses] = useState<AgentStatus[]>([]);

  const terminalDetectedTool = useRef(new Map<string, string | null>());
  const terminalToolTimestamp = useRef(new Map<string, number>());
  const terminalPermission = useRef(new Map<string, boolean>());

  // Track which sessions have an actively running agent (via tron:agent-activity events)
  const agentRunning = useRef(new Set<string>());

  // Track which sessions have EVER had agent activity (persists until session removed)
  const everHadAgent = useRef(new Set<string>());

  // Track last terminal data timestamp per session — used to detect external agent activity
  const terminalLastData = useRef(new Map<string, number>());

  // Per-session: timestamp when detection should start (skips history replay & post-stop data)
  const sessionDetectAfter = useRef(new Map<string, number>());

  /** Grace period for history replay on page refresh / reconnect */
  const HISTORY_GRACE_MS = 3000;
  /** Cooldown after Tron agent stops — ignore trailing terminal data */
  const STOP_COOLDOWN_MS = 2000;

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

        // Skip detection during grace / cooldown period
        const detectAfter = sessionDetectAfter.current.get(id)!;
        if (now < detectAfter) return;

        // Try tool detection — tool patterns are the only signal for external agents
        const { tool, permission } = detectToolFromChunk(id, data);

        // Track permission state from external agents (Claude Code "Allow ..." prompts)
        terminalPermission.current.set(id, permission);

        // While an agent is actively running (terminalLastData exists from a recent
        // tool/thinking/name match), ANY terminal data keeps it alive as "working".
        // Once the agent goes idle and terminalLastData is cleaned up by the
        // reconcile loop, regular terminal data from non-agent commands won't
        // re-trigger the working status — only new agent patterns will.
        if (!tool && !permission && terminalLastData.current.has(id)) {
          const printable = stripAnsi(data).replace(/[\x00-\x1F\x7F]/g, "").trim();
          if (printable.length > 0) {
            terminalLastData.current.set(id, now);
          }
        }

        if (tool || permission) {
          // Tool/permission matches — primary activity signal, also marks agent presence
          everHadAgent.current.add(id);
          terminalLastData.current.set(id, now);

          // "agent_detected" is just an identifier (agent name/banner seen),
          // not a real tool — only used to mark everHadAgent + timestamp
          if (tool === "agent_detected") {
            // no-op for tool display
          } else if (tool === "thinking") {
            const lastTs = terminalToolTimestamp.current.get(id) ?? 0;
            if (now - lastTs > TOOL_STICKY_MS) {
              terminalDetectedTool.current.set(id, tool);
            }
          } else if (tool) {
            terminalDetectedTool.current.set(id, tool);
            terminalToolTimestamp.current.set(id, now);
          }
        }
      },
    );
  }, [store]);

  // Listen for Tron agent activity events — authoritative source for running state
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId, running } = (e as CustomEvent).detail;
      if (running) {
        agentRunning.current.add(sessionId);
      } else {
        agentRunning.current.delete(sessionId);
        // Clear all state when agent stops
        terminalDetectedTool.current.delete(sessionId);
        terminalToolTimestamp.current.delete(sessionId);
        terminalPermission.current.delete(sessionId);
        terminalLastData.current.delete(sessionId);
        sessionLookback.delete(sessionId);
        // Set cooldown so trailing terminal data doesn't re-trigger detection
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

      // External agent (Claude Code CLI etc.) — detected via terminal data flow
      // A session is considered externally active if:
      // 1. We got an explicit tron:agent-activity start event, OR
      // 2. We've seen agent tool patterns in terminal data recently (within EXTERNAL_IDLE_MS)
      const lastData = terminalLastData.current.get(id);
      const isExternalActive = agentRunning.current.has(id) ||
        (lastData != null && (now - lastData) < EXTERNAL_IDLE_MS);

      if (isExternalActive) {
        everHadAgent.current.add(id);
        result.push({
          sessionId: id,
          label,
          active: true,
          tool: terminalDetectedTool.current.get(id) ?? null,
          permission: terminalPermission.current.get(id) ?? false,
        });
        continue;
      }

      // Clean up stale external agent state
      if (lastData != null && (now - lastData) >= EXTERNAL_IDLE_MS) {
        terminalLastData.current.delete(id);
        terminalDetectedTool.current.delete(id);
        terminalToolTimestamp.current.delete(id);
        terminalPermission.current.delete(id);
        sessionLookback.delete(id);
      }

      // Only show sessions that have had agent activity at some point
      if (everHadAgent.current.has(id)) {
        result.push({ sessionId: id, label, active: false, tool: null, permission: false });
      }
    }

    setStatuses(prev => {
      // Only update if something actually changed to avoid re-renders (#2)
      if (prev.length !== result.length) return result;
      for (let i = 0; i < result.length; i++) {
        const a = prev[i], b = result[i];
        if (a.sessionId !== b.sessionId || a.active !== b.active || a.tool !== b.tool || a.permission !== b.permission || a.label !== b.label) {
          return result;
        }
      }
      return prev;
    });
  }, [sessions, tabs, store]);

  useEffect(() => {
    reconcile();
    const interval = setInterval(reconcile, 500);
    return () => clearInterval(interval);
  }, [reconcile]);

  return statuses;
}
