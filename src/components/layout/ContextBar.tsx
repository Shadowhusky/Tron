import React, { useState, useEffect, useRef } from "react";
import { useLayout } from "../../contexts/LayoutContext";
import { aiService } from "../../services/ai";
import { useTheme } from "../../contexts/ThemeContext";
import { Folder, X, Loader2 } from "lucide-react";
import { useAgent } from "../../contexts/AgentContext";

// SVG Ring component for context usage visualization
const ContextRing: React.FC<{ percent: number; size?: number }> = ({
  percent,
  size = 14,
}) => {
  const r = (size - 2) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;
  const color =
    percent > 80
      ? "#ef4444" // red
      : percent > 50
        ? "#eab308" // yellow
        : "#a855f7"; // purple

  return (
    <svg width={size} height={size} className="shrink-0">
      {/* Background ring */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="opacity-20"
      />
      {/* Filled arc */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="transition-all duration-500"
      />
    </svg>
  );
};

// Strip ANSI escape sequences, terminal control codes, and clean up output
function stripAnsi(text: string): string {
  return text
    // Standard ANSI escape codes (colors, cursor, etc.)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    // OSC sequences (title, etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Character set switching
    .replace(/\x1b[()][AB012]/g, "")
    // DEC private modes like [?2004h, [?2004l
    .replace(/\[?\?[0-9;]*[a-zA-Z]/g, "")
    // Remaining non-printable control chars (keep \n and \r)
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "")
    // Collapse 3+ blank lines into 2
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ContextBarProps {
  sessionId: string;
}

const ContextBar: React.FC<ContextBarProps> = ({ sessionId }) => {
  const { sessions, updateSessionConfig } = useLayout();
  const { resolvedTheme: theme } = useTheme();
  const { agentThread, isOverlayVisible, setIsOverlayVisible } =
    useAgent(sessionId);

  // Derived state
  const session = sessions.get(sessionId);
  const cwd = session?.cwd || "~/";
  const activeModel = session?.aiConfig?.model || aiService.getConfig().model;
  const maxContext =
    session?.aiConfig?.contextWindow ||
    aiService.getConfig().contextWindow ||
    4000;

  // Poll for context length (history size)
  const [contextLength, setContextLength] = useState(0);
  const [contextText, setContextText] = useState("");
  const [showContextInfo, setShowContextInfo] = useState(false);
  const [showContextModal, setShowContextModal] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSummarized, setIsSummarized] = useState(false);
  const isSummarizedRef = useRef(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [availableModels, setAvailableModels] = useState<
    { name: string; provider: string }[]
  >([]);

  useEffect(() => {
    aiService.getModels().then(setAvailableModels);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const pollHistory = async () => {
      if (window.electron) {
        const history = await window.electron.ipcRenderer.invoke(
          "terminal.getHistory",
          sessionId,
        );
        setContextLength(history.length);
        // Only update display text if not currently showing a summary
        if (!isSummarizedRef.current) {
          setContextText(stripAnsi(history));
        }
      }
    };
    pollHistory();
    const interval = setInterval(pollHistory, 3000);
    return () => clearInterval(interval);
  }, [sessionId]);

  const handleOpenContextModal = () => setShowContextModal(true);

  const handleSummarize = async (level: "brief" | "moderate" | "detailed") => {
    setIsSummarizing(true);
    try {
      const maxChars = level === "brief" ? 500 : level === "moderate" ? 2000 : 4000;
      const input = contextText.slice(0, maxChars * 2);
      const summary = await aiService.summarizeContext(input);
      setContextText(summary);
      setIsSummarized(true);
      isSummarizedRef.current = true;
    } catch (e) {
      console.error("Summarization failed", e);
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleResetContext = async () => {
    if (window.electron) {
      const history = await window.electron.ipcRenderer.invoke(
        "terminal.getHistory",
        sessionId,
      );
      setContextText(stripAnsi(history));
      setIsSummarized(false);
      isSummarizedRef.current = false;
    }
  };

  const displayCwd = cwd.replace(/\/Users\/[^/]+/, "~");
  const contextPercent = Math.min(
    100,
    Math.round((contextLength / maxContext) * 100),
  );

  return (
    <div
      className={`w-full h-8 border-t flex items-center justify-between px-3 transition-all duration-200 select-none shrink-0 ${
        theme === "dark"
          ? "bg-[#0a0a0a] border-white/5 text-gray-500"
          : theme === "modern"
            ? "bg-black/60 border-white/5 text-gray-400 backdrop-blur-md"
            : "bg-gray-50 border-gray-200 text-gray-500"
      }`}
    >
      {/* Left: Identity + Path */}
      <div className="flex items-center gap-4 max-w-[50%] overflow-hidden">
        <span className="text-[10px] uppercase tracking-wider font-bold opacity-40">
          Context & Status
        </span>
        <div className="h-3 w-px bg-current opacity-20" />

        <div
          className="flex items-center gap-1.5 overflow-hidden cursor-default"
          title={`Current directory: ${cwd}`}
        >
          <Folder className="w-3 h-3 opacity-60" />
          <span className="truncate opacity-80 hover:opacity-100 transition-opacity text-[10px]">
            {displayCwd}
          </span>
        </div>

        {/* Agent Toggle Button */}
        {agentThread.length > 0 && !isOverlayVisible && (
          <button
            onClick={() => setIsOverlayVisible(true)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors animate-in fade-in"
            title="Show Agent Panel (Cmd+.)"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
            <span className="text-[10px]">Show Agent</span>
            <span className="text-[9px] opacity-50 ml-0.5">&#8984;.</span>
          </button>
        )}
      </div>

      {/* Right: Context Ring + Model */}
      <div className="flex items-center gap-4">
        {/* Context Ring with Popover — click opens modal */}
        <div
          className="relative flex items-center gap-1 opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
          onMouseEnter={() => setShowContextInfo(true)}
          onMouseLeave={() => setShowContextInfo(false)}
          onClick={handleOpenContextModal}
        >
          <ContextRing percent={contextPercent} size={12} />
          <span className="text-[10px]">{contextPercent}%</span>

          {/* Context Popover */}
          {showContextInfo && (
            <div className="absolute bottom-full right-0 mb-3 w-48 p-2 rounded-lg bg-[#1a1a1a] border border-white/10 shadow-xl z-100 animate-in fade-in slide-in-from-bottom-1">
              <div className="text-xs font-semibold text-gray-200 mb-1">
                Context Usage
              </div>
              <div className="flex justify-between text-[10px] text-gray-400">
                <span>Used:</span>
                <span>{contextLength.toLocaleString()} chars</span>
              </div>
              <div className="flex justify-between text-[10px] text-gray-400">
                <span>Limit:</span>
                <span>{maxContext.toLocaleString()} chars</span>
              </div>
              <div className="mt-1 w-full bg-white/10 h-1 rounded-full overflow-hidden">
                <div
                  className={`h-full ${contextPercent > 90 ? "bg-red-500" : "bg-blue-500"}`}
                  style={{ width: `${contextPercent}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="h-3 w-px bg-current opacity-20" />

        {/* Model Switcher */}
        <div className="relative">
          <div
            className="flex items-center gap-1 opacity-70 hover:opacity-100 transition-opacity cursor-pointer text-purple-400 text-[10px]"
            onClick={() => setShowModelMenu(!showModelMenu)}
          >
            <span className="font-semibold">{activeModel}</span>
          </div>

          {/* Model Menu */}
          {showModelMenu && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowModelMenu(false)}
              />
              <div className="absolute bottom-full right-0 mb-3 w-48 py-1 rounded-lg bg-[#1a1a1a] border border-white/10 shadow-xl z-50 max-h-60 overflow-y-auto">
                <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-gray-500 font-semibold border-b border-white/5 mb-1">
                  Select Model
                </div>
                {availableModels.map((m) => (
                  <button
                    key={`${m.provider}-${m.name}`}
                    onClick={() => {
                      updateSessionConfig(sessionId, {
                        provider: m.provider as any,
                        model: m.name,
                      });
                      setShowModelMenu(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 flex items-center justify-between group ${activeModel === m.name ? "text-purple-400 bg-purple-500/10" : "text-gray-400"}`}
                  >
                    <span>{m.name}</span>
                    <span className="text-[9px] opacity-30 uppercase">
                      {m.provider}
                    </span>
                  </button>
                ))}
                {availableModels.length === 0 && (
                  <div className="px-3 py-2 text-gray-500 text-center italic">
                    No models found
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Context Modal */}
      {showContextModal && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowContextModal(false)}
          />
          <div
            className={`fixed inset-x-4 top-12 bottom-12 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[700px] z-50 flex flex-col rounded-xl shadow-2xl border overflow-hidden ${
              theme === "dark"
                ? "bg-[#0e0e0e] border-white/10 text-gray-200"
                : theme === "modern"
                  ? "bg-[#0a0a20] border-purple-500/20 text-gray-200"
                  : "bg-white border-gray-200 text-gray-900"
            }`}
          >
            {/* Modal Header */}
            <div
              className={`flex items-center justify-between px-4 py-3 border-b shrink-0 ${
                theme === "light" ? "border-gray-200 bg-gray-50" : "border-white/5 bg-white/5"
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">Session Context</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                  theme === "light" ? "bg-gray-100 text-gray-500" : "bg-white/10 text-gray-400"
                }`}>
                  {contextText.length.toLocaleString()} chars
                </span>
              </div>
              <button
                onClick={() => setShowContextModal(false)}
                className={`p-1 rounded-md transition-colors ${
                  theme === "light" ? "hover:bg-gray-200 text-gray-500" : "hover:bg-white/10 text-gray-400"
                }`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Summarize Controls */}
            <div
              className={`flex items-center gap-2 px-4 py-2 border-b shrink-0 ${
                theme === "light" ? "border-gray-100 bg-gray-50/50" : "border-white/5 bg-white/2"
              }`}
            >
              <span className={`text-[10px] uppercase tracking-wider font-semibold mr-1 ${
                theme === "light" ? "text-gray-400" : "text-gray-500"
              }`}>
                Summarize:
              </span>
              {(["brief", "moderate", "detailed"] as const).map((level) => (
                <button
                  key={level}
                  disabled={isSummarizing}
                  onClick={() => handleSummarize(level)}
                  className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                    isSummarizing
                      ? "opacity-50 cursor-not-allowed"
                      : theme === "light"
                        ? "border-gray-200 hover:bg-gray-100 text-gray-600"
                        : "border-white/10 hover:bg-white/5 text-gray-400"
                  }`}
                >
                  {level}
                </button>
              ))}
              {isSummarizing && <Loader2 className="w-3 h-3 animate-spin text-purple-400 ml-1" />}
              <div className="flex-1" />
              <button
                onClick={handleResetContext}
                disabled={!isSummarized}
                className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                  !isSummarized
                    ? "opacity-30 cursor-not-allowed border-white/5 text-gray-600"
                    : theme === "light"
                      ? "border-gray-200 hover:bg-gray-100 text-gray-500"
                      : "border-white/10 hover:bg-white/5 text-gray-500"
                }`}
              >
                Reset to raw
              </button>
            </div>

            {/* Context Content */}
            <pre
              className={`flex-1 overflow-auto p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap ${
                theme === "light" ? "text-gray-700" : "text-gray-300"
              }`}
            >
              {contextText || "(No context yet)"}
            </pre>
          </div>
        </>
      )}
    </div>
  );
};

export default ContextBar;
