import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Command,
  Check,
  X,
  AlertTriangle,
  Terminal as TerminalIcon,
  Brain,
} from "lucide-react";
import { marked } from "marked";
import { useTheme } from "../../../contexts/ThemeContext";
import type { AgentStep } from "../../../types";

// Configure marked for minimal, safe output
marked.setOptions({ breaks: true, gfm: true });

/** Renders markdown string as HTML. Memoized to avoid re-parsing identical content. */
const MarkdownContent: React.FC<{ content: string; className?: string }> = ({ content, className }) => {
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
      className={`flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg text-xs font-mono max-w-sm animate-in fade-in slide-in-from-right-3 border ${
        type === "error"
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
}) => {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // Auto-scroll thread to bottom — also triggers during streaming thinking updates
  const lastEntry = agentThread[agentThread.length - 1];
  const scrollTrigger = `${agentThread.length}:${lastEntry?.output?.length || 0}`;
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [scrollTrigger]);

  // Reset toasts on new run
  useEffect(() => {
    if (agentThread.length === 0) setToasts([]);
  }, [agentThread.length]);

  const dismissToast = useCallback((id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id)), []);

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
          if (last.step === "done") return "Task Completed";
          return "Task Completed";
        })();

  // Steps to show in panel: everything except transient "executing"
  const panelSteps = agentThread.filter((s) => s.step !== "executing");

  const showPanel = isAgentRunning || isThinking || pendingCommand || panelSteps.length > 0;

  if (!showPanel && toasts.length === 0) return null;

  return (
    <>
      {/* Toast stack — top right of session */}
      {toasts.length > 0 && (
        <div className="absolute top-2 right-2 z-30 flex flex-col gap-1.5 pointer-events-auto">
          {toasts.slice(-4).map((t) => (
            <AgentToast
              key={t.id}
              message={t.message}
              type={t.type}
              isLight={isLight}
              onDismiss={() => dismissToast(t.id)}
            />
          ))}
        </div>
      )}

      {/* Agent Panel */}
      {showPanel && (
        <div
          className={`w-full max-h-[60%] overflow-hidden border-t flex flex-col shadow-lg z-20 transition-all animate-in slide-in-from-bottom-2 ${
            isLight
              ? "bg-white/95 border-gray-200 text-gray-900"
              : resolvedTheme === "modern"
                ? "bg-[#0a0a1a]/80 border-white/[0.08] text-white backdrop-blur-2xl"
                : "bg-[#0a0a0a]/95 border-white/10 text-white"
          }`}
        >
          {/* Status Header */}
          <div
            className={`flex items-center justify-between px-4 py-1.5 border-b shrink-0 ${
              isLight ? "border-gray-200/80 bg-gray-50/60" : "border-white/5 bg-white/5"
            }`}
          >
            <div className="flex items-center gap-2">
              {isThinking ? (
                <div className="flex gap-1">
                  <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              ) : (
                <div className={`w-2 h-2 rounded-full ${isAgentRunning ? "bg-green-400 animate-pulse" : "bg-gray-500"}`} />
              )}
              <span className={`text-xs font-medium ${isLight ? "text-purple-700" : "text-purple-200"}`}>
                {statusText}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onToggleThinking}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors flex items-center gap-1 ${
                  thinkingEnabled
                    ? isLight
                      ? "border-purple-300 text-purple-600 bg-purple-50 hover:bg-purple-100"
                      : "border-purple-500/30 text-purple-400 bg-purple-500/10 hover:bg-purple-500/20"
                    : isLight
                      ? "border-gray-300 text-gray-500 bg-gray-50 hover:bg-gray-100"
                      : "border-white/10 text-gray-500 bg-white/5 hover:bg-white/10"
                }`}
                title={thinkingEnabled ? "Disable thinking (faster responses)" : "Enable thinking (more thorough reasoning)"}
              >
                <Brain className="w-3 h-3" />
                Think {thinkingEnabled ? "ON" : "OFF"}
              </button>
              {autoExecuteEnabled && (
                <button
                  onClick={onToggleAutoExecute}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                    isLight
                      ? "border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100"
                      : "border-orange-500/30 text-orange-400 bg-orange-500/10 hover:bg-orange-500/20"
                  }`}
                  title="Disable auto-execute and require permission for each command"
                >
                  Auto-Execute ON
                </button>
              )}
              {panelSteps.length > 0 && (
                <button
                  onClick={onClose}
                  className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded transition-colors ${
                    isLight
                      ? "text-gray-500 hover:text-gray-900 hover:bg-gray-200/60"
                      : "text-gray-400 hover:text-white hover:bg-white/10"
                  }`}
                  title="Minimize panel (Cmd+.)"
                >
                  Minimize <span className="opacity-50 ml-0.5">&#8984;.</span>
                </button>
              )}
            </div>
          </div>

          {/* Thread History */}
          {panelSteps.length > 0 && (
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-xs scrollbar-thin scrollbar-thumb-gray-700"
            >
              {panelSteps.map((step, i) => {
                // Run separator
                if (step.step === "separator") {
                  return (
                    <div key={i} className="flex items-center gap-2 py-2 my-1">
                      <div className={`flex-1 h-px ${isLight ? "bg-gray-200" : "bg-white/10"}`} />
                      <span className={`text-[9px] uppercase tracking-wider font-semibold px-2 ${isLight ? "text-gray-400" : "text-gray-500"}`}>
                        New Run: {step.output.slice(0, 40)}{step.output.length > 40 ? "..." : ""}
                      </span>
                      <div className={`flex-1 h-px ${isLight ? "bg-gray-200" : "bg-white/10"}`} />
                    </div>
                  );
                }

                const isError = step.step === "error" || step.step === "failed";
                const isDone = step.step === "done";
                const isExecuted = step.step === "executed";
                const isThinkingStep = step.step === "thinking";
                const isThought = step.step === "thought";

                return (
                  <div
                    key={i}
                    className={`border-l-2 pl-3 py-1 ${
                      isError
                        ? isLight ? "border-red-300" : "border-red-500/30"
                        : isDone
                          ? isLight ? "border-green-300" : "border-green-500/30"
                          : isExecuted
                            ? isLight ? "border-blue-300" : "border-blue-500/30"
                            : (isThinkingStep || isThought)
                              ? isLight ? "border-purple-300" : "border-purple-500/30"
                              : isLight ? "border-gray-200" : "border-white/10"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      {isError ? (
                        <AlertTriangle className="w-3 h-3 text-red-400" />
                      ) : isDone ? (
                        <Check className="w-3 h-3 text-green-400" />
                      ) : isExecuted ? (
                        <Check className="w-3 h-3 text-blue-400" />
                      ) : (isThinkingStep || isThought) ? (
                        <Brain className={`w-3 h-3 text-purple-400 ${isThinkingStep ? "animate-pulse" : ""}`} />
                      ) : (
                        <TerminalIcon className="w-3 h-3 text-gray-400 opacity-60" />
                      )}
                      <span
                        className={`uppercase font-bold text-[10px] tracking-wider ${
                          isExecuted ? "text-blue-400"
                            : isError ? "text-red-400"
                            : isDone ? "text-green-400"
                            : (isThinkingStep || isThought) ? "text-purple-400"
                            : "text-gray-500"
                        }`}
                      >
                        {isThinkingStep ? "thinking..." : step.step}
                      </span>
                      {isThinkingStep && (
                        <div className="flex gap-0.5 ml-1">
                          <div className="w-1 h-1 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                          <div className="w-1 h-1 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                          <div className="w-1 h-1 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                      )}
                    </div>
                    {/* Output: markdown for thinking/thought, collapsible for long content */}
                    {(isThinkingStep || isThought) ? (
                      <div className={`mt-1 rounded border p-2 ${
                        isLight
                          ? "bg-purple-50/50 border-purple-200/50"
                          : "bg-purple-950/20 border-purple-500/10"
                      }`}>
                        <MarkdownContent
                          content={step.output}
                          className={`text-[11px] leading-relaxed ${isLight ? "text-gray-700" : "text-gray-300"}`}
                        />
                      </div>
                    ) : step.output.length > 120 ? (
                      <details className="group">
                        <summary
                          className={`cursor-pointer text-[11px] truncate select-none list-none flex items-center gap-1.5 ${
                            isLight ? "text-gray-500 hover:text-gray-900" : "text-gray-400 hover:text-white"
                          }`}
                        >
                          <span className="text-[9px] opacity-50 group-open:rotate-90 transition-transform">▶</span>
                          {step.output.slice(0, 80)}...
                        </summary>
                        <pre
                          className={`mt-1 p-2 rounded border text-[11px] leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-40 ${
                            isLight
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
              })}
            </div>
          )}

          {/* Permission Request */}
          {pendingCommand && (
            <div
              className={`p-4 border-t animate-in fade-in slide-in-from-bottom-2 ${
                isLight ? "bg-blue-50/80 border-blue-200" : "bg-blue-900/20 border-blue-500/20"
              }`}
            >
              <div className={`text-sm mb-2 font-medium flex items-center gap-2 ${isLight ? "text-blue-700" : "text-blue-200"}`}>
                <Command className="w-4 h-4" />
                Allow command execution?
              </div>
              <code
                className={`block p-3 rounded text-xs font-mono mb-3 border break-all ${
                  isLight ? "bg-white border-blue-200 text-blue-800" : "bg-black/50 border-blue-500/10 text-blue-100"
                }`}
              >
                {pendingCommand}
              </code>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => onPermission("deny")}
                  className={`px-4 py-2 text-xs rounded-md border transition-colors flex items-center gap-1.5 ${
                    isLight
                      ? "bg-white hover:bg-gray-50 text-gray-600 border-gray-300"
                      : "bg-transparent hover:bg-white/5 text-white/60 border-white/10"
                  }`}
                >
                  <X className="w-3 h-3" /> Deny
                </button>
                <button
                  onClick={() => onPermission("always")}
                  className={`px-4 py-2 text-xs rounded-md border transition-colors ${
                    isLight
                      ? "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-300"
                      : "bg-blue-900/30 hover:bg-blue-900/50 text-blue-200 border-blue-500/20"
                  }`}
                >
                  Always Allow
                </button>
                <button
                  onClick={() => onPermission("allow")}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-md transition-colors flex items-center gap-1.5 shadow-lg shadow-blue-900/20"
                >
                  <Check className="w-3 h-3" /> Allow Once
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default AgentOverlay;
