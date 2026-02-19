import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useLayout } from "../../contexts/LayoutContext";
import { aiService, providerUsesBaseUrl } from "../../services/ai";
import { STORAGE_KEYS } from "../../constants/storage";
import { useTheme } from "../../contexts/ThemeContext";
import { Folder, X, Loader2 } from "lucide-react";
import { useAgent } from "../../contexts/AgentContext";
import { IPC } from "../../constants/ipc";
import { abbreviateHome } from "../../utils/platform";
import { themeClass } from "../../utils/theme";
import { stripAnsi, cleanContextForAI } from "../../utils/contextCleaner";
import { useAllConfiguredModels } from "../../hooks/useModels";

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

interface ContextBarProps {
  sessionId: string;
}

const ContextBar: React.FC<ContextBarProps> = ({ sessionId }) => {
  const { sessions, updateSessionConfig, updateSession } = useLayout();
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
  const [showContextModal, setShowContextModal] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSummarized, setIsSummarized] = useState(!!session?.contextSummary);
  const isSummarizedRef = useRef(!!session?.contextSummary);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showCtxTooltip, setShowCtxTooltip] = useState(false);
  const ctxRingRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLDivElement>(null);
  const { data: availableModels = [] } = useAllConfiguredModels();

  // Auto-select model if current model is empty or unavailable — prefer user's saved choice
  useEffect(() => {
    if (availableModels.length === 0) return;
    const modelStillAvailable = activeModel && availableModels.some((m) => m.name === activeModel);
    if (!modelStillAvailable) {
      // 1. Try to find the user's saved preferred model from provider cache
      let target = availableModels[0];
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.PROVIDER_CONFIGS);
        if (raw) {
          const cache = JSON.parse(raw);
          // Check each available model — prefer one that matches a cached provider's saved model
          for (const m of availableModels) {
            if (cache[m.provider]?.model === m.name) {
              target = m;
              break;
            }
          }
        }
      } catch {}
      // 2. Also check the global saved config (may be more recent than cache)
      const globalCfg = aiService.getConfig();
      const globalMatch = globalCfg.model && availableModels.find((m) => m.name === globalCfg.model);
      if (globalMatch) target = globalMatch;

      let providerCfg: { apiKey?: string; baseUrl?: string } | undefined;
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.PROVIDER_CONFIGS);
        if (raw) providerCfg = JSON.parse(raw)[target.provider];
      } catch {}
      const apiKey = providerCfg?.apiKey || (target.provider === globalCfg.provider ? globalCfg.apiKey : undefined);
      const baseUrl = providerCfg?.baseUrl || (target.provider === globalCfg.provider ? globalCfg.baseUrl : undefined);
      const update: Record<string, any> = { provider: target.provider, model: target.name };
      if (apiKey) update.apiKey = apiKey;
      if (providerUsesBaseUrl(target.provider) && baseUrl) update.baseUrl = baseUrl;
      updateSessionConfig(sessionId, update);
    }
  }, [activeModel, availableModels, sessionId, updateSessionConfig]);

  // Update local state when session changes
  useEffect(() => {
    if (session) {
      setIsSummarized(!!session.contextSummary);
      isSummarizedRef.current = !!session.contextSummary;
    }
  }, [session?.contextSummary]);

  useEffect(() => {
    if (!sessionId) return;
    const pollHistory = async () => {
      if (window.electron) {
        // If we have a summary, we only need to show summary + new content
        // But here we just show raw history if not summarized, or summary if summarized?
        // Actually, user wants to see what the agent sees.

        const history = await window.electron.ipcRenderer.invoke(
          IPC.TERMINAL_GET_HISTORY,
          sessionId,
        );

        setContextLength(history.length);

        // Calculate usage percent
        const percent = (history.length / maxContext) * 100;

        // Auto-summarize at 90%
        if (percent > 90 && !isSummarizing && !isSummarizedRef.current) {
          handleSummarize("moderate");
        }

        // Only update display text if not currently showing a summary
        if (!isSummarizedRef.current) {
          setContextText(stripAnsi(history));
        } else if (session?.contextSummary) {
          // If summarized, show summary + tail?
          // For now, just show the summary to prove it exists
          setContextText(
            session.contextSummary + "\n\n... (plus recent output)",
          );
        }
      }
    };
    pollHistory();
    const interval = setInterval(pollHistory, 3000);
    return () => clearInterval(interval);
  }, [sessionId, maxContext, session?.contextSummary]);

  const handleOpenContextModal = () => setShowContextModal(true);

  const handleSummarize = async (_level: "brief" | "moderate" | "detailed") => {
    if (isSummarizing) return;
    setIsSummarizing(true);
    try {
      // Get full history first
      const history = await window.electron!.ipcRenderer.invoke(
        IPC.TERMINAL_GET_HISTORY,
        sessionId,
      );

      // Summarize everything we have so far
      // Summarize everything we have so far
      const cleanedForSummary = cleanContextForAI(history);
      const summary = await aiService.summarizeContext(
        cleanedForSummary.slice(-10000),
      );

      // Update local view
      setContextText(summary);
      setIsSummarized(true);
      isSummarizedRef.current = true;

      // Persist to session
      updateSession(sessionId, {
        contextSummary: summary,
        contextSummarySourceLength: cleanedForSummary.length,
      });
    } catch (e) {
      console.error("Summarization failed", e);
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleResetContext = async () => {
    updateSession(sessionId, {
      contextSummary: undefined,
      contextSummarySourceLength: undefined,
    });
    setIsSummarized(false);
    isSummarizedRef.current = false;
    if (window.electron) {
      const history = await window.electron.ipcRenderer.invoke(
        "terminal.getHistory",
        sessionId,
      );
      setContextText(stripAnsi(history));
    }
  };

  const displayCwd = abbreviateHome(cwd);
  const contextPercent = Math.min(
    100,
    Math.round((contextLength / maxContext) * 100),
  );

  return (
    <div
      data-tutorial="context-bar"
      className={`w-full h-8 border-t flex items-center justify-between px-3 transition-all duration-200 select-none shrink-0 overflow-hidden whitespace-nowrap ${themeClass(
        theme,
        {
          dark: "bg-[#0a0a0a] border-white/5 text-gray-500",
          modern:
            "bg-white/[0.02] border-white/[0.06] text-gray-400 backdrop-blur-2xl",
          light: "bg-gray-50 border-gray-200 text-gray-500",
        },
      )}`}
    >
      {/* Left: Identity + Path */}
      <div className="flex items-center gap-4 min-w-0 overflow-hidden">
        <div
          className="flex items-center gap-1.5 overflow-hidden cursor-pointer group/path"
          title={`Current directory: ${cwd}\nClick to change`}
          onClick={async () => {
            if (!window.electron?.ipcRenderer?.selectFolder) return;
            const selected =
              await window.electron.ipcRenderer.selectFolder(cwd);
            if (selected && sessionId) {
              // cd into the selected directory via the PTY
              window.electron.ipcRenderer.send("terminal.write", {
                id: sessionId,
                data: `cd ${JSON.stringify(selected)}\r`,
              });
            }
          }}
        >
          <Folder className="w-3 h-3 opacity-60 group-hover/path:opacity-100 transition-opacity" />
          <span className="truncate opacity-80 group-hover/path:opacity-100 group-hover/path:underline transition-opacity text-[10px]">
            {displayCwd}
          </span>
        </div>

        {/* Agent Toggle Button */}
        <AnimatePresence>
          {agentThread.length > 0 && !isOverlayVisible && (
            <motion.button
              key="agent-toggle"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.2 }}
              onClick={() => setIsOverlayVisible(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
              title="Show Agent Panel (Cmd+.)"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
              <span className="text-[10px]">Show Agent</span>
              <span className="text-[9px] opacity-50 ml-0.5">&#8984;.</span>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Right: Context Ring + Model */}
      <div className="flex items-center gap-4 shrink-0">
        {/* Context Ring — click opens modal, hover shows tooltip */}
        <div
          ref={ctxRingRef}
          className="relative flex items-center gap-1 opacity-70 hover:opacity-100 hover:scale-110 transition-all duration-200 cursor-pointer"
          onClick={handleOpenContextModal}
          onMouseEnter={() => setShowCtxTooltip(true)}
          onMouseLeave={() => setShowCtxTooltip(false)}
        >
          <ContextRing percent={contextPercent} size={12} />
          <span className="text-[10px]">{contextPercent}%</span>
        </div>
        {/* Context tooltip — portal to escape overflow-hidden */}
        {showCtxTooltip &&
          createPortal(
            <div
              className="fixed z-[999] pointer-events-none"
              style={{
                ...(ctxRingRef.current
                  ? (() => {
                      const rect = ctxRingRef.current!.getBoundingClientRect();
                      return {
                        bottom: window.innerHeight - rect.top + 4,
                        right: window.innerWidth - rect.right,
                      };
                    })()
                  : {}),
              }}
            >
              <div
                className={`px-2 py-1 rounded text-[10px] whitespace-nowrap shadow-lg ${
                  theme === "light"
                    ? "bg-gray-800 text-white"
                    : "bg-[#1a1a1a] text-gray-200 border border-white/10"
                }`}
              >
                {contextLength.toLocaleString()} / {maxContext.toLocaleString()}{" "}
                chars
              </div>
            </div>,
            document.body,
          )}

        <div className="h-3 w-px bg-current opacity-20" />

        {/* Model Switcher */}
        <div ref={modelBtnRef}>
          <div
            className="flex items-center gap-1 opacity-70 hover:opacity-100 transition-opacity cursor-pointer text-purple-400 text-[10px]"
            onClick={() => setShowModelMenu(!showModelMenu)}
          >
            <span className="font-semibold">{activeModel}</span>
          </div>

          {/* Model Menu — portal to escape overflow-hidden */}
          {showModelMenu &&
            createPortal(
              <>
                <div
                  className="fixed inset-0 z-[998]"
                  onClick={() => setShowModelMenu(false)}
                />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.15 }}
                  className={`fixed w-64 py-1 rounded-lg shadow-xl z-[999] max-h-60 overflow-y-auto ${themeClass(
                    theme,
                    {
                      dark: "bg-[#1a1a1a] border border-white/10",
                      modern:
                        "bg-[#12122e]/80 border border-white/[0.08] backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
                      light: "bg-white border border-gray-200",
                    },
                  )}`}
                  style={{
                    ...(modelBtnRef.current
                      ? (() => {
                          const rect =
                            modelBtnRef.current!.getBoundingClientRect();
                          return {
                            bottom: window.innerHeight - rect.top + 6,
                            right: window.innerWidth - rect.right,
                          };
                        })()
                      : {}),
                  }}
                >
                  <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-gray-500 font-semibold border-b border-white/5 mb-1">
                    Select Model
                  </div>
                  {availableModels.map((m) => (
                    <button
                      key={`${m.provider}-${m.name}`}
                      onClick={() => {
                        const update: Record<string, any> = {
                          provider: m.provider as any,
                          model: m.name,
                        };
                        // Resolve apiKey and baseUrl from provider configs or global config
                        const globalCfg = aiService.getConfig();
                        let providerCfg: { apiKey?: string; baseUrl?: string } | undefined;
                        try {
                          const raw = localStorage.getItem("tron_provider_configs");
                          if (raw) providerCfg = JSON.parse(raw)[m.provider];
                        } catch {}
                        const apiKey = providerCfg?.apiKey || (m.provider === globalCfg.provider ? globalCfg.apiKey : undefined);
                        const baseUrl = providerCfg?.baseUrl || (m.provider === globalCfg.provider ? globalCfg.baseUrl : undefined);
                        if (apiKey) update.apiKey = apiKey;
                        if (providerUsesBaseUrl(m.provider) && baseUrl) update.baseUrl = baseUrl;
                        updateSessionConfig(sessionId, update);
                        setShowModelMenu(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 flex items-center gap-2 group ${activeModel === m.name ? "text-purple-400 bg-purple-500/10" : "text-gray-400"}`}
                    >
                      <span className="flex-1 truncate">{m.name}</span>
                      <div className="flex gap-1 shrink-0">
                        {m.capabilities?.map((cap) => (
                          <span
                            key={cap}
                            className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                              cap === "thinking"
                                ? "bg-purple-500/20 text-purple-400"
                                : cap === "vision"
                                  ? "bg-blue-500/20 text-blue-400"
                                  : cap === "tools"
                                    ? "bg-green-500/20 text-green-400"
                                    : "bg-gray-500/20 text-gray-400"
                            }`}
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                      <span className="text-[9px] opacity-30 uppercase shrink-0">
                        {m.provider}
                      </span>
                    </button>
                  ))}
                  {availableModels.length === 0 && (
                    <div className="px-3 py-2 text-gray-500 text-center italic">
                      No models found
                    </div>
                  )}
                </motion.div>
              </>,
              document.body,
            )}
        </div>
      </div>

      {/* Context Modal — portal to body to escape stacking contexts */}
      {showContextModal &&
        createPortal(
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-black/50 z-[999]"
              onClick={() => setShowContextModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className={`fixed inset-x-4 top-12 bottom-12 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[700px] z-[999] flex flex-col rounded-xl shadow-2xl border overflow-hidden ${themeClass(
                theme,
                {
                  dark: "bg-[#0e0e0e] border-white/10 text-gray-200",
                  modern:
                    "bg-[#0a0a1e]/80 border-white/[0.08] text-gray-200 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
                  light: "bg-white border-gray-200 text-gray-900",
                },
              )}`}
            >
              {/* Modal Header */}
              <div
                className={`flex items-center justify-between px-4 py-3 border-b shrink-0 ${
                  theme === "light"
                    ? "border-gray-200 bg-gray-50"
                    : "border-white/5 bg-white/5"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold">Session Context</span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full ${
                      theme === "light"
                        ? "bg-gray-100 text-gray-500"
                        : "bg-white/10 text-gray-400"
                    }`}
                  >
                    {contextText.length.toLocaleString()} chars
                  </span>
                </div>
                <button
                  onClick={() => setShowContextModal(false)}
                  className={`p-1 rounded-md transition-colors ${
                    theme === "light"
                      ? "hover:bg-gray-200 text-gray-500"
                      : "hover:bg-white/10 text-gray-400"
                  }`}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Summarize Controls */}
              <div
                className={`flex items-center gap-2 px-4 py-2 border-b shrink-0 ${
                  theme === "light"
                    ? "border-gray-100 bg-gray-50/50"
                    : "border-white/5 bg-white/2"
                }`}
              >
                <span
                  className={`text-[10px] uppercase tracking-wider font-semibold mr-1 ${
                    theme === "light" ? "text-gray-400" : "text-gray-500"
                  }`}
                >
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
                {isSummarizing && (
                  <Loader2 className="w-3 h-3 animate-spin text-purple-400 ml-1" />
                )}
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
                className={`flex-1 overflow-y-auto overflow-x-hidden p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words ${
                  theme === "light" ? "text-gray-700" : "text-gray-300"
                }`}
              >
                {contextText || "(No context yet)"}
              </pre>
            </motion.div>
          </>,
          document.body,
        )}
    </div>
  );
};

export default ContextBar;
