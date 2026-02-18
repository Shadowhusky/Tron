import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { AIConfig, AIProvider } from "../../../types";
import { aiService, getCloudProvider, getCloudProviderList } from "../../../services/ai";
import { useTheme } from "../../../contexts/ThemeContext";
import { getTheme } from "../../../utils/theme";
import { useLayout } from "../../../contexts/LayoutContext";
import { useModelsWithCaps, useInvalidateModels } from "../../../hooks/useModels";
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

const SettingsPane = () => {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { sessions, updateSessionConfig } = useLayout();
  const t = getTheme(resolvedTheme);
  const [config, setConfig] = useState<AIConfig>(aiService.getConfig());
  const [initialConfig, setInitialConfig] = useState<string>(
    JSON.stringify(aiService.getConfig()),
  );
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");
  const providerCacheRef = useRef<ProviderCache>(loadProviderCache());

  const { data: allModels = [] } = useModelsWithCaps(
    config.provider === "ollama" ? config.baseUrl : undefined,
  );
  const invalidateModels = useInvalidateModels();
  const ollamaModels = allModels.filter((m) => m.provider === "ollama");

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
    setConfig({
      ...config,
      provider: newProvider as AIProvider,
      model: cached?.model || providerInfo?.defaultModels?.[0] || "",
      apiKey: cached?.apiKey || "",
      baseUrl: newProvider === "ollama"
        ? (cached?.baseUrl || "http://localhost:11434")
        : (cached?.baseUrl || undefined),
    });
    setTestStatus("idle");
  };

  const handleSave = () => {
    // Save current provider config to cache too
    const cache = providerCacheRef.current;
    cache[config.provider] = {
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    saveProviderCache(cache);

    // For cloud providers, don't persist the Ollama baseUrl
    const configToSave = { ...config };
    if (config.provider !== "ollama" && !configToSave.baseUrl) {
      delete configToSave.baseUrl;
    }

    // Save globally
    aiService.saveConfig(configToSave);
    setInitialConfig(JSON.stringify(config));
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);

    // Propagate to all existing sessions
    sessions.forEach((_, sessionId) => {
      if (sessionId !== "settings") {
        updateSessionConfig(sessionId, configToSave);
      }
    });
  };

  const handleTestConnection = async () => {
    setTestStatus("testing");
    try {
      const success =
        await window.electron.ipcRenderer.testAIConnection(config);
      setTestStatus(success ? "success" : "error");
      setTimeout(() => setTestStatus("idle"), 3000);
    } catch (e) {
      setTestStatus("error");
      setTimeout(() => setTestStatus("idle"), 3000);
    }
  };

  const inputClass = `w-full p-1.5 text-xs rounded-lg border outline-none transition-colors ${t.surfaceInput}`;
  const selectClass = `w-full p-1.5 pr-7 text-xs rounded-lg border outline-none appearance-none transition-colors ${t.surfaceInput}`;
  const labelClass = `text-xs font-medium ${t.textMuted}`;
  const cardClass = `p-3 rounded-xl ${t.surface} ${t.glass}`;

  return (
    <div
      className={`w-full h-full overflow-y-auto p-4 flex flex-col items-center ${t.appBg}`}
    >
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="w-full max-w-xl flex flex-col gap-4 pb-16"
      >
        {/* Header */}
        <motion.div
          variants={staggerItem}
          className={`flex items-center justify-between ${t.borderSubtle} border-b pb-3`}
        >
          <div>
            <h1 className={`text-base font-bold ${t.text}`}>Settings</h1>
            <p className={`${t.textFaint} text-[11px] mt-0.5`}>
              Manage AI providers, models, and appearance.
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={!hasChanges && saveStatus !== "saved"}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium text-xs transition-all ${
              saveStatus === "saved"
                ? "bg-green-500/20 text-green-500"
                : hasChanges
                  ? "bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/20"
                  : `${t.textFaint} cursor-not-allowed opacity-40`
            }`}
          >
            <Save className="w-3.5 h-3.5" />
            {saveStatus === "saved" ? "Saved" : "Save"}
          </button>
        </motion.div>

        {/* AI Settings */}
        <motion.div variants={staggerItem} className="space-y-3">
          <h3
            className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}
          >
            AI Configuration
          </h3>

          <div className={`grid gap-3 ${cardClass}`}>
            {/* Provider */}
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Provider</label>
              <div className="relative">
                <select
                  value={config.provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className={selectClass}
                >
                  <option value="ollama">Ollama (Local)</option>
                  {getCloudProviderList().map(({ id, info }) => (
                    <option key={id} value={id}>{info.label}</option>
                  ))}
                </select>
                <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                  <ChevronDown className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>

            <AnimatePresence mode="wait">
            {config.provider === "ollama" ? (
              <motion.div
                key="ollama-settings"
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
                      onClick={() => invalidateModels(config.baseUrl)}
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
                  <div className={`rounded-lg border overflow-hidden max-h-48 overflow-y-auto ${t.surfaceInput}`}>
                    {ollamaModels.length === 0 && (
                      <div className={`px-3 py-2 text-xs italic ${t.textFaint}`}>
                        No models found
                      </div>
                    )}
                    {ollamaModels.map((m) => (
                      <button
                        key={m.name}
                        onClick={() => setConfig({ ...config, model: m.name })}
                        className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                          config.model === m.name
                            ? "bg-purple-500/10 text-purple-400"
                            : `${t.surfaceHover} ${t.textMuted}`
                        }`}
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
                      </button>
                    ))}
                    {!ollamaModels.find((m) => m.name === config.model) &&
                      config.model && (
                        <div className={`px-3 py-1.5 text-xs ${t.textFaint}`}>
                          {config.model} (not found)
                        </div>
                      )}
                  </div>
                </div>

                {/* Base URL Input */}
                <div className="flex flex-col gap-1">
                  <label className={labelClass}>Ollama Base URL</label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={config.baseUrl || "http://localhost:11434"}
                      onChange={(e) =>
                        setConfig({ ...config, baseUrl: e.target.value })
                      }
                      onBlur={() => invalidateModels(config.baseUrl)}
                      placeholder="http://localhost:11434"
                      className={inputClass}
                    />
                    <button
                      onClick={() => invalidateModels(config.baseUrl)}
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
                  return (
                    <>
                      <div className="flex flex-col gap-1">
                        <label className={labelClass}>Model</label>
                        {defaultModels.length > 0 && (
                          <div className={`rounded-lg border overflow-hidden max-h-32 overflow-y-auto mb-1 ${t.surfaceInput}`}>
                            {defaultModels.map((name) => (
                              <button
                                key={name}
                                onClick={() => setConfig({ ...config, model: name })}
                                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                                  config.model === name
                                    ? "bg-purple-500/10 text-purple-400"
                                    : `${t.surfaceHover} ${t.textMuted}`
                                }`}
                              >
                                {name}
                              </button>
                            ))}
                          </div>
                        )}
                        <input
                          type="text"
                          value={config.model}
                          placeholder={providerInfo?.placeholder || "model-name"}
                          onChange={(e) =>
                            setConfig({ ...config, model: e.target.value })
                          }
                          className={inputClass}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className={labelClass}>API Key</label>
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

            {/* Test Connection Button */}
            <div className="flex justify-end pt-1">
              <button
                onClick={handleTestConnection}
                disabled={testStatus === "testing" || !config.model}
                className={`text-[10px] px-3 py-1 rounded-lg border transition-colors ${
                  testStatus === "success"
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
            </div>
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
                className={`flex-1 accent-purple-500 h-1 rounded-lg appearance-none cursor-pointer ${
                  resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"
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
                className={`flex-1 accent-purple-500 h-1 rounded-lg appearance-none cursor-pointer ${
                  resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"
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

        {/* Appearance Settings */}
        <motion.div variants={staggerItem} className="space-y-3">
          <h3
            className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider`}
          >
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
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => setTheme(id)}
                  className={`p-2 border rounded-xl flex flex-col items-center gap-1.5 transition-colors ${
                    theme === id
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
      </motion.div>
    </div>
  );
};

export default SettingsPane;
