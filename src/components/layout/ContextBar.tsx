import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useLayout } from "../../contexts/LayoutContext";
import { aiService, providerUsesBaseUrl } from "../../services/ai";
import { STORAGE_KEYS } from "../../constants/storage";
import { useTheme } from "../../contexts/ThemeContext";
import { Folder, X, Loader2, Trash2, Search, Settings } from "lucide-react";
import { useAgent } from "../../contexts/AgentContext";
import { IPC } from "../../constants/ipc";
import { abbreviateHome, isWindows, isTouchDevice } from "../../utils/platform";
import { themeClass } from "../../utils/theme";
import { stripAnsi } from "../../utils/contextCleaner";
import { classifyTerminalOutput } from "../../utils/terminalState";
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
  hasAgentThread: boolean;
  isOverlayVisible: boolean;
  onShowOverlay: () => void;
}

const ContextBar: React.FC<ContextBarProps> = ({
  sessionId,
  hasAgentThread,
  isOverlayVisible,
  onShowOverlay,
}) => {
  const { sessions, updateSessionConfig, updateSession, openSettingsTab } = useLayout();
  const { resolvedTheme: theme } = useTheme();
  const { agentThread, setAgentThread } = useAgent(sessionId);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Derived state
  const session = sessions.get(sessionId);
  const cwd = session?.cwd || "~/";
  const rawModel = session?.aiConfig?.model || aiService.getConfig().model;
  const maxContext =
    session?.aiConfig?.contextWindow ||
    aiService.getConfig().contextWindow ||
    4000;

  // Poll for context length (history size)
  const [contextLength, setContextLength] = useState(0);
  const [contextText, setContextText] = useState("");
  const [showContextModal, setShowContextModal] = useState(false);
  const [isModalReady, setIsModalReady] = useState(false);

  useEffect(() => {
    if (showContextModal) {
      // Short delay: let the modal frame render before inserting content
      const timer = setTimeout(() => setIsModalReady(true), 50);
      return () => clearTimeout(timer);
    } else {
      setIsModalReady(false);
    }
  }, [showContextModal]);

  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSummarized, setIsSummarized] = useState(!!session?.contextSummary);
  const isSummarizedRef = useRef(!!session?.contextSummary);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showCtxTooltip, setShowCtxTooltip] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const ctxRingRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLDivElement>(null);
  const { data: availableModels = [] } = useAllConfiguredModels();
  const activeModel = availableModels.length > 0 ? rawModel : null;

  const displayModels = React.useMemo(() => {
    let filtered = availableModels;
    const globalCfg = aiService.getConfig();
    const favs = globalCfg.favoritedModels || [];

    const grouped: Record<string, typeof availableModels> = {};

    // 1. Filter by search query
    if (searchQuery) {
      const lower = searchQuery.toLowerCase();
      filtered = filtered.filter(m => m.name.toLowerCase().includes(lower) || m.provider.toLowerCase().includes(lower));
      // Limit to 50 models to prevent dropped frames when searching
      filtered = filtered.slice(0, 50);

      filtered.forEach((current) => {
        if (!grouped[current.provider]) grouped[current.provider] = [];
        grouped[current.provider].push(current);
      });

      return grouped;
    }

    // 2. Default View: Favorites/Active first, then top 3 per provider
    const favoriteModels = filtered.filter(m => favs.includes(m.name) || m.name === activeModel);
    // Ensure uniqueness
    const uniqueFavs = favoriteModels.filter((m, i, self) => i === self.findIndex((t) => t.name === m.name));

    if (uniqueFavs.length > 0) {
      grouped["Favorites & Active"] = uniqueFavs;
    }

    filtered.forEach((current) => {
      // Exclude favorites from the popular lists
      if (favs.includes(current.name) || current.name === activeModel) return;

      if (!grouped[current.provider]) grouped[current.provider] = [];
      if (grouped[current.provider].length < 3) {
        grouped[current.provider].push(current);
      }
    });

    return grouped;
  }, [availableModels, searchQuery, activeModel, showModelMenu]);

  // Auto-select model if current model is empty or unavailable — prefer user's saved choice
  useEffect(() => {
    if (availableModels.length === 0) return;
    const modelStillAvailable =
      activeModel && availableModels.some((m) => m.name === activeModel);
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
      } catch { }
      // 2. Also check the global saved config (may be more recent than cache)
      const globalCfg = aiService.getConfig();
      const globalMatch =
        globalCfg.model &&
        availableModels.find((m) => m.name === globalCfg.model);
      if (globalMatch) target = globalMatch;

      let providerCfg: { apiKey?: string; baseUrl?: string } | undefined;
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.PROVIDER_CONFIGS);
        if (raw) providerCfg = JSON.parse(raw)[target.provider];
      } catch { }
      const apiKey =
        providerCfg?.apiKey ||
        (target.provider === globalCfg.provider ? globalCfg.apiKey : undefined);
      const baseUrl =
        providerCfg?.baseUrl ||
        (target.provider === globalCfg.provider
          ? globalCfg.baseUrl
          : undefined);
      const update: Record<string, any> = {
        provider: target.provider,
        model: target.name,
      };
      if (apiKey) update.apiKey = apiKey;
      if (providerUsesBaseUrl(target.provider) && baseUrl)
        update.baseUrl = baseUrl;
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

  // Build agent thread text for context display
  const agentContextText = React.useMemo(() => {
    if (!agentThread.length) return "";
    const parts: string[] = [];
    for (const step of agentThread) {
      const text = (step.output || "").slice(0, 500);
      if (step.step === "separator") {
        parts.push(`\n[User] ${text}`);
      } else if (step.step === "done" || step.step === "success") {
        parts.push(`[Agent] ${text}`);
      } else if (step.step === "executed") {
        parts.push(`[Executed] ${text}`);
      } else if (step.step === "failed" || step.step === "error") {
        parts.push(`[Error] ${text}`);
      }
    }
    return parts.filter(Boolean).join("\n");
  }, [agentThread]);

  useEffect(() => {
    if (!sessionId) return;
    const pollHistory = async () => {
      if (window.electron) {
        const history = await window.electron.ipcRenderer.invoke(
          IPC.TERMINAL_GET_HISTORY,
          sessionId,
        );

        // Combine terminal history + agent thread
        const terminalText = stripAnsi(history);
        const fullContext = agentContextText
          ? terminalText + "\n\n--- Agent Activity ---\n" + agentContextText
          : terminalText;

        setContextLength(fullContext.length);

        // Calculate usage percent
        const percent = (fullContext.length / maxContext) * 100;

        // Auto-summarize at 90%
        if (percent > 90 && !isSummarizing && !isSummarizedRef.current) {
          handleSummarize("moderate");
        }

        // Only update display text if not currently showing a summary
        if (!isSummarizedRef.current) {
          setContextText(fullContext);
        } else if (session?.contextSummary) {
          setContextText(
            session.contextSummary + "\n\n... (plus recent output)",
          );
        }
      }
    };
    pollHistory();
    const interval = setInterval(pollHistory, 3000);
    return () => clearInterval(interval);
  }, [sessionId, maxContext, session?.contextSummary, agentContextText]);

  const handleOpenContextModal = () => setShowContextModal(true);

  const handleSummarize = async (_level: "brief" | "moderate" | "detailed") => {
    if (isSummarizing) return;
    setIsSummarizing(true);
    try {
      // Use the already-populated contextText (from polling) rather than re-fetching,
      // which avoids potential issues where re-fetch or re-clean returns empty.
      const textToSummarize = contextText || "";
      const summary = await aiService.summarizeContext(
        textToSummarize.slice(-10000),
      );

      // Update local view
      setContextText(summary);
      setIsSummarized(true);
      isSummarizedRef.current = true;

      // Persist to session
      updateSession(sessionId, {
        contextSummary: summary,
        contextSummarySourceLength: textToSummarize.length,
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

  const handleClearContext = async () => {
    // Clear terminal history
    if (window.electron) {
      await window.electron.ipcRenderer.invoke(
        IPC.TERMINAL_CLEAR_HISTORY,
        sessionId,
      );
    }
    // Clear agent thread
    setAgentThread([]);
    // Clear any summary
    updateSession(sessionId, {
      contextSummary: undefined,
      contextSummarySourceLength: undefined,
    });
    setIsSummarized(false);
    isSummarizedRef.current = false;
    setShowClearConfirm(false);

    // Re-fetch terminal to show current state (e.g. shell prompt) immediately
    if (window.electron) {
      const history = await window.electron.ipcRenderer.invoke(
        IPC.TERMINAL_GET_HISTORY,
        sessionId,
      );
      const text = stripAnsi(history);
      setContextText(text);
      setContextLength(text.length);
    } else {
      setContextText("");
      setContextLength(0);
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
      data-testid="context-bar"
      className={`w-full h-8 border-t flex items-center justify-between px-3 transition-all duration-200 select-none shrink-0 overflow-hidden whitespace-nowrap ${themeClass(
        theme,
        {
          dark: "bg-[#0a0a0a] border-white/5 text-gray-500",
          modern: "bg-[#060618] border-white/[0.06] text-gray-400",
          light: "bg-gray-50 border-gray-200 text-gray-500",
        },
      )}`}
    >
      {/* Left: Identity + Path */}
      <div className="flex items-center gap-4 min-w-0 overflow-hidden flex-1">
        <div
          data-testid="cwd-display"
          className="flex items-center gap-1.5 overflow-hidden cursor-pointer group/path"
          title={`Current directory: ${cwd}\nClick to change`}
          onClick={async () => {
            if (!window.electron?.ipcRenderer?.selectFolder) return;
            const selected =
              await window.electron.ipcRenderer.selectFolder(cwd);
            if (selected && sessionId) {
              // Check if terminal has a running process — if so, Ctrl+C first
              try {
                const history = await window.electron.ipcRenderer.getHistory(sessionId);
                const lastLines = (history || "").split("\n").slice(-5).join("\n");
                const state = classifyTerminalOutput(lastLines);
                if (state !== "idle") {
                  // Send Ctrl+C to interrupt the running process
                  window.electron.ipcRenderer.send("terminal.write", {
                    id: sessionId,
                    data: "\x03",
                  });
                  // Wait for the process to exit and shell prompt to appear
                  await new Promise((r) => setTimeout(r, 500));
                }
              } catch { /* proceed with cd anyway */ }

              // Clear current input line then cd into the selected directory
              const clearChar = isWindows() ? "\x1b" : "\x15"; // Esc for Win, Ctrl+U for Unix
              window.electron.ipcRenderer.send("terminal.write", {
                id: sessionId,
                data: clearChar,
              });
              // Delay on Windows so PSReadLine processes Esc as standalone keypress
              if (isWindows()) await new Promise((r) => setTimeout(r, 50));
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
          {hasAgentThread && !isOverlayVisible && (
            <motion.button
              key="agent-toggle"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.2 }}
              onClick={onShowOverlay}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
              title="Show Agent Panel (Cmd+.)"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
              <span className="text-[10px]">Show Agent</span>
              {!isTouchDevice() && <span className="text-[9px] opacity-50 ml-0.5">&#8984;.</span>}
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Right: Context Ring + Model */}
      <div className="flex items-center gap-4 shrink-0">
        <>
        <div
          ref={ctxRingRef}
          data-testid="context-ring"
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
                className={`px-2 py-1 rounded text-[10px] whitespace-nowrap shadow-lg ${theme === "light"
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
        </>

        {/* Model Switcher */}
        <div ref={modelBtnRef}>
          <div
            data-testid="model-selector"
            className="flex items-center gap-1 opacity-70 hover:opacity-100 transition-opacity cursor-pointer text-purple-400 text-[10px]"
            onClick={() => setShowModelMenu(!showModelMenu)}
          >
            <span className={`font-semibold ${!activeModel ? "opacity-50 italic" : ""}`}>{activeModel || "No model"}</span>
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
                  data-testid="model-menu"
                  initial={{ opacity: 0, scale: 0.95, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.15 }}
                  className={`fixed w-64 pt-0 rounded-lg shadow-xl z-[999] max-h-60 overflow-y-auto ${themeClass(
                    theme,
                    {
                      dark: "bg-[#1a1a1a] border border-white/10",
                      modern:
                        "bg-[#12122e] border border-white/8 shadow-xl",
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
                  <div className={`sticky top-0 z-10 px-2 py-1.5 border-b mb-1 shadow-sm rounded-t-lg ${themeClass(theme, {
                    dark: "bg-[#1a1a1a] border-white/10",
                    modern: "bg-[#12122e] border-white/8",
                    light: "bg-gray-50 border-gray-200",
                  })}`}>
                    <div className="relative flex items-center">
                      <Search className="w-3 h-3 absolute left-2 opacity-50" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search models..."
                        className={`w-full bg-transparent text-xs py-1 pl-7 pr-2 outline-none placeholder:opacity-50 ${theme === "light" ? "text-gray-900" : "text-white"}`}
                        autoFocus={!isTouchDevice()}
                      />
                    </div>
                  </div>
                  {Object.entries(displayModels).map(([provider, models]) => (
                    <div key={provider} className="mb-2">
                      <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-gray-500 font-semibold mb-0.5 opacity-80">
                        {provider}
                      </div>
                      {models.map((m) => (
                        <button
                          key={`${m.provider}-${m.name}`}
                          data-testid={`model-option-${m.name}`}
                          onClick={() => {
                            const update: Record<string, any> = {
                              provider: m.provider as any,
                              model: m.name,
                            };
                            const globalCfg = aiService.getConfig();
                            let providerCfg:
                              | { apiKey?: string; baseUrl?: string }
                              | undefined;
                            try {
                              const raw = localStorage.getItem(
                                "tron_provider_configs",
                              );
                              if (raw) providerCfg = JSON.parse(raw)[m.provider];
                            } catch { }
                            const apiKey =
                              providerCfg?.apiKey ||
                              (m.provider === globalCfg.provider
                                ? globalCfg.apiKey
                                : undefined);
                            const baseUrl =
                              providerCfg?.baseUrl ||
                              (m.provider === globalCfg.provider
                                ? globalCfg.baseUrl
                                : undefined);
                            if (apiKey) update.apiKey = apiKey;
                            if (providerUsesBaseUrl(m.provider) && baseUrl)
                              update.baseUrl = baseUrl;
                            updateSessionConfig(sessionId, update);
                            setShowModelMenu(false);
                            setSearchQuery("");
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 flex items-center gap-2 group transition-colors ${activeModel === m.name ? "text-purple-400 bg-purple-500/10" : "text-gray-400"}`}
                        >
                          <span className="flex-1 truncate">{m.name}</span>
                          <div className="flex gap-1 shrink-0">
                            {m.capabilities?.map((cap) => (
                              <span
                                key={cap}
                                className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${cap === "thinking"
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
                        </button>
                      ))}
                    </div>
                  ))}
                  {Object.keys(displayModels).length === 0 && (
                    <div className="px-3 py-4 text-gray-500 text-center italic text-xs">
                      No models found
                    </div>
                  )}
                  {/* Settings shortcut */}
                  <div className={`sticky bottom-0 px-2 py-1.5 border-t ${themeClass(theme, {
                    dark: "bg-[#1a1a1a] border-white/10",
                    modern: "bg-[#12122e] border-white/8",
                    light: "bg-gray-50 border-gray-200",
                  })}`}>
                    <button
                      onClick={() => { setShowModelMenu(false); setSearchQuery(""); openSettingsTab(); }}
                      className="w-full flex justify-center items-center gap-1.5 px-2 py-1 rounded text-[10px] text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors"
                    >
                      <Settings className="w-3 h-3" />
                      Model Settings
                    </button>
                  </div>
                </motion.div>
              </>,
              document.body,
            )}
        </div>
      </div>

      {/* Context Modal — portal to body to escape stacking contexts */}
      {createPortal(
        <AnimatePresence>
          {showContextModal && (
            <>
              <motion.div
                key="context-modal-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className={`fixed inset-0 z-[999] ${themeClass(theme, {
                  dark: "bg-black/50",
                  modern: "bg-[#020010]",
                  light: "bg-black/40",
                })}`}
                onClick={() => setShowContextModal(false)}
              />
              <motion.div
                key="context-modal-content"
                data-testid="context-modal"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className={`fixed inset-x-4 top-12 bottom-12 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[700px] z-[999] flex flex-col rounded-xl border overflow-hidden ${themeClass(
                  theme,
                  {
                    dark: "bg-[#0e0e0e] border-white/10 text-gray-200 shadow-xl",
                    modern: "bg-[#0a0a1e] border-white/[0.08] text-gray-200",
                    light: "bg-white border-gray-200 text-gray-900 shadow-xl",
                  },
                )}`}
              >
                {/* Modal Header */}
                <div
                  className={`flex items-center justify-between px-4 py-3 border-b shrink-0 ${theme === "light"
                    ? "border-gray-200 bg-gray-50"
                    : "border-white/5 bg-white/5"
                    }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold">
                      Session Context
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full ${theme === "light"
                        ? "bg-gray-100 text-gray-500"
                        : "bg-white/10 text-gray-400"
                        }`}
                    >
                      {contextText.length.toLocaleString()} chars
                    </span>
                  </div>
                  <button
                    onClick={() => setShowContextModal(false)}
                    className={`p-1 rounded-md transition-colors ${theme === "light"
                      ? "hover:bg-gray-200 text-gray-500"
                      : "hover:bg-white/10 text-gray-400"
                      }`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Summarize Controls */}
                <div
                  className={`flex items-center gap-2 px-4 py-2 border-b shrink-0 ${theme === "light"
                    ? "border-gray-100 bg-gray-50/50"
                    : "border-white/5 bg-white/2"
                    }`}
                >
                  <span
                    className={`text-[10px] uppercase tracking-wider font-semibold mr-1 ${theme === "light" ? "text-gray-400" : "text-gray-500"
                      }`}
                  >
                    Summarize:
                  </span>
                  {(["brief", "moderate", "detailed"] as const).map((level) => (
                    <button
                      key={level}
                      disabled={isSummarizing || contextText.length < 100}
                      onClick={() => handleSummarize(level)}
                      className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${isSummarizing || contextText.length < 100
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
                    className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${!isSummarized
                      ? "opacity-30 cursor-not-allowed border-white/5 text-gray-600"
                      : theme === "light"
                        ? "border-gray-200 hover:bg-gray-100 text-gray-500"
                        : "border-white/10 hover:bg-white/5 text-gray-500"
                      }`}
                  >
                    Reset to raw
                  </button>
                  <button
                    onClick={() => setShowClearConfirm(true)}
                    disabled={contextText.length < 100}
                    className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors flex items-center gap-1 ${contextText.length < 100
                      ? "opacity-30 cursor-not-allowed border-white/5 text-gray-600"
                      : theme === "light"
                        ? "border-red-200 hover:bg-red-50 text-red-500"
                        : "border-red-500/20 hover:bg-red-500/10 text-red-400"
                      }`}
                  >
                    <Trash2 className="w-3 h-3" />
                    Clear
                  </button>
                </div>

                {/* Clear Confirmation */}
                <AnimatePresence>
                  {showClearConfirm && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.12 }}
                      className={`mx-4 mt-3 p-3 rounded-lg border ${theme === "light"
                        ? "bg-red-50 border-red-200"
                        : "bg-red-500/10 border-red-500/20"
                        }`}
                    >
                      <p className={`text-xs mb-2 ${theme === "light" ? "text-red-700" : "text-red-300"
                        }`}>
                        This will clear terminal history and agent conversation. This cannot be undone.
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleClearContext}
                          className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors ${theme === "light"
                            ? "bg-red-500 hover:bg-red-600 text-white"
                            : "bg-red-500/80 hover:bg-red-500 text-white"
                            }`}
                        >
                          Clear All
                        </button>
                        <button
                          onClick={() => setShowClearConfirm(false)}
                          className={`text-[11px] px-3 py-1 rounded-md transition-colors ${theme === "light"
                            ? "hover:bg-gray-100 text-gray-500"
                            : "hover:bg-white/5 text-gray-400"
                            }`}
                        >
                          Cancel
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Context Content */}
                <pre
                  className={`flex-1 overflow-y-auto overflow-x-hidden p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words ${theme === "light" ? "text-gray-700" : "text-gray-300"
                    }`}
                  style={{ contain: "layout style paint" }}
                >
                  {!isModalReady
                    ? "Retrieving context..."
                    : (contextText.length > 50_000
                      ? contextText.slice(-50_000)
                      : contextText) || "(No context yet)"}
                </pre>
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
};

export default React.memo(ContextBar);
