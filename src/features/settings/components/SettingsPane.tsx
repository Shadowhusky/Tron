import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { AIConfig, AIModel, AIProvider } from "../../../types";
import { aiService, getCloudProvider, getCloudProviderList, providerUsesBaseUrl, isProviderUsable } from "../../../services/ai";
import { useTheme } from "../../../contexts/ThemeContext";
import { getTheme } from "../../../utils/theme";
import { useLayout } from "../../../contexts/LayoutContext";
import { useModelsWithCaps, useInvalidateModels, useInvalidateProviderModels } from "../../../hooks/useModels";
import { useConfig, DEFAULT_HOTKEYS } from "../../../contexts/ConfigContext";
import { formatHotkey, eventToCombo } from "../../../hooks/useHotkey";
import { STORAGE_KEYS } from "../../../constants/storage";
import {
  Gem,
  Laptop,
  Moon,
  Sun,
  SlidersHorizontal,
  Save,
  ChevronDown,
  Check,
  Terminal,
  Bot,
  Keyboard,
  RotateCcw,
  Cpu,
  Palette,
  Monitor,
} from "lucide-react";
import { staggerContainer, staggerItem } from "../../../utils/motion";

// Per-provider saved configs (model, apiKey, baseUrl)
type ProviderCache = Record<string, { model?: string; apiKey?: string; baseUrl?: string }>;

function loadProviderCache(): ProviderCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROVIDER_CONFIGS);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveProviderCache(cache: ProviderCache) {
  localStorage.setItem(STORAGE_KEYS.PROVIDER_CONFIGS, JSON.stringify(cache));
}

const HOTKEY_LABELS: Record<string, string> = {
  openSettings: "Open Settings",
  toggleOverlay: "Toggle Agent Panel",
  stopAgent: "Stop Agent",
  clearTerminal: "Clear Terminal",
  clearAgent: "Clear Agent Panel",
  modeCommand: "Command Mode",
  modeAdvice: "Advice Mode",
  modeAgent: "Agent Mode",
  modeAuto: "Auto Mode",
  forceAgent: "Force Agent (in input)",
  forceCommand: "Force Command (in input)",
};

const NAV_SECTIONS = [
  { id: "ai", label: "AI", icon: Cpu },
  { id: "view", label: "View Mode", icon: Monitor },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
] as const;

const SettingsPane = () => {
  const { theme, resolvedTheme, setTheme, viewMode, setViewMode } = useTheme();
  const { sessions, updateSessionConfig } = useLayout();
  const { hotkeys, updateHotkey, resetHotkeys } = useConfig();
  const t = getTheme(resolvedTheme);
  const [config, setConfig] = useState<AIConfig>(aiService.getConfig());
  const [initialConfig, setInitialConfig] = useState<string>(
    JSON.stringify(aiService.getConfig()),
  );
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [testError, setTestError] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");
  const providerCacheRef = useRef<ProviderCache>(loadProviderCache());

  // Hotkey recording state
  const [recordingAction, setRecordingAction] = useState<string | null>(null);

  // Sidebar active section tracking
  const [activeSection, setActiveSection] = useState<string>("ai");
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // IntersectionObserver to highlight active sidebar item on scroll
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { root: container, rootMargin: "-20% 0px -60% 0px", threshold: 0 },
    );
    for (const sec of NAV_SECTIONS) {
      const el = sectionRefs.current[sec.id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const scrollToSection = (id: string) => {
    const el = sectionRefs.current[id];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Listen for keydown when recording a hotkey
  useEffect(() => {
    if (!recordingAction) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Escape cancels recording without saving
      if (e.key === "Escape") {
        setRecordingAction(null);
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return; // modifier-only press
      updateHotkey(recordingAction, combo);
      setRecordingAction(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recordingAction, updateHotkey]);

  // Debounced baseUrl and apiKey — delays model fetches until user stops typing (1s)
  const [debouncedBaseUrl, setDebouncedBaseUrl] = useState(config.baseUrl);
  const [debouncedApiKey, setDebouncedApiKey] = useState(config.apiKey);
  const baseUrlTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const apiKeyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Flush debounce immediately (used by confirm/refresh buttons)
  const flushDebounce = useCallback(() => {
    clearTimeout(baseUrlTimerRef.current);
    clearTimeout(apiKeyTimerRef.current);
    setDebouncedBaseUrl(config.baseUrl);
    setDebouncedApiKey(config.apiKey);
  }, [config.baseUrl, config.apiKey]);

  const isLocal = config.provider === "ollama" || config.provider === "lmstudio";
  const { data: allModels = [], isFetching: isModelsFetching } = useModelsWithCaps(
    isLocal ? debouncedBaseUrl : undefined,
    isLocal,
    config.provider,
    isLocal ? debouncedApiKey : undefined,
  );
  const invalidateModels = useInvalidateModels();
  const invalidateProviderModels = useInvalidateProviderModels();
  const ollamaModels = allModels.filter((m) => m.provider === "ollama");
  const lmstudioModels = allModels.filter((m) => m.provider === "lmstudio");
  const [compatScannedModels, setCompatScannedModels] = useState<AIModel[]>([]);

  // Load initial config
  useEffect(() => {
    const current = aiService.getConfig();
    setConfig(current);
    setInitialConfig(JSON.stringify(current));
  }, []);

  const hasChanges = JSON.stringify(config) !== initialConfig;

  // When switching providers, save current config to cache and load the new provider's cached config
  const handleProviderChange = (newProvider: string) => {
    // Save current provider's config to cache
    const cache = providerCacheRef.current;
    cache[config.provider] = {
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    saveProviderCache(cache);

    // Load cached config for new provider (or defaults)
    const cached = cache[newProvider];
    const providerInfo = getCloudProvider(newProvider);
    const defaultBaseUrls: Record<string, string> = {
      ollama: "http://localhost:11434",
      lmstudio: "http://127.0.0.1:1234",
    };
    const newConfig = {
      ...config,
      provider: newProvider as AIProvider,
      model: cached?.model || providerInfo?.defaultModels?.[0] || "",
      apiKey: cached?.apiKey || "",
      baseUrl: providerUsesBaseUrl(newProvider)
        ? (cached?.baseUrl || defaultBaseUrls[newProvider] || "")
        : (cached?.baseUrl || undefined),
    };
    setConfig(newConfig);
    setInitialConfig(JSON.stringify(newConfig));
    setTestStatus("idle");
    setCompatScannedModels([]);
    // Sync debounced values immediately on provider switch (for local providers)
    setDebouncedBaseUrl(newConfig.baseUrl);
    setDebouncedApiKey(newConfig.apiKey);

    // Auto-save the provider switch so new tabs immediately use the new provider
    const configToSave = { ...newConfig };
    if (!providerUsesBaseUrl(newProvider)) {
      configToSave.baseUrl = undefined;
    }
    aiService.saveConfig(configToSave);

    // Propagate to all existing sessions
    sessions.forEach((session, sessionId) => {
      if (sessionId !== "settings") {
        const update: Partial<AIConfig> = {};
        if (configToSave.contextWindow !== undefined) update.contextWindow = configToSave.contextWindow;
        if (configToSave.maxAgentSteps !== undefined) update.maxAgentSteps = configToSave.maxAgentSteps;

        if (session.aiConfig?.provider === configToSave.provider) {
          update.apiKey = configToSave.apiKey;
          update.baseUrl = configToSave.baseUrl;
        }

        if (Object.keys(update).length > 0) {
          updateSessionConfig(sessionId, update);
        }
      }
    });
  };

  const handleSave = async () => {
    // Save current provider config to cache too
    const cache = providerCacheRef.current;
    cache[config.provider] = {
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    saveProviderCache(cache);

    // For non-baseUrl providers, explicitly clear baseUrl so it doesn't leak
    const configToSave = { ...config };
    if (!providerUsesBaseUrl(config.provider)) {
      configToSave.baseUrl = undefined;
    }

    // Save globally
    aiService.saveConfig(configToSave);
    setInitialConfig(JSON.stringify(config));
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);

    // For local providers, flush debounce so model query uses latest values
    if (isLocal) flushDebounce();

    // For compat providers, scan models from server after save
    const isCompat = config.provider === "openai-compat" || config.provider === "anthropic-compat";
    if (isCompat && config.baseUrl) {
      try {
        const models = await aiService.getModels(config.baseUrl, config.provider, config.apiKey);
        setCompatScannedModels(models);
      } catch { /* user will see empty list */ }
    }

    // Refresh model queries (including ContextBar's allConfiguredModels)
    invalidateModels();

    // Propagate to all existing sessions
    sessions.forEach((session, sessionId) => {
      if (sessionId !== "settings") {
        const update: Partial<AIConfig> = {};
        if (configToSave.contextWindow !== undefined) update.contextWindow = configToSave.contextWindow;
        if (configToSave.maxAgentSteps !== undefined) update.maxAgentSteps = configToSave.maxAgentSteps;

        if (session.aiConfig?.provider === configToSave.provider) {
          update.apiKey = configToSave.apiKey;
          update.baseUrl = configToSave.baseUrl;
        }

        if (Object.keys(update).length > 0) {
          updateSessionConfig(sessionId, update);
        }
      }
    });
  };

  const handleTestConnection = async () => {
    setTestStatus("testing");
    setTestError("");
    try {
      const result = await window.electron.ipcRenderer.testAIConnection(config);
      // Support both old (boolean) and new ({ success, error }) response formats
      const success = typeof result === "boolean" ? result : result?.success;
      const error = typeof result === "object" ? result?.error : undefined;
      setTestStatus(success ? "success" : "error");
      if (!success && error) setTestError(error);
      setTimeout(() => { setTestStatus("idle"); setTestError(""); }, 5000);
    } catch (e: any) {
      setTestStatus("error");
      setTestError(e.message || "Connection failed");
      setTimeout(() => { setTestStatus("idle"); setTestError(""); }, 5000);
    }
  };

  const inputClass = `w-full p-1.5 text-xs rounded-lg border outline-none transition-colors ${t.surfaceInput}`;
  const selectClass = `w-full p-1.5 pr-7 text-xs rounded-lg border outline-none appearance-none transition-colors ${t.surfaceInput}`;
  const labelClass = `text-xs font-medium ${t.textMuted}`;
  const cardClass = `p-3 rounded-xl ${t.surface} ${t.glass}`;

  return (
    <div className={`w-full h-full flex ${t.appBg}`}>
      {/* Sidebar */}
      <nav
        className={`shrink-0 w-40 flex flex-col border-r pt-4 pb-4 gap-1 px-2 ${resolvedTheme === "light"
            ? "bg-gray-50/80 border-gray-200"
            : resolvedTheme === "modern"
              ? "bg-white/[0.02] border-white/6"
              : "bg-[#0a0a0a] border-white/5"
          }`}
      >
        <div className={`px-2 pb-3 mb-1 border-b ${t.borderSubtle}`}>
          <h1 className={`text-sm font-bold ${t.text}`}>Settings</h1>
        </div>
        {NAV_SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            data-testid={`settings-nav-${id}`}
            onClick={() => scrollToSection(id)}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors text-left ${activeSection === id
                ? resolvedTheme === "light"
                  ? "bg-purple-50 text-purple-700 font-medium"
                  : "bg-purple-500/10 text-purple-300 font-medium"
                : `${t.textMuted} hover:${t.surfaceHover}`
              }`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            {label}
          </button>
        ))}

        {/* Save button at bottom of sidebar */}
        <div className="mt-auto pt-3">
          <button
            data-testid="save-button"
            onClick={handleSave}
            disabled={!hasChanges && saveStatus !== "saved"}
            className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg font-medium text-xs transition-all ${saveStatus === "saved"
                ? "bg-green-500/20 text-green-500"
                : hasChanges
                  ? "bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/20"
                  : `${t.textFaint} cursor-not-allowed opacity-40`
              }`}
          >
            <Save className="w-3.5 h-3.5" />
            {saveStatus === "saved" ? "Saved" : "Save"}
          </button>
        </div>
      </nav>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 flex flex-col items-center">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
          className="w-full max-w-xl flex flex-col gap-6 pb-16"
        >
          {/* AI Configuration */}
          <motion.div
            variants={staggerItem}
            id="ai"
            ref={(el) => { sectionRefs.current.ai = el; }}
            className="space-y-3 scroll-mt-4"
          >
            <h3
              className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}
            >
              <Cpu className="w-3.5 h-3.5" />
              AI Configuration
            </h3>

            <div className={`grid gap-3 ${cardClass}`}>
              {/* Provider */}
              <div className="flex flex-col gap-1">
                <label className={labelClass}>Provider</label>
                <div className="relative">
                  <select
                    data-testid="provider-select"
                    value={config.provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className={selectClass}
                  >
                    <optgroup label="Local">
                      <option value="ollama">Ollama (Local)</option>
                      <option value="lmstudio">LM Studio (Local)</option>
                    </optgroup>
                    <optgroup label="Cloud">
                      {getCloudProviderList()
                        .filter(({ id }) => !["lmstudio", "openai-compat", "anthropic-compat"].includes(id))
                        .map(({ id, info }) => (
                          <option key={id} value={id}>{info.label}</option>
                        ))}
                    </optgroup>
                    <optgroup label="Custom">
                      <option value="openai-compat">OpenAI Compatible</option>
                      <option value="anthropic-compat">Anthropic Compatible</option>
                    </optgroup>
                  </select>
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                    <ChevronDown className="w-3.5 h-3.5" />
                  </div>
                </div>
              </div>

              <AnimatePresence mode="wait">
                {config.provider === "ollama" || config.provider === "lmstudio" ? (
                  <motion.div
                    key="local-settings"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-3 overflow-hidden"
                  >
                    {/* Models List with Capability Badges */}
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <label className={labelClass}>Model</label>
                        <button
                          onClick={() => { flushDebounce(); invalidateProviderModels(); }}
                          title="Refresh Models"
                          className={`p-1 rounded-lg ${t.surface} ${t.surfaceHover} transition-colors`}
                        >
                          <svg
                            className="w-3.5 h-3.5 opacity-70"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                          </svg>
                        </button>
                      </div>
                      {(() => {
                        const localModels = config.provider === "lmstudio" ? lmstudioModels : ollamaModels;
                        const serverName = config.provider === "lmstudio" ? "LM Studio" : "Ollama";
                        const defaultUrl = config.provider === "lmstudio" ? "http://127.0.0.1:1234" : "http://localhost:11434";
                        return (
                          <div className={`rounded-lg border overflow-hidden max-h-48 overflow-y-auto ${t.surfaceInput}`}>
                            {localModels.length === 0 && (
                              <div className={`px-3 py-2 text-xs ${t.textFaint}`}>
                                {isModelsFetching ? (
                                  <span className="italic">Scanning models...</span>
                                ) : (
                                  <span>
                                    Could not reach {serverName} server at{" "}
                                    <span className="font-mono opacity-80">{config.baseUrl || defaultUrl}</span>.
                                    <br />
                                    Make sure {serverName} is running and the URL is correct.
                                  </span>
                                )}
                              </div>
                            )}
                            {localModels.map((m) => (
                              <button
                                key={m.name}
                                data-testid={`model-item-${m.name}`}
                                onClick={() => setConfig({ ...config, model: m.name })}
                                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${config.model === m.name
                                    ? "bg-purple-500/10 text-purple-400"
                                    : `${t.surfaceHover} ${t.textMuted}`
                                  }`}
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
                            {!localModels.find((m) => m.name === config.model) &&
                              config.model && (
                                <div className={`px-3 py-1.5 text-xs ${t.textFaint}`}>
                                  {config.model} (not found)
                                </div>
                              )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* API Key (optional for local providers) */}
                    <div className="flex flex-col gap-1">
                      <label className={labelClass}>API Key (optional)</label>
                      <input
                        data-testid="api-key-input"
                        type="password"
                        value={config.apiKey || ""}
                        onChange={(e) =>
                          setConfig({ ...config, apiKey: e.target.value })
                        }
                        placeholder="Leave empty if not required"
                        className={inputClass}
                      />
                    </div>

                    {/* Base URL Input */}
                    <div className="flex flex-col gap-1">
                      <label className={labelClass}>
                        {config.provider === "lmstudio" ? "LM Studio" : "Ollama"} Base URL
                      </label>
                      <div className="flex gap-1.5">
                        <input
                          data-testid="base-url-input"
                          type="text"
                          value={config.baseUrl || (config.provider === "lmstudio" ? "http://127.0.0.1:1234" : "http://localhost:11434")}
                          onChange={(e) =>
                            setConfig({ ...config, baseUrl: e.target.value })
                          }
                          placeholder={config.provider === "lmstudio" ? "http://127.0.0.1:1234" : "http://localhost:11434"}
                          className={inputClass}
                        />
                        <button
                          data-testid="base-url-confirm"
                          onClick={() => { flushDebounce(); invalidateProviderModels(); }}
                          title="Confirm URL"
                          className={`p-1.5 rounded-lg ${t.surface} ${t.surfaceHover} transition-colors`}
                        >
                          <Check className="w-4 h-4 opacity-70" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="cloud-settings"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-3 overflow-hidden"
                  >
                    {(() => {
                      const providerInfo = getCloudProvider(config.provider);
                      const defaultModels = providerInfo?.defaultModels || [];
                      const isCompat = config.provider === "openai-compat" || config.provider === "anthropic-compat";
                      // For compat providers, show models scanned on save
                      const scannedModels = isCompat ? compatScannedModels : [];
                      const modelList = scannedModels.length > 0 ? scannedModels.map((m) => m.name) : defaultModels;
                      return (
                        <>
                          {isCompat && (
                            <div className="flex flex-col gap-1">
                              <label className={labelClass}>Base URL</label>
                              <input
                                type="text"
                                value={config.baseUrl || ""}
                                onChange={(e) =>
                                  setConfig({ ...config, baseUrl: e.target.value })
                                }
                                placeholder={config.provider === "anthropic-compat" ? "https://your-proxy.example.com" : "https://your-api.example.com/v1"}
                                className={inputClass}
                              />
                            </div>
                          )}
                          <div className="flex flex-col gap-1">
                            {(() => {
                              const isCustomModel = !!config.model && !modelList.includes(config.model);
                              const customValue = isCustomModel ? config.model : "";
                              return (
                                <>
                                  <div className="flex items-center justify-between">
                                    <label className={labelClass}>Model</label>
                                    {isCompat && modelList.length === 0 && config.baseUrl && !isModelsFetching && (
                                      <span className={`text-[10px] ${t.textFaint}`}>
                                        Could not list models from server — enter name below
                                      </span>
                                    )}
                                  </div>
                                  {modelList.length > 0 && (
                                    <div className={`rounded-lg border overflow-hidden max-h-32 overflow-y-auto mb-1 transition-opacity ${t.surfaceInput} ${customValue ? "opacity-40 pointer-events-none" : ""}`}>
                                      {modelList.map((name) => (
                                        <button
                                          key={name}
                                          onClick={() => setConfig({ ...config, model: name })}
                                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${config.model === name
                                              ? "bg-purple-500/10 text-purple-400"
                                              : `${t.surfaceHover} ${t.textMuted}`
                                            }`}
                                        >
                                          {name}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  <label className={`${labelClass} mt-1`}>Custom Model Name</label>
                                  <input
                                    data-testid="custom-model-input"
                                    type="text"
                                    value={customValue}
                                    placeholder={providerInfo?.placeholder || "model-name"}
                                    onChange={(e) =>
                                      setConfig({ ...config, model: e.target.value })
                                    }
                                    className={inputClass}
                                  />
                                </>
                              );
                            })()}
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className={labelClass}>API Key{isCompat ? " (optional)" : ""}</label>
                            <input
                              type="password"
                              value={config.apiKey || ""}
                              onChange={(e) =>
                                setConfig({ ...config, apiKey: e.target.value })
                              }
                              className={inputClass}
                            />
                          </div>
                        </>
                      );
                    })()}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Test Connection + Clear Config */}
              <div className="flex justify-between items-center pt-1">
                <button
                  onClick={() => {
                    // Clear this provider from cache
                    const cache = providerCacheRef.current;
                    delete cache[config.provider];
                    saveProviderCache(cache);

                    // Find first usable provider from remaining cache
                    let nextProvider = "ollama";
                    let nextModel = "";
                    let nextApiKey = "";
                    let nextBaseUrl: string | undefined = "http://localhost:11434";

                    for (const [id, cfg] of Object.entries(cache)) {
                      if (isProviderUsable(id, cfg)) {
                        const info = getCloudProvider(id);
                        nextProvider = id;
                        nextModel = cfg.model || info?.defaultModels?.[0] || "";
                        nextApiKey = cfg.apiKey || "";
                        nextBaseUrl = providerUsesBaseUrl(id) ? cfg.baseUrl : undefined;
                        break;
                      }
                    }

                    const newConfig = {
                      ...config,
                      provider: nextProvider as AIProvider,
                      model: nextModel,
                      apiKey: nextApiKey,
                      baseUrl: nextBaseUrl,
                    };
                    setConfig(newConfig);
                    setTestStatus("idle");
                  }}
                  data-testid="clear-provider-button"
                  className={`text-[10px] px-3 py-1 rounded-lg border transition-colors ${t.border} ${t.textMuted} ${t.surfaceHover}`}
                >
                  <span className="flex items-center gap-1">
                    <RotateCcw className="w-3 h-3" />
                    Clear Provider
                  </span>
                </button>
                {(config.provider === "ollama" || config.provider === "lmstudio") && (
                  <button
                    data-testid="test-connection-button"
                    onClick={handleTestConnection}
                    disabled={testStatus === "testing" || !config.model}
                    className={`text-[10px] px-3 py-1 rounded-lg border transition-colors ${testStatus === "success"
                        ? "border-green-500/50 text-green-400 bg-green-500/10"
                        : testStatus === "error"
                          ? "border-red-500/50 text-red-400 bg-red-500/10"
                          : `${t.border} ${t.textMuted} ${t.surfaceHover}`
                      }`}
                  >
                    {testStatus === "testing"
                      ? "Testing..."
                      : testStatus === "success"
                        ? "Connection Verified"
                        : testStatus === "error"
                          ? "Connection Failed"
                          : "Test Connection"}
                  </button>
                )}
              </div>
              {testError && testStatus === "error" && (
                <div data-testid="test-status" className="text-[10px] text-red-400 bg-red-500/10 rounded-lg px-2 py-1.5 break-all max-h-20 overflow-y-auto">
                  {testError}
                </div>
              )}
            </div>

            {/* Context Window Setting */}
            <div className={`${cardClass} flex flex-col gap-2`}>
              <div className="flex items-center justify-between">
                <label
                  className={`text-xs font-medium flex items-center gap-1.5 ${t.textMuted}`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Context Window
                </label>
                <div className={`text-[10px] ${t.textFaint}`}>
                  Max tokens sent to AI
                </div>
              </div>

              <div className="flex items-center gap-3">
                <input
                  data-testid="context-window-slider"
                  type="range"
                  min="1000"
                  max="128000"
                  step="1000"
                  value={config.contextWindow || 4000}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      contextWindow: Number(e.target.value),
                    })
                  }
                  className={`flex-1 accent-purple-500 h-1 rounded-lg appearance-none cursor-pointer ${resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"
                    }`}
                />
                <span
                  className={`text-xs font-mono min-w-12 text-right ${t.accent}`}
                >
                  {((config.contextWindow || 4000) / 1000).toFixed(0)}k
                </span>
              </div>
            </div>

            {/* Max Agent Steps Setting */}
            <div className={`${cardClass} flex flex-col gap-2`}>
              <div className="flex items-center justify-between">
                <label
                  className={`text-xs font-medium flex items-center gap-1.5 ${t.textMuted}`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Max Agent Steps
                </label>
                <div className={`text-[10px] ${t.textFaint}`}>
                  Loop iterations before stopping
                </div>
              </div>

              <div className="flex items-center gap-3">
                <input
                  data-testid="max-steps-slider"
                  type="range"
                  min="10"
                  max="200"
                  step="10"
                  value={config.maxAgentSteps || 100}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      maxAgentSteps: Number(e.target.value),
                    })
                  }
                  className={`flex-1 accent-purple-500 h-1 rounded-lg appearance-none cursor-pointer ${resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"
                    }`}
                />
                <span
                  className={`text-xs font-mono min-w-12 text-right ${t.accent}`}
                >
                  {config.maxAgentSteps || 100}
                </span>
              </div>
            </div>
          </motion.div>

          {/* View Mode */}
          <motion.div
            variants={staggerItem}
            id="view"
            ref={(el) => { sectionRefs.current.view = el; }}
            className="space-y-3 scroll-mt-4"
          >
            <h3
              className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}
            >
              <Monitor className="w-3.5 h-3.5" />
              View Mode
            </h3>

            <div className={cardClass}>
              <label className={`text-xs font-medium mb-2 block ${t.textMuted}`}>
                Interface Style
              </label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  {
                    id: "terminal" as const,
                    label: "Terminal",
                    desc: "Classic terminal + AI overlay",
                    icon: Terminal,
                    iconBg: "bg-gray-700 text-green-300",
                    activeBorder: "border-blue-500 bg-blue-500/10",
                  },
                  {
                    id: "agent" as const,
                    label: "Agent",
                    desc: "Chat-focused, AI-first",
                    icon: Bot,
                    iconBg: "bg-purple-500/30 text-purple-300",
                    activeBorder: "border-purple-500 bg-purple-500/10 shadow-[0_0_12px_rgba(168,85,247,0.15)]",
                  },
                ] as const).map(({ id, label, desc, icon: Icon, iconBg, activeBorder }) => (
                  <motion.button
                    key={id}
                    data-testid={`view-mode-${id}`}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => setViewMode(id)}
                    className={`p-2 border rounded-xl flex flex-col items-center gap-1.5 transition-colors ${viewMode === id
                        ? activeBorder
                        : `${t.borderSubtle} ${t.surfaceHover} bg-black/10`
                      }`}
                  >
                    <div className={`w-6 h-6 rounded-full ${iconBg} flex items-center justify-center`}>
                      <Icon className="w-3 h-3" />
                    </div>
                    <span className="text-[10px] font-medium">{label}</span>
                    <span className={`text-[9px] ${t.textFaint}`}>{desc}</span>
                  </motion.button>
                ))}
              </div>
            </div>
          </motion.div>

          {/* Appearance */}
          <motion.div
            variants={staggerItem}
            id="appearance"
            ref={(el) => { sectionRefs.current.appearance = el; }}
            className="space-y-3 scroll-mt-4"
          >
            <h3
              className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}
            >
              <Palette className="w-3.5 h-3.5" />
              Appearance
            </h3>

            <div className={cardClass}>
              <label className={`text-xs font-medium mb-2 block ${t.textMuted}`}>
                Theme
              </label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {(
                  [
                    {
                      id: "light" as const,
                      label: "Light",
                      icon: Sun,
                      iconBg: "bg-amber-100 text-amber-600",
                      activeBorder: "border-blue-500 bg-blue-500/10",
                    },
                    {
                      id: "dark" as const,
                      label: "Dark",
                      icon: Moon,
                      iconBg: "bg-gray-700 text-blue-300",
                      activeBorder: "border-blue-500 bg-blue-500/10",
                    },
                    {
                      id: "system" as const,
                      label: "System",
                      icon: Laptop,
                      iconBg: "bg-gray-600 text-white",
                      activeBorder: "border-blue-500 bg-blue-500/10",
                    },
                    {
                      id: "modern" as const,
                      label: "Modern",
                      icon: Gem,
                      iconBg: "bg-purple-500/30 text-purple-300",
                      activeBorder:
                        "border-purple-500 bg-purple-500/10 shadow-[0_0_12px_rgba(168,85,247,0.15)]",
                    },
                  ] as const
                ).map(({ id, label, icon: Icon, iconBg, activeBorder }) => (
                  <motion.button
                    key={id}
                    data-testid={`theme-${id}`}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => setTheme(id)}
                    className={`p-2 border rounded-xl flex flex-col items-center gap-1.5 transition-colors ${theme === id
                        ? activeBorder
                        : `${t.borderSubtle} ${t.surfaceHover} bg-black/10`
                      }`}
                  >
                    <div
                      className={`w-6 h-6 rounded-full ${iconBg} flex items-center justify-center`}
                    >
                      <Icon className="w-3 h-3" />
                    </div>
                    <span className="text-[10px] font-medium">{label}</span>
                  </motion.button>
                ))}
              </div>
            </div>
          </motion.div>

          {/* Keyboard Shortcuts */}
          <motion.div
            variants={staggerItem}
            id="shortcuts"
            ref={(el) => { sectionRefs.current.shortcuts = el; }}
            className="space-y-3 scroll-mt-4"
          >
            <div className="flex items-center justify-between">
              <h3
                className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}
              >
                <Keyboard className="w-3.5 h-3.5" />
                Keyboard Shortcuts
              </h3>
              <button
                onClick={resetHotkeys}
                className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-lg border transition-colors ${t.border} ${t.textMuted} ${t.surfaceHover}`}
                title="Reset all shortcuts to defaults"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            </div>

            <div className={`${cardClass} divide-y ${resolvedTheme === "light" ? "divide-gray-100" : "divide-white/5"}`}>
              {Object.entries(HOTKEY_LABELS).map(([action, label]) => {
                const combo = hotkeys[action] || DEFAULT_HOTKEYS[action] || "";
                const isRecording = recordingAction === action;
                const isDefault = combo === DEFAULT_HOTKEYS[action];
                return (
                  <div
                    key={action}
                    className="flex items-center justify-between py-2 first:pt-0 last:pb-0"
                  >
                    <span className={`text-xs ${t.textMuted}`}>{label}</span>
                    <button
                      data-testid={`hotkey-${action}`}
                      onClick={() => setRecordingAction(isRecording ? null : action)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-mono transition-colors ${isRecording
                          ? "bg-purple-500/20 border border-purple-500 text-purple-300 ring-2 ring-purple-500/30"
                          : `${t.surface} border ${t.borderSubtle} ${t.surfaceHover} ${t.text}`
                        }`}
                      title={isRecording ? "Press a key combo... (Esc to cancel)" : "Click to change"}
                    >
                      {isRecording ? (
                        <span className="text-[11px]">Press keys...</span>
                      ) : (
                        <>
                          {formatHotkey(combo).split("").map((ch, i) => (
                            <span
                              key={i}
                              className={`inline-flex items-center justify-center min-w-[18px] h-5 px-1 rounded text-[11px] font-medium ${resolvedTheme === "light"
                                  ? "bg-gray-100 text-gray-700 border border-gray-200"
                                  : "bg-white/10 text-gray-200 border border-white/10"
                                }`}
                            >
                              {ch}
                            </span>
                          ))}
                          {!isDefault && (
                            <span className="text-[9px] text-purple-400 ml-1">edited</span>
                          )}
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
};

export default SettingsPane;
