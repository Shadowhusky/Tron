import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  Command,
  Check,
  X,
  AlertTriangle,
  ShieldAlert,
  Terminal as TerminalIcon,
  Brain,
  Minimize2,
} from "lucide-react";
import { marked } from "marked";
import { useTheme } from "../../../contexts/ThemeContext";
import type { AgentStep } from "../../../types";
import { slideUp } from "../../../utils/motion";

// Configure marked for minimal, safe output
marked.setOptions({ breaks: true, gfm: true });

/** Extract human-readable progress from partial/complete streaming JSON */
function describeStreamingContent(raw: string): {
  label: string;
  detail?: string;
} {
  // Try full JSON parse first
  try {
    const obj = JSON.parse(raw);
    if (obj.tool === "execute_command" && obj.command)
      return { label: "Running command", detail: obj.command };
    if (obj.tool === "run_in_terminal" && obj.command)
      return { label: "Sending to terminal", detail: obj.command };
    if (obj.tool === "final_answer") return { label: "Composing answer" };
    if (obj.tool) return { label: `Tool: ${obj.tool}` };
  } catch {
    /* partial JSON — use regex fallback */
  }

  // Regex extraction from partial JSON — no detail (it's incomplete and flickers)
  const toolMatch = raw.match(/"tool"\s*:\s*"([^"]+)"/);

  if (toolMatch) {
    const tool = toolMatch[1];
    if (tool === "execute_command") return { label: "Planning command" };
    if (tool === "run_in_terminal")
      return { label: "Planning terminal action" };
    if (tool === "final_answer") return { label: "Composing answer" };
    return { label: `Planning: ${tool}` };
  }

  return { label: "Responding" };
}

/** Dangerous command patterns — destructive, irreversible, or system-altering */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*)?.*(-r|-f|--force|--recursive|\*)/, // rm -rf, rm -f, rm *
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/, // rm -rf combined
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, // rm -fr combined
  /\bmkfs\b/, // format filesystem
  /\bdd\s+.*of=/, // dd write to device
  /\b(shutdown|reboot|halt|poweroff)\b/, // system power
  /\bsudo\s+rm\b/, // sudo rm anything
  /\bchmod\s+(-R\s+)?[0-7]*777\b/, // chmod 777
  /\bchown\s+-R\b/, // recursive chown
  />\s*\/dev\/(sda|hda|nvme|disk)/, // write to device
  /\b(drop|truncate)\s+(database|table|schema)\b/i, // SQL destructive
  /\bgit\s+(push\s+.*--force|reset\s+--hard|clean\s+-fd)/, // git destructive
  /\bkill\s+-9\s+-1\b/, // kill all processes
  /\b:(){ :\|:& };:/, // fork bomb
  /\bcurl\s.*\|\s*(sudo\s+)?bash/, // pipe to bash
  /\bwget\s.*\|\s*(sudo\s+)?bash/, // pipe to bash
];

function isDangerousCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Renders markdown string as HTML. Memoized to avoid re-parsing identical content. */
const MarkdownContent: React.FC<{ content: string; className?: string }> = ({
  content,
  className,
}) => {
  const html = useMemo(() => {
    try {
      return marked.parse(content, { async: false }) as string;
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div
      className={`markdown-content ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

interface AgentOverlayProps {
  isThinking: boolean;
  isAgentRunning: boolean;
  agentThread: AgentStep[];
  pendingCommand: string | null;
  autoExecuteEnabled: boolean;
  onToggleAutoExecute: () => void;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
  onClose: () => void;
  onPermission: (choice: "allow" | "always" | "deny") => void;
  isExpanded: boolean;
  onExpand: () => void;
  onRunAgent: (prompt: string) => Promise<void>;
  modelCapabilities?: string[];
}

/* Toast for transient execution-state notifications only */
const AgentToast: React.FC<{
  message: string;
  type: "info" | "error" | "success";
  onDismiss: () => void;
  isLight: boolean;
}> = ({ message, type, onDismiss, isLight }) => {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(), 6000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg text-xs font-mono max-w-sm animate-in fade-in slide-in-from-right-3 border ${type === "error"
        ? isLight
          ? "bg-red-50 border-red-200 text-red-700"
          : "bg-red-950/80 border-red-500/20 text-red-300"
        : type === "success"
          ? isLight
            ? "bg-green-50 border-green-200 text-green-700"
            : "bg-green-950/80 border-green-500/20 text-green-300"
          : isLight
            ? "bg-white border-gray-200 text-gray-700"
            : "bg-[#1a1a2e]/90 border-white/10 text-gray-300"
        }`}
    >
      {type === "error" ? (
        <AlertTriangle className="w-3 h-3 shrink-0 text-red-400" />
      ) : type === "success" ? (
        <Check className="w-3 h-3 shrink-0 text-green-400" />
      ) : (
        <TerminalIcon className="w-3 h-3 shrink-0 text-blue-400" />
      )}
      <span className="truncate">{message}</span>
    </div>
  );
};

/** Thinking display — shows latest 2 lines by default with scroll, expandable */
const ThinkingBlock: React.FC<{
  content: string;
  isLight: boolean;
  isStreaming: boolean;
}> = ({ content, isLight, isStreaming }) => {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = content.split("\n");
  const isTruncated = lines.length > 2;
  const tokenCount = Math.round(content.length / 4);

  // Always show latest content (bottom) when collapsed
  useEffect(() => {
    if (!expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, expanded]);

  return (
    <div
      className={`mt-1 rounded border p-2 transition-all ${isLight
        ? "bg-purple-50/50 border-purple-200/50"
        : "bg-purple-950/20 border-purple-500/10"
        }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className={`text-[9px] uppercase tracking-wider font-semibold ${isLight ? "text-purple-400" : "text-purple-500/80"}`}
        >
          {isStreaming ? "Thinking Process" : "Reasoning"}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={`text-[9px] font-mono ${isLight ? "text-purple-400" : "text-purple-500/60"}`}
          >
            {tokenCount} tokens
          </span>
          {isTruncated && (
            <button
              onClick={() => setExpanded(!expanded)}
              className={`text-[9px] uppercase tracking-wider opacity-60 hover:opacity-100 transition-opacity ${isLight ? "text-purple-600" : "text-purple-400"
                }`}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className={`transition-all ${expanded ? "max-h-60 overflow-y-auto" : "max-h-[2.75rem] overflow-hidden"}`}
        style={!expanded && isTruncated ? {
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
        } : undefined}
      >
        <MarkdownContent
          content={content}
          className={`text-[11px] leading-relaxed ${isLight ? "text-gray-700" : "text-gray-300"}`}
        />
      </div>
    </div>
  );
};

/** Streaming planning display — similar to ThinkingBlock but for in-progress tool calls */
const PlanningBlock: React.FC<{
  content: string;
  label: string;
  isLight: boolean;
}> = ({ content, label, isLight }) => {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = content.split("\n");
  const isTruncated = lines.length > 2 || content.length > 120;
  const tokenCount = Math.round(content.length / 4);

  // Always show latest content (bottom) when collapsed
  useEffect(() => {
    if (!expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, expanded]);

  return (
    <div
      className={`mt-1 rounded border p-2 transition-all ${isLight
        ? "bg-cyan-50/50 border-cyan-200/50"
        : "bg-cyan-950/20 border-cyan-500/10"
        }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className={`text-[9px] uppercase tracking-wider font-semibold ${isLight ? "text-cyan-400" : "text-cyan-500/80"}`}
        >
          {label}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={`text-[9px] font-mono ${isLight ? "text-cyan-400" : "text-cyan-500/60"}`}
          >
            {tokenCount} tokens
          </span>
          {isTruncated && (
            <button
              onClick={() => setExpanded(!expanded)}
              className={`text-[9px] uppercase tracking-wider opacity-60 hover:opacity-100 transition-opacity ${isLight ? "text-cyan-600" : "text-cyan-400"
                }`}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className={`transition-all ${expanded ? "max-h-60 overflow-y-auto" : "max-h-[2.75rem] overflow-hidden"}`}
        style={!expanded && isTruncated ? {
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 60%)",
        } : undefined}
      >
        <code
          className={`block text-[11px] leading-relaxed whitespace-pre-wrap ${isLight ? "text-gray-700" : "text-gray-300"}`}
        >
          {content}
        </code>
      </div>
    </div>
  );
};

/** Permission request with dangerous command detection + double-confirm */
const PermissionRequest: React.FC<{
  command: string;
  isLight: boolean;
  onPermission: (choice: "allow" | "always" | "deny") => void;
}> = ({ command, isLight, onPermission }) => {
  const dangerous = isDangerousCommand(command);
  const [confirmStep, setConfirmStep] = useState<0 | 1>(0);
  const [cmdExpanded, setCmdExpanded] = useState(false);
  const isLongCommand = command.length > 300 || command.split("\n").length > 8;

  // Reset confirm step and collapse when command changes
  useEffect(() => {
    setConfirmStep(0);
    setCmdExpanded(false);
  }, [command]);

  const handleAllow = () => {
    if (dangerous && confirmStep === 0) {
      setConfirmStep(1);
      return;
    }
    onPermission("allow");
  };

  return (
    <div
      className={`flex flex-col p-4 border-t animate-in fade-in slide-in-from-bottom-2 ${dangerous
        ? isLight
          ? "bg-red-50/90 border-red-300"
          : "bg-red-950/40 border-red-500/30"
        : isLight
          ? "bg-blue-50/80 border-blue-200"
          : "bg-blue-900/20 border-blue-500/20"
        }`}
    >
      {/* Header */}
      <div
        className={`text-sm mb-2 font-medium flex items-center gap-2 shrink-0 ${dangerous
          ? isLight
            ? "text-red-700"
            : "text-red-300"
          : isLight
            ? "text-blue-700"
            : "text-blue-200"
          }`}
      >
        {dangerous ? (
          <ShieldAlert className="w-4 h-4" />
        ) : (
          <Command className="w-4 h-4" />
        )}
        {dangerous
          ? "Dangerous command — review carefully!"
          : "Allow command execution?"}
      </div>

      {/* Command display — collapsed by default for long commands */}
      <div className="shrink-0 mb-3">
        <div className="rounded border overflow-hidden">
          <code
            className={`block p-3 text-xs font-mono break-all whitespace-pre-wrap transition-all ${
              isLongCommand && !cmdExpanded ? "max-h-[6rem] overflow-hidden" : "max-h-[25vh] overflow-y-auto"
            } ${dangerous
              ? isLight
                ? "bg-red-100 border-red-300 text-red-900"
                : "bg-red-950/50 border-red-500/20 text-red-200"
              : isLight
                ? "bg-white border-blue-200 text-blue-800"
                : "bg-black/50 border-blue-500/10 text-blue-100"
              }`}
            style={isLongCommand && !cmdExpanded ? {
              WebkitMaskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
              maskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
            } : undefined}
          >
            {command}
          </code>
          {isLongCommand && (
            <button
              onClick={() => setCmdExpanded(!cmdExpanded)}
              className={`w-full text-[10px] py-1 text-center uppercase tracking-wider transition-colors ${
                isLight
                  ? "bg-gray-50 text-gray-500 hover:text-gray-800 hover:bg-gray-100"
                  : "bg-white/5 text-gray-500 hover:text-white hover:bg-white/10"
              }`}
            >
              {cmdExpanded ? "Collapse" : `Show full command (${command.split("\n").length} lines)`}
            </button>
          )}
        </div>
      </div>

      {/* Danger warning */}
      {dangerous && (
        <div
          className={`shrink-0 flex items-start gap-2 mb-3 p-2 rounded text-xs ${isLight
            ? "bg-red-100/50 text-red-700"
            : "bg-red-950/30 text-red-300/80"
            }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            This command is potentially destructive and may cause irreversible
            changes. Please verify before allowing.
          </span>
        </div>
      )}

      {/* Double-confirm step for dangerous commands */}
      {dangerous && confirmStep === 1 && (
        <div
          className={`shrink-0 flex items-center gap-2 mb-3 p-2 rounded border text-xs font-semibold animate-in fade-in ${isLight
            ? "bg-red-200/60 border-red-400 text-red-800"
            : "bg-red-900/40 border-red-500/40 text-red-200"
            }`}
        >
          <ShieldAlert className="w-3.5 h-3.5 shrink-0 animate-pulse" />
          Are you absolutely sure? Click "Confirm Execute" to proceed.
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 justify-end shrink-0">
        <button
          onClick={() => onPermission("deny")}
          className={`px-4 py-2 text-xs rounded-md border transition-colors flex items-center gap-1.5 ${isLight
            ? "bg-white hover:bg-gray-50 text-gray-600 border-gray-300"
            : "bg-transparent hover:bg-white/5 text-white/60 border-white/10"
            }`}
        >
          <X className="w-3 h-3" /> Deny
        </button>
        {!dangerous && (
          <button
            onClick={() => onPermission("always")}
            className={`px-4 py-2 text-xs rounded-md border transition-colors ${isLight
              ? "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-300"
              : "bg-blue-900/30 hover:bg-blue-900/50 text-blue-200 border-blue-500/20"
              }`}
          >
            Always Allow
          </button>
        )}
        <button
          onClick={handleAllow}
          className={`px-4 py-2 text-xs rounded-md transition-colors flex items-center gap-1.5 ${dangerous
            ? confirmStep === 1
              ? "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-900/30"
              : isLight
                ? "bg-red-100 hover:bg-red-200 text-red-700 border border-red-300"
                : "bg-red-900/40 hover:bg-red-900/60 text-red-200 border border-red-500/30"
            : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20"
            }`}
        >
          {dangerous ? (
            confirmStep === 1 ? (
              <>
                <AlertTriangle className="w-3 h-3" /> Confirm Execute
              </>
            ) : (
              <>
                <ShieldAlert className="w-3 h-3" /> Allow Dangerous
              </>
            )
          ) : (
            <>
              <Check className="w-3 h-3" /> Allow Once
            </>
          )}
        </button>
      </div>
    </div>
  );
};

const AgentOverlay: React.FC<AgentOverlayProps> = ({
  isThinking,
  isAgentRunning,
  agentThread,
  pendingCommand,
  autoExecuteEnabled,
  onToggleAutoExecute,
  thinkingEnabled,
  onToggleThinking,
  onClose,
  onPermission,
  isExpanded,
  onExpand,
  modelCapabilities,
}) => {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelNarrow, setPanelNarrow] = useState(false);

  // Track panel width for responsive controls
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setPanelNarrow(entry.contentRect.width < 400);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Collapsible executed steps: track which step indices are collapsed
  const [collapsedSteps, setCollapsedSteps] = useState<Set<number>>(new Set());

  // Auto-collapse previous executed steps when new executing/separator step arrives
  const prevAutoCollapseLen = useRef(agentThread.length);
  useEffect(() => {
    if (agentThread.length <= prevAutoCollapseLen.current) {
      if (agentThread.length === 0) setCollapsedSteps(new Set());
      prevAutoCollapseLen.current = agentThread.length;
      return;
    }
    const newSteps = agentThread.slice(prevAutoCollapseLen.current);
    prevAutoCollapseLen.current = agentThread.length;

    // If any new step is executing/separator/streaming, collapse all previous executed steps
    const shouldCollapse = newSteps.some(
      (s) => s.step === "executing" || s.step === "separator" || s.step === "streaming",
    );
    if (shouldCollapse) {
      const toCollapse = new Set(collapsedSteps);
      for (let i = 0; i < agentThread.length - newSteps.length; i++) {
        if (agentThread[i].step === "executed") toCollapse.add(i);
      }
      setCollapsedSteps(toCollapse);
    }
  }, [agentThread.length]);

  const toggleStepCollapse = useCallback((idx: number) => {
    setCollapsedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  // Toast state: only for transient "executing"/"executed" notifications
  const [toasts, setToasts] = useState<
    { id: number; message: string; type: "info" | "error" | "success" }[]
  >([]);
  const toastIdRef = useRef(0);

  // Watch thread for execution-state steps → spawn toasts
  // Initialize to current length so remount doesn't replay old toasts
  const prevLenRef = useRef(agentThread.length);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevLenRef.current = agentThread.length;
      return;
    }
    if (agentThread.length === 0) {
      prevLenRef.current = 0;
      return;
    }
    const newSteps = agentThread.slice(prevLenRef.current);
    prevLenRef.current = agentThread.length;

    for (const s of newSteps) {
      if (s.step === "executing") {
        const id = ++toastIdRef.current;
        setToasts((prev) => [...prev, { id, message: s.output, type: "info" }]);
      } else if (s.step === "executed") {
        const id = ++toastIdRef.current;
        setToasts((prev) => [
          ...prev,
          { id, message: `Done: ${s.output}`, type: "success" },
        ]);
      }
    }
  }, [agentThread.length]);

  // Auto-scroll: only if user hasn't manually scrolled up
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const userScrolledUpRef = useRef(false);
  const isAutoScrolling = useRef(false);

  const handleScroll = useCallback(() => {
    // Skip scroll events caused by our own programmatic scrolling
    if (isAutoScrolling.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distFromBottom > 60;
    userScrolledUpRef.current = scrolledUp;
    setUserScrolledUp(scrolledUp);
  }, []);

  const scrollToBottom = useCallback(() => {
    isAutoScrolling.current = true;
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
    userScrolledUpRef.current = false;
    setUserScrolledUp(false);
    // Reset flag after scroll event fires
    requestAnimationFrame(() => { isAutoScrolling.current = false; });
  }, []);

  const lastEntry = agentThread[agentThread.length - 1];
  const scrollTrigger = `${agentThread.length}:${lastEntry?.output?.length || 0}`;
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      isAutoScrolling.current = true;
      scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
      requestAnimationFrame(() => { isAutoScrolling.current = false; });
    }
  }, [scrollTrigger]);

  // Reset toasts on new run
  useEffect(() => {
    if (agentThread.length === 0) setToasts([]);
  }, [agentThread.length]);

  const dismissToast = useCallback(
    (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  const statusText = isThinking
    ? "Agent is thinking..."
    : isAgentRunning
      ? "Agent working..."
      : (() => {
        const last = agentThread[agentThread.length - 1];
        if (!last) return "Idle";
        if (last.step === "error" || last.step === "failed")
          return last.output.toLowerCase().includes("abort")
            ? "Task Aborted"
            : "Task Failed";
        if (last.step === "question") return "Awaiting Input";
        if (last.step === "done") return "Task Completed";
        return "Task Completed";
      })();

  // Steps to show in panel: include executing steps (with spinner)
  const panelSteps = agentThread;

  const showPanel =
    isAgentRunning || isThinking || pendingCommand || panelSteps.length > 0;

  if (!showPanel && toasts.length === 0) return null;

  return (
    <>
      {/* Toast stack — top right of session */}
      <AnimatePresence>
        {toasts.length > 0 && (
          <div className="absolute top-2 right-2 z-30 flex flex-col gap-1.5 pointer-events-auto">
            {toasts.slice(-4).map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, x: 20, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 20, scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                <AgentToast
                  message={t.message}
                  type={t.type}
                  isLight={isLight}
                  onDismiss={() => dismissToast(t.id)}
                />
              </motion.div>
            ))}
          </div>
        )}
      </AnimatePresence>

      {/* Agent Panel */}
      {showPanel && (
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className={`w-full shrink-0 ${isExpanded
            ? "max-h-[50vh] flex-col"
            : "h-auto cursor-pointer hover:opacity-100 opacity-90"
            } overflow-hidden border-t flex shadow-lg z-20 ${isLight
              ? "bg-white/95 border-gray-200 text-gray-900"
              : resolvedTheme === "modern"
                ? "bg-[#0a0a1a]/60 border-white/[0.06] text-white backdrop-blur-2xl shadow-[0_-4px_24px_rgba(0,0,0,0.3)]"
                : "bg-[#0a0a0a]/95 border-white/10 text-white"
            }`}
          onClick={!isExpanded ? onExpand : undefined}
        >
          {/* Status Header */}
          <div
            className={`flex items-center justify-between gap-2 px-3 py-1.5 shrink-0 ${isExpanded ? "border-b" : ""
              } ${isLight
                ? "border-gray-200/80 bg-gray-50/60"
                : "border-white/5 bg-white/5"
              }`}
          >
            <div className="flex items-center gap-2 shrink-0">
              <div
                className={`w-2 h-2 rounded-full ${isAgentRunning || isThinking
                  ? "bg-purple-400 animate-pulse"
                  : "bg-gray-500"
                  }`}
              />
              <span
                className={`text-xs font-medium ${isLight ? "text-purple-700" : "text-purple-200"
                  }`}
              >
                {statusText}
              </span>
            </div>

            {/* Controls - Only show when expanded, logic for minimize/expand handled by container click when collapsed */}
            {isExpanded && (
              <div className="flex items-center gap-1 flex-wrap justify-end">
                {(!modelCapabilities || modelCapabilities.length === 0 || modelCapabilities.includes("thinking")) && (
                  <button
                    onClick={onToggleThinking}
                    className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors flex items-center gap-1 shrink-0 ${thinkingEnabled
                      ? isLight
                        ? "border-purple-300 text-purple-600 bg-purple-50 hover:bg-purple-100"
                        : "border-purple-500/30 text-purple-400 bg-purple-500/10 hover:bg-purple-500/20"
                      : isLight
                        ? "border-gray-300 text-gray-500 bg-gray-50 hover:bg-gray-100"
                        : "border-white/10 text-gray-500 bg-white/5 hover:bg-white/10"
                      }`}
                    title={
                      thinkingEnabled
                        ? "Disable thinking (faster responses)"
                        : "Enable thinking (more thorough reasoning)"
                    }
                  >
                    <Brain className="w-3 h-3" />
                    {"Thinking " + (thinkingEnabled ? "ON" : "OFF")}
                  </button>
                )}
                <button
                  onClick={onToggleAutoExecute}
                  className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors flex items-center gap-1 shrink-0 ${autoExecuteEnabled
                    ? isLight
                      ? "border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100"
                      : "border-orange-500/30 text-orange-400 bg-orange-500/10 hover:bg-orange-500/20"
                    : isLight
                      ? "border-gray-300 text-gray-500 bg-gray-50 hover:bg-gray-100"
                      : "border-white/10 text-gray-500 bg-white/5 hover:bg-white/10"
                    }`}
                  title={
                    autoExecuteEnabled
                      ? "Disable auto-execute"
                      : "Enable auto-execute (skip permission prompts)"
                  }
                >
                  {panelNarrow ? "Exec" : "Auto Exec " + (autoExecuteEnabled ? "ON" : "OFF")}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                  }}
                  className={`text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 flex items-center gap-1 ${isLight
                    ? "text-gray-500 hover:text-gray-900 hover:bg-gray-200/60"
                    : "text-gray-400 hover:text-white hover:bg-white/10"
                    }`}
                  title="Minimize panel (Cmd+.)"
                >
                  <Minimize2 className="w-3 h-3" />
                  {!panelNarrow && <span className="uppercase tracking-wider">Min</span>}
                </button>
              </div>
            )}

            {/* Show simple expand hint when collapsed */}
            {!isExpanded && (
              <span className="text-[10px] opacity-50 uppercase tracking-widest">
                Click to Expand
              </span>
            )}
          </div>

          {/* Thread History - Only show when expanded */}
          {isExpanded && (panelSteps.length > 0 || isAgentRunning) && (
            <div className="flex-1 relative min-h-0">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto p-4 space-y-4 font-mono text-xs scrollbar-thin scrollbar-thumb-gray-700"
              >
                {(() => {
                  // Group steps into runs by separator, tracking global indices
                  const runs: { title: string; steps: { step: AgentStep; globalIdx: number }[] }[] = [];
                  for (let gi = 0; gi < panelSteps.length; gi++) {
                    const step = panelSteps[gi];
                    if (step.step === "separator") {
                      runs.push({ title: step.output, steps: [] });
                    } else {
                      if (runs.length === 0)
                        runs.push({ title: "Agent Session", steps: [] });
                      runs[runs.length - 1].steps.push({ step, globalIdx: gi });
                    }
                  }

                  const renderStep = (step: AgentStep, key: string, globalIdx: number) => {
                    const isError =
                      step.step === "error" || step.step === "failed";
                    const isDone = step.step === "done";
                    const isQuestion = step.step === "question";
                    const isExecuted = step.step === "executed";
                    const isExecuting = step.step === "executing";
                    const isThinkingStep = step.step === "thinking";
                    const isThought = step.step === "thought";
                    const isStreamingStep = step.step === "streaming";
                    const streamInfo = isStreamingStep
                      ? describeStreamingContent(step.output)
                      : null;
                    const isCollapsed = isExecuted && collapsedSteps.has(globalIdx);

                    return (
                      <div
                        key={key}
                        className={`border-l-2 pl-4 py-2 ${isError
                          ? isLight
                            ? "border-red-300"
                            : "border-red-500/30"
                          : isDone
                            ? isLight
                              ? "border-green-300"
                              : "border-green-500/30"
                            : isQuestion
                              ? isLight
                                ? "border-amber-300"
                                : "border-amber-500/30"
                              : isExecuting
                                ? isLight
                                  ? "border-amber-300"
                                  : "border-amber-500/30"
                                : isExecuted
                                  ? isLight
                                    ? "border-blue-300"
                                    : "border-blue-500/30"
                                  : isThinkingStep || isThought
                                    ? isLight
                                      ? "border-purple-300"
                                      : "border-purple-500/30"
                                    : isStreamingStep
                                      ? isLight
                                        ? "border-cyan-300"
                                        : "border-cyan-500/30"
                                      : isLight
                                        ? "border-gray-200"
                                        : "border-white/10"
                          }`}
                      >
                        <div
                          className={`flex items-center gap-1.5 mb-0.5 ${isExecuted ? "cursor-pointer select-none" : ""}`}
                          onClick={isExecuted ? () => toggleStepCollapse(globalIdx) : undefined}
                        >
                          {isExecuted && (
                            <span className={`text-[9px] opacity-50 transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
                          )}
                          {isError ? (
                            <AlertTriangle className="w-3 h-3 text-red-400" />
                          ) : isDone ? (
                            <Check className="w-3 h-3 text-green-400" />
                          ) : isQuestion ? (
                            <Brain className="w-3 h-3 text-amber-400" />
                          ) : isExecuting ? (
                            <TerminalIcon className="w-3 h-3 text-amber-400 animate-pulse" />
                          ) : isExecuted ? (
                            <Check className="w-3 h-3 text-blue-400" />
                          ) : isThinkingStep || isThought ? (
                            <Brain
                              className={`w-3 h-3 text-purple-400 ${isThinkingStep ? "animate-pulse" : ""}`}
                            />
                          ) : isStreamingStep ? (
                            <TerminalIcon className="w-3 h-3 text-cyan-400 animate-pulse" />
                          ) : (
                            <TerminalIcon className="w-3 h-3 text-gray-400 opacity-60" />
                          )}
                          <span
                            className={`uppercase font-bold text-[10px] tracking-wider ${isExecuting
                              ? "text-amber-400"
                              : isExecuted
                                ? "text-blue-400"
                                : isError
                                  ? "text-red-400"
                                  : isDone
                                    ? "text-green-400"
                                    : isQuestion
                                      ? "text-amber-400"
                                      : isThinkingStep || isThought
                                        ? "text-purple-400"
                                        : isStreamingStep
                                          ? "text-cyan-400"
                                          : "text-gray-500"
                              }`}
                          >
                            {isExecuting
                              ? "running..."
                              : isThinkingStep
                                ? "thinking..."
                                : isStreamingStep
                                  ? `${streamInfo!.label}...`
                                  : step.step}
                          </span>
                          {isCollapsed && (
                            <span className={`text-[10px] truncate flex-1 min-w-0 ${isLight ? "text-gray-400" : "text-gray-500"}`}>
                              {step.output.split("\n")[0].slice(0, 120)}
                            </span>
                          )}
                          {(isThinkingStep || isStreamingStep || isExecuting) && (
                            <div className="flex gap-0.5 ml-1">
                              <div
                                className={`w-1 h-1 rounded-full animate-bounce ${isThinkingStep ? "bg-purple-400" : isExecuting ? "bg-amber-400" : "bg-cyan-400"}`}
                                style={{ animationDelay: "0ms" }}
                              />
                              <div
                                className={`w-1 h-1 rounded-full animate-bounce ${isThinkingStep ? "bg-purple-400" : isExecuting ? "bg-amber-400" : "bg-cyan-400"}`}
                                style={{ animationDelay: "150ms" }}
                              />
                              <div
                                className={`w-1 h-1 rounded-full animate-bounce ${isThinkingStep ? "bg-purple-400" : isExecuting ? "bg-amber-400" : "bg-cyan-400"}`}
                                style={{ animationDelay: "300ms" }}
                              />
                            </div>
                          )}
                        </div>
                        {/* Output — hidden when collapsed */}
                        {isCollapsed ? null : isThinkingStep || isThought ? (
                          <ThinkingBlock
                            content={step.output}
                            isLight={isLight}
                            isStreaming={isThinkingStep}
                          />
                        ) : isStreamingStep ? (
                          (() => {
                            // Show detail if available (only when JSON fully parsed)
                            if (streamInfo?.detail) {
                              return (
                                <code
                                  className={`block text-[11px] whitespace-pre-wrap truncate ${isLight ? "text-gray-500" : "text-gray-400"} opacity-70`}
                                >
                                  {streamInfo.detail}
                                </code>
                              );
                            }
                            // For planning/composing states, show streaming content in a collapsible block
                            if (
                              (streamInfo?.label?.startsWith("Planning") || streamInfo?.label === "Composing answer") &&
                              step.output.length > 0
                            ) {
                              return (
                                <PlanningBlock
                                  content={step.output}
                                  label={streamInfo.label}
                                  isLight={isLight}
                                />
                              );
                            }
                            // For text responses, show a scrolling preview of the last portion
                            if (
                              streamInfo?.label === "Responding" &&
                              step.output.length > 0
                            ) {
                              const preview =
                                step.output.length > 200
                                  ? step.output.slice(-200)
                                  : step.output;
                              const tokenCount = Math.round(
                                step.output.length / 4,
                              );

                              return (
                                <div
                                  className={`mt-1 max-h-24 overflow-hidden rounded border p-2 ${isLight
                                    ? "bg-gray-50/50 border-gray-200/50"
                                    : "bg-white/[0.02] border-white/5"
                                    }`}
                                >
                                  <div className="flex justify-between items-center mb-1">
                                    <span
                                      className={`text-[9px] font-semibold uppercase ${isLight ? "text-gray-400" : "text-gray-500"}`}
                                    >
                                      Live Output
                                    </span>
                                    <span
                                      className={`text-[9px] font-mono ${isLight ? "text-gray-400" : "text-gray-600"}`}
                                    >
                                      {tokenCount} tokens
                                    </span>
                                  </div>
                                  <MarkdownContent
                                    content={preview}
                                    className={`text-[11px] leading-relaxed ${isLight ? "text-gray-600" : "text-gray-400"}`}
                                  />
                                </div>
                              );
                            }
                            return null;
                          })()
                        ) : step.output.length > 120 ? (
                          <details className="group" open>
                            <summary
                              className={`cursor-pointer text-[11px] truncate select-none list-none flex items-center gap-1.5 ${isLight
                                ? "text-gray-500 hover:text-gray-900"
                                : "text-gray-400 hover:text-white"
                                }`}
                            >
                              <span className="text-[9px] opacity-50 group-open:rotate-90 transition-transform">
                                ▶
                              </span>
                              {step.output.slice(0, 80)}...
                            </summary>
                            <pre
                              className={`mt-1 p-2 rounded border text-[11px] leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-40 ${isLight
                                ? "bg-gray-50 border-gray-200 text-gray-800"
                                : "bg-black/40 border-white/5 text-gray-300"
                                }`}
                            >
                              {step.output}
                            </pre>
                          </details>
                        ) : (
                          <code
                            className={`block text-[11px] whitespace-pre-wrap ${isLight ? "text-gray-600" : "text-gray-400"}`}
                          >
                            {step.output}
                          </code>
                        )}
                      </div>
                    );
                  };

                  return runs.map((run, runIdx) => {
                    const isLastRun = runIdx === runs.length - 1;
                    // Compact title: take first line, truncate to 80 chars
                    const firstLine = run.title.split("\n")[0].trim();
                    const displayTitle =
                      firstLine.slice(0, 80) +
                      (firstLine.length > 80 ? "..." : "");

                    // Previous runs: collapsed by default
                    if (!isLastRun) {
                      // Find result status for summary
                      const lastStepEntry = run.steps[run.steps.length - 1];
                      const lastStepType = lastStepEntry?.step.step;
                      const statusIcon =
                        lastStepType === "done"
                          ? "✓"
                          : lastStepType === "error" ||
                            lastStepType === "failed"
                            ? "✗"
                            : "—";
                      const statusColor =
                        lastStepType === "done"
                          ? isLight
                            ? "text-green-600"
                            : "text-green-400"
                          : lastStepType === "error" ||
                            lastStepType === "failed"
                            ? isLight
                              ? "text-red-600"
                              : "text-red-400"
                            : isLight
                              ? "text-gray-400"
                              : "text-gray-500";

                      return (
                        <details key={`run-${runIdx}`} className="group/run">
                          <summary
                            className={`flex items-center gap-1.5 py-1 cursor-pointer select-none list-none`}
                          >
                            <span className="text-[9px] opacity-50 group-open/run:rotate-90 transition-transform">
                              ▶
                            </span>
                            <span
                              className={`text-[10px] font-semibold ${statusColor}`}
                            >
                              {statusIcon}
                            </span>
                            <span
                              className={`text-[10px] truncate flex-1 min-w-0 ${isLight ? "text-gray-400" : "text-gray-500"}`}
                            >
                              {displayTitle}
                            </span>
                          </summary>
                          <div className="space-y-1.5 pb-1">
                            {run.steps.map((s, si) =>
                              renderStep(s.step, `${runIdx}-${si}`, s.globalIdx),
                            )}
                          </div>
                        </details>
                      );
                    }

                    // Current (last) run: fully expanded
                    return (
                      <div key={`run-${runIdx}`}>
                        {/* Run title — minimal left-aligned label */}
                        <div className="flex items-center gap-1.5 py-1">
                          <Bot className="w-3 h-3 text-purple-400 opacity-60 shrink-0" />
                          <span
                            className={`text-[10px] truncate flex-1 min-w-0 ${isLight ? "text-gray-400" : "text-gray-500"}`}
                          >
                            {displayTitle}
                          </span>
                        </div>
                        {run.steps.map((s, si) =>
                          renderStep(s.step, `${runIdx}-${si}`, s.globalIdx),
                        )}
                      </div>
                    );
                  });
                })()}

                {/* Inline thinking indicator — shown when waiting and no streaming step visible yet */}
                {isAgentRunning &&
                  isThinking &&
                  (!panelSteps.length ||
                    (panelSteps[panelSteps.length - 1]?.step !== "thinking" &&
                      panelSteps[panelSteps.length - 1]?.step !==
                      "streaming")) && (
                    <div
                      className={`border-l-2 pl-3 py-1 ${isLight ? "border-purple-300" : "border-purple-500/30"}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Brain className="w-3 h-3 text-purple-400 animate-pulse" />
                        <span className="uppercase font-bold text-[10px] tracking-wider text-purple-400">
                          thinking...
                        </span>
                        <div className="flex gap-0.5 ml-1">
                          <div
                            className="w-1 h-1 bg-purple-400 rounded-full animate-bounce"
                            style={{ animationDelay: "0ms" }}
                          />
                          <div
                            className="w-1 h-1 bg-purple-400 rounded-full animate-bounce"
                            style={{ animationDelay: "150ms" }}
                          />
                          <div
                            className="w-1 h-1 bg-purple-400 rounded-full animate-bounce"
                            style={{ animationDelay: "300ms" }}
                          />
                        </div>
                      </div>
                    </div>
                  )}
              </div>

              {/* Scroll to bottom button — shown when user has scrolled up */}
              <AnimatePresence>
                {userScrolledUp && isAgentRunning && (
                  <motion.button
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.15 }}
                    onClick={scrollToBottom}
                    className={`absolute bottom-2 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-[10px] font-medium shadow-lg z-10 transition-colors ${isLight
                      ? "bg-gray-100 hover:bg-gray-200 text-gray-600 border border-gray-300"
                      : "bg-white/10 hover:bg-white/15 text-gray-300 border border-white/10 backdrop-blur-sm"
                      }`}
                  >
                    ↓ Scroll to bottom
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Permission Request - Only show when expanded */}
          <AnimatePresence>
            {isExpanded && pendingCommand && (
              <motion.div
                key="permission"
                variants={slideUp}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="shrink-0"
              >
                <PermissionRequest
                  command={pendingCommand}
                  isLight={isLight}
                  onPermission={onPermission}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </>
  );
};

export default AgentOverlay;
