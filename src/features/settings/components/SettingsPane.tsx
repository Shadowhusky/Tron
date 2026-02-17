import { useState, useEffect } from "react";
import type { AIConfig } from "../../../types";
import { aiService } from "../../../services/ai";
import { useTheme } from "../../../contexts/ThemeContext";
import { getTheme } from "../../../utils/theme";
import {
  Gem,
  Laptop,
  Moon,
  Sun,
  SlidersHorizontal,
  Save,
  ChevronDown,
} from "lucide-react";

const SettingsPane = () => {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const t = getTheme(resolvedTheme);
  const [config, setConfig] = useState<AIConfig>(aiService.getConfig());
  const [initialConfig, setInitialConfig] = useState<string>(
    JSON.stringify(aiService.getConfig()),
  );
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");

  // Load initial config
  useEffect(() => {
    const current = aiService.getConfig();
    setConfig(current);
    setInitialConfig(JSON.stringify(current));

    // Fetch Ollama models
    aiService.getModels().then((list) => {
      const ollama = list
        .filter((m) => m.provider === "ollama")
        .map((m) => m.name);
      setOllamaModels(ollama);
    });
  }, []);

  const hasChanges = JSON.stringify(config) !== initialConfig;

  const handleSave = () => {
    // Save globally
    aiService.saveConfig(config);
    setInitialConfig(JSON.stringify(config));
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);
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
      <div className="w-full max-w-xl flex flex-col gap-4 pb-16">
        {/* Header */}
        <div className={`flex items-center justify-between ${t.borderSubtle} border-b pb-3`}>
          <div>
            <h1 className={`text-base font-bold ${t.text}`}>
              Settings
            </h1>
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
        </div>

        {/* AI Settings */}
        <div className="space-y-3">
          <h3 className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}>
            AI Configuration
          </h3>

          <div className={`grid gap-3 ${cardClass}`}>
            {/* Provider */}
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Provider</label>
              <div className="relative">
                <select
                  value={config.provider}
                  onChange={(e) => {
                    setConfig({
                      ...config,
                      provider: e.target.value as any,
                      model: "",
                    });
                    setTestStatus("idle");
                  }}
                  className={selectClass}
                >
                  <option value="ollama">Ollama (Local)</option>
                  <option value="openai">OpenAI (Cloud)</option>
                  <option value="anthropic">Anthropic (Cloud)</option>
                </select>
                <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                  <ChevronDown className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>

            {config.provider === "ollama" ? (
              <div className="space-y-3">
                {/* Models Dropdown */}
                <div className="flex flex-col gap-1">
                  <label className={labelClass}>Model</label>
                  <div className="flex gap-1.5">
                    <div className="relative flex-1">
                      <select
                        value={config.model}
                        onChange={(e) =>
                          setConfig({ ...config, model: e.target.value })
                        }
                        className={selectClass}
                      >
                        <option value="" disabled>
                          Select a model...
                        </option>
                        {ollamaModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                        {!ollamaModels.includes(config.model) &&
                          config.model && (
                            <option value={config.model}>{config.model}</option>
                          )}
                      </select>
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                        <ChevronDown className="w-3.5 h-3.5" />
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        aiService.getModels().then((list) => {
                          const ollama = list
                            .filter((m) => m.provider === "ollama")
                            .map((m) => m.name);
                          setOllamaModels(ollama);
                        });
                      }}
                      title="Refresh Models"
                      className={`p-1.5 rounded-lg ${t.surface} ${t.surfaceHover} transition-colors`}
                    >
                      <svg
                        className="w-4 h-4 opacity-70"
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
                </div>

                {/* Base URL Input */}
                <div className="flex flex-col gap-1">
                  <label className={labelClass}>Ollama Base URL</label>
                  <input
                    type="text"
                    value={config.baseUrl || "http://localhost:11434"}
                    onChange={(e) =>
                      setConfig({ ...config, baseUrl: e.target.value })
                    }
                    placeholder="http://localhost:11434"
                    className={inputClass}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-col gap-1">
                  <label className={labelClass}>Model Name</label>
                  <input
                    type="text"
                    value={config.model}
                    placeholder={
                      config.provider === "openai" ? "gpt-4o" : "claude-3-opus"
                    }
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
              </div>
            )}

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
              <label className={`text-xs font-medium flex items-center gap-1.5 ${t.textMuted}`}>
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Context Window
              </label>
              <div className={`text-[10px] ${t.textFaint}`}>Max tokens sent to AI</div>
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
                className="flex-1 accent-purple-500 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer"
              />
              <span className={`text-xs font-mono min-w-12 text-right ${t.accent}`}>
                {((config.contextWindow || 4000) / 1000).toFixed(0)}k
              </span>
            </div>
          </div>
        </div>

        {/* Appearance Settings */}
        <div className="space-y-3">
          <h3 className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider`}>
            Appearance
          </h3>

          <div className={cardClass}>
            <label className={`text-xs font-medium mb-2 block ${t.textMuted}`}>Theme</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {([
                { id: "light" as const, label: "Light", icon: Sun, iconBg: "bg-amber-100 text-amber-600", activeBorder: "border-blue-500 bg-blue-500/10" },
                { id: "dark" as const, label: "Dark", icon: Moon, iconBg: "bg-gray-700 text-blue-300", activeBorder: "border-blue-500 bg-blue-500/10" },
                { id: "system" as const, label: "System", icon: Laptop, iconBg: "bg-gray-600 text-white", activeBorder: "border-blue-500 bg-blue-500/10" },
                { id: "modern" as const, label: "Modern", icon: Gem, iconBg: "bg-purple-500/30 text-purple-300", activeBorder: "border-purple-500 bg-purple-500/10 shadow-[0_0_12px_rgba(168,85,247,0.15)]" },
              ] as const).map(({ id, label, icon: Icon, iconBg, activeBorder }) => (
                <button
                  key={id}
                  onClick={() => setTheme(id)}
                  className={`p-2 border rounded-xl flex flex-col items-center gap-1.5 transition-all ${
                    theme === id
                      ? activeBorder
                      : `${t.borderSubtle} ${t.surfaceHover} bg-black/10`
                  }`}
                >
                  <div className={`w-6 h-6 rounded-full ${iconBg} flex items-center justify-center`}>
                    <Icon className="w-3 h-3" />
                  </div>
                  <span className="text-[10px] font-medium">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPane;
