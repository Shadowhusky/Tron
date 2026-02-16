import React, { useState, useEffect } from "react";
import { aiService, type AIConfig } from "../../../services/ai";
import { useTheme } from "../../../contexts/ThemeContext";
import {
  Gem,
  Laptop,
  Moon,
  Sun,
  SlidersHorizontal,
  Save,
  ChevronDown,
} from "lucide-react";

interface SettingsPaneProps {}

const SettingsPane: React.FC<SettingsPaneProps> = () => {
  const { theme, resolvedTheme, setTheme } = useTheme();
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

  return (
    <div
      className={`w-full h-full overflow-y-auto p-6 flex flex-col items-center
      ${
        resolvedTheme === "light"
          ? "bg-white text-gray-900"
          : resolvedTheme === "modern"
            ? "bg-[#050510] text-gray-200"
            : "bg-[#0a0a0a] text-gray-300"
      }
    `}
    >
      <div className="w-full max-w-2xl flex flex-col gap-6 pb-20">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div>
            <h1
              className={`text-xl font-bold ${resolvedTheme === "light" ? "text-gray-900" : "text-white"}`}
            >
              Settings
            </h1>
            <p className="text-gray-500 text-sm mt-0.5">
              Manage AI providers, models, and appearance.
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={!hasChanges && saveStatus !== "saved"}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg font-medium text-sm transition-all ${
              saveStatus === "saved"
                ? "bg-green-500/20 text-green-500"
                : hasChanges
                  ? "bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/20"
                  : "bg-gray-500/10 text-gray-400 cursor-not-allowed"
            }`}
          >
            <Save className="w-4 h-4" />
            {saveStatus === "saved" ? "Saved" : "Save Changes"}
          </button>
        </div>

        {/* AI Settings */}
        <div className="space-y-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            AI Configuration
          </h3>

          <div className="grid gap-4 p-4 rounded-xl border border-white/5 bg-white/5">
            {/* Provider */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Provider</label>
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
                  className={`w-full p-2 pr-8 text-sm rounded-lg border outline-none appearance-none transition-colors
                      ${
                        resolvedTheme === "light"
                          ? "bg-white border-gray-200 text-gray-900 focus:border-purple-500"
                          : "bg-black/20 border-white/10 text-white focus:bg-black/40 focus:border-purple-500/50"
                      }
                    `}
                >
                  <option value="ollama">Ollama (Local)</option>
                  <option value="openai">OpenAI (Cloud)</option>
                  <option value="anthropic">Anthropic (Cloud)</option>
                </select>
                <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                  <ChevronDown className="w-4 h-4" />
                </div>
              </div>
            </div>

            {config.provider === "ollama" ? (
              <div className="space-y-4">
                {/* Models Dropdown */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Model</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <select
                        value={config.model}
                        onChange={(e) =>
                          setConfig({ ...config, model: e.target.value })
                        }
                        className={`w-full p-2 pr-8 text-sm rounded-lg border outline-none appearance-none
                           ${
                             resolvedTheme === "light"
                               ? "bg-white border-gray-200 text-gray-900 focus:border-purple-500"
                               : "bg-black/20 border-white/10 text-white focus:bg-black/40 focus:border-purple-500/50"
                           }
                          `}
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
                        <ChevronDown className="w-4 h-4" />
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
                      className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 transition-colors"
                    >
                      <svg
                        className="w-5 h-5 opacity-70"
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
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Ollama Base URL</label>
                  <input
                    type="text"
                    value={config.baseUrl || "http://localhost:11434"}
                    onChange={(e) =>
                      setConfig({ ...config, baseUrl: e.target.value })
                    }
                    placeholder="http://localhost:11434"
                    className={`w-full p-2 text-sm rounded-lg border outline-none 
                         ${
                           resolvedTheme === "light"
                             ? "bg-white border-gray-200 text-gray-900 focus:border-purple-500"
                             : "bg-black/20 border-white/10 text-white focus:bg-black/40 focus:border-purple-500/50"
                         }
                      `}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Model Name</label>
                  <input
                    type="text"
                    value={config.model}
                    placeholder={
                      config.provider === "openai" ? "gpt-4o" : "claude-3-opus"
                    }
                    onChange={(e) =>
                      setConfig({ ...config, model: e.target.value })
                    }
                    className={`w-full p-2 text-sm rounded-lg border outline-none 
                         ${
                           resolvedTheme === "light"
                             ? "bg-white border-gray-200 text-gray-900 focus:border-purple-500"
                             : "bg-black/20 border-white/10 text-white focus:bg-black/40 focus:border-purple-500/50"
                         }
                      `}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">API Key</label>
                  <input
                    type="password"
                    value={config.apiKey || ""}
                    onChange={(e) =>
                      setConfig({ ...config, apiKey: e.target.value })
                    }
                    className={`w-full p-2 text-sm rounded-lg border outline-none 
                         ${
                           resolvedTheme === "light"
                             ? "bg-white border-gray-200 text-gray-900 focus:border-purple-500"
                             : "bg-black/20 border-white/10 text-white focus:bg-black/40 focus:border-purple-500/50"
                         }
                      `}
                  />
                </div>
              </div>
            )}

            {/* Test Connection Button */}
            <div className="flex justify-end pt-2">
              <button
                onClick={handleTestConnection}
                disabled={testStatus === "testing" || !config.model}
                className={`text-xs px-4 py-1.5 rounded-lg border transition-colors ${
                  testStatus === "success"
                    ? "border-green-500/50 text-green-400 bg-green-500/10"
                    : testStatus === "error"
                      ? "border-red-500/50 text-red-400 bg-red-500/10"
                      : "border-white/10 text-gray-400 hover:text-white hover:bg-white/5"
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
          <div className="p-4 rounded-xl border border-white/5 bg-white/5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4" />
                Context Window
              </label>
              <div className="text-xs text-gray-500">Max tokens sent to AI</div>
            </div>

            <div className="flex items-center gap-4">
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
                className="flex-1 accent-purple-500 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer"
              />
              <span className="text-sm font-mono min-w-16 text-right text-purple-400">
                {((config.contextWindow || 4000) / 1000).toFixed(0)}k
              </span>
            </div>
          </div>
        </div>

        {/* Appearance Settings */}
        <div className="space-y-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Appearance
          </h3>

          <div className="p-4 rounded-xl border border-white/5 bg-white/5">
            <label className="text-sm font-medium mb-3 block">Theme</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <button
                onClick={() => setTheme("light")}
                className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-all ${
                  theme === "light"
                    ? "border-blue-500 bg-blue-500/10"
                    : "border-white/5 hover:bg-white/5 bg-black/20"
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center">
                  <Sun className="w-4 h-4" />
                </div>
                <span className="text-xs font-medium">Light</span>
              </button>

              <button
                onClick={() => setTheme("dark")}
                className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-all ${
                  theme === "dark"
                    ? "border-blue-500 bg-blue-500/10"
                    : "border-white/5 hover:bg-white/5 bg-black/20"
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gray-700 text-blue-300 flex items-center justify-center">
                  <Moon className="w-4 h-4" />
                </div>
                <span className="text-xs font-medium">Dark</span>
              </button>

              <button
                onClick={() => setTheme("system")}
                className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-all ${
                  theme === "system"
                    ? "border-blue-500 bg-blue-500/10"
                    : "border-white/5 hover:bg-white/5 bg-black/20"
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gray-600 text-white flex items-center justify-center">
                  <Laptop className="w-4 h-4" />
                </div>
                <span className="text-xs font-medium">System</span>
              </button>

              <button
                onClick={() => setTheme("modern")}
                className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-all ${
                  theme === "modern"
                    ? "border-purple-500 bg-purple-500/10 shadow-[0_0_15px_rgba(168,85,247,0.2)]"
                    : "border-white/5 hover:bg-white/5 bg-black/20"
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-purple-500/30 text-purple-300 flex items-center justify-center">
                  <Gem className="w-4 h-4" />
                </div>
                <span className="text-xs font-medium">Modern</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPane;
