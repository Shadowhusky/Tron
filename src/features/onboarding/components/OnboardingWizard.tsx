import React, { useState, useEffect } from "react";
import { useTheme } from "../../../contexts/ThemeContext";
import { aiService, type AIConfig } from "../../../services/ai";
import { Shield, Monitor, Brain, Check, Gem } from "lucide-react";
import FeatureIcon from "../../../components/ui/FeatureIcon";

interface OnboardingWizardProps {
  onComplete: () => void;
}

const STEPS = [
  {
    id: "permissions",
    title: "System Check",
    description: "We need to verify system permissions to run terminals.",
  },
  {
    id: "theme",
    title: "Appearance",
    description: "Choose your preferred look and feel.",
  },
  {
    id: "ai",
    title: "Intelligence",
    description: "Configure your AI assistant.",
  },
];

const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onComplete }) => {
  const { theme, setTheme } = useTheme();
  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const isWindowTooSmall = windowSize.width < 600 || windowSize.height < 600;
  const [currentStep, setCurrentStep] = useState(0);
  const [permissionStatus, setPermissionStatus] = useState<
    "idle" | "fixing" | "waitingForUser" | "success" | "error"
  >("idle");
  const [aiConfig, setAiConfig] = useState<AIConfig>(aiService.getConfig());
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");

  // Fetch Ollama models on mount
  useEffect(() => {
    aiService.getModels().then((list) => {
      const ollama = list
        .filter((m) => m.provider === "ollama")
        .map((m) => m.name);
      setOllamaModels(ollama);
    });
  }, []);

  const handleFixPermissions = async () => {
    setPermissionStatus("fixing");
    try {
      // 0. Safety check for stale process
      if (!window.electron?.ipcRenderer?.checkPermissions) {
        setPermissionStatus("error");
        alert(
          "Update incomplete. Please restart the app (Ctrl+C in terminal, then npm run dev) to apply changes.",
        );
        return;
      }

      // 1. Check Full Disk Access (FDA)
      const hasFDA = await window.electron.ipcRenderer.checkPermissions();

      if (!hasFDA) {
        // Open Privacy Settings and switch to waiting state
        await window.electron.ipcRenderer.openPrivacySettings();
        setPermissionStatus("waitingForUser");
        return;
      }

      // 2. Fix Binary Permissions (chmod)
      const success = await window.electron.ipcRenderer.fixPermissions();
      setPermissionStatus(success ? "success" : "error");
    } catch (e) {
      console.error(e);
      setPermissionStatus("error");
    }
  };

  const handleTestConnection = async () => {
    setConnectionStatus("testing");
    try {
      const success =
        await window.electron.ipcRenderer.testAIConnection(aiConfig);
      setConnectionStatus(success ? "success" : "error");
    } catch (e) {
      setConnectionStatus("error");
    }
  };

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((c) => c + 1);
    } else {
      // Save and Finish
      aiService.saveConfig(aiConfig);
      onComplete();
    }
  };

  const renderStepContent = () => {
    switch (STEPS[currentStep].id) {
      case "permissions":
        return (
          <div className="flex flex-col items-center gap-6 py-8">
            <FeatureIcon
              icon={
                permissionStatus === "success"
                  ? Check
                  : permissionStatus === "waitingForUser"
                    ? Shield
                    : Shield
              }
              color={
                permissionStatus === "success"
                  ? "green"
                  : permissionStatus === "waitingForUser"
                    ? "orange"
                    : "purple"
              }
              size="lg"
            />

            <div className="text-center space-y-2 max-w-sm">
              <h3 className="font-medium text-lg">
                {permissionStatus === "waitingForUser"
                  ? "Enable Full Disk Access"
                  : "Grant Permissions"}
              </h3>

              {permissionStatus === "waitingForUser" ? (
                <div className="space-y-3">
                  <p className="text-sm text-gray-500">
                    Please toggle the switch for <b>Tron</b> in the settings
                    window.
                  </p>

                  <div className="flex items-center justify-center gap-2 text-xs text-gray-400 bg-white/5 py-1.5 px-3 rounded-full border border-white/5 mx-auto w-fit">
                    <span>Privacy & Security</span>
                    <span>→</span>
                    <span>Full Disk Access</span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-500">
                  Tron needs Full Disk Access to power your terminal sessions.
                </p>
              )}
            </div>

            {permissionStatus === "success" ? (
              <div className="flex items-center gap-2 text-green-500 font-medium animate-pulse bg-green-500/10 px-4 py-2 rounded-full border border-green-500/20">
                <Check className="w-4 h-4" />
                <span>Permissions Verified</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <button
                  onClick={handleFixPermissions}
                  disabled={permissionStatus === "fixing"}
                  className={`px-6 py-2.5 rounded-xl font-medium text-sm transition-all shadow-lg ${
                    permissionStatus === "fixing"
                      ? "bg-gray-100 text-gray-400 shadow-none"
                      : permissionStatus === "waitingForUser"
                        ? "bg-orange-500 hover:scale-105 text-white shadow-orange-500/20"
                        : "bg-purple-600 hover:scale-105 text-white shadow-purple-500/20"
                  }`}
                >
                  {permissionStatus === "fixing"
                    ? "Checking..."
                    : permissionStatus === "waitingForUser"
                      ? "I've Enabled It, Verify"
                      : permissionStatus === "error"
                        ? "Open Settings & Retry"
                        : "Open System Settings"}
                </button>

                {/* Skip option for stuck users (e.g. dev mode issues) */}
                {(permissionStatus === "error" ||
                  permissionStatus === "waitingForUser") && (
                  <button
                    onClick={() => setPermissionStatus("success")}
                    className="text-xs text-gray-400 hover:text-gray-300 underline underline-offset-2 transition-colors"
                  >
                    Skip verification (Development Mode)
                  </button>
                )}
              </div>
            )}
          </div>
        );

      case "theme":
        return (
          <div className="flex flex-col items-center gap-6 py-8">
            <FeatureIcon
              icon={theme === "modern" ? Gem : Monitor}
              color={theme === "modern" ? "purple" : "blue"}
              size="lg"
            />
            <div className="text-center space-y-2">
              <h3 className="font-medium text-lg">Choose Appearance</h3>
              <p className="text-sm text-gray-500 max-w-xs">
                Select a theme that best suits your working environment.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 w-full">
              <button
                onClick={() => setTheme("light")}
                className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-all ${
                  theme === "light"
                    ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500"
                    : "border-transparent hover:bg-white/5 bg-white/5"
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gray-200 border border-gray-300"></div>
                <span className="text-sm font-medium">Light</span>
              </button>

              <button
                onClick={() => setTheme("dark")}
                className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-all ${
                  theme === "dark"
                    ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500"
                    : "border-transparent hover:bg-white/5 bg-white/5"
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gray-900 border border-gray-700"></div>
                <span className="text-sm font-medium">Dark</span>
              </button>

              <button
                onClick={() => setTheme("system")}
                className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-all ${
                  theme === "system"
                    ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500"
                    : "border-transparent hover:bg-white/5 bg-white/5"
                }`}
              >
                <div className="w-8 h-8 rounded-full border border-gray-500/30 overflow-hidden flex relative">
                  <div className="flex-1 bg-gray-200"></div>
                  <div className="flex-1 bg-gray-900"></div>
                </div>
                <span className="text-sm font-medium">Auto</span>
              </button>

              <button
                onClick={() => setTheme("modern")}
                className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-all group ${
                  theme === "modern"
                    ? "border-purple-500/50 bg-black/40 shadow-[0_0_20px_rgba(168,85,247,0.15)] ring-1 ring-purple-500/50 backdrop-blur-xl"
                    : "border-transparent hover:bg-white/5 bg-white/5"
                }`}
              >
                <div
                  className={`p-1.5 rounded-lg transition-colors ${theme === "modern" ? "bg-purple-500/20 text-purple-400" : "text-gray-400 group-hover:text-gray-200"}`}
                >
                  <Gem className="w-6 h-6" />
                </div>
                <span className="text-sm font-medium">Modern</span>
              </button>
            </div>
          </div>
        );

      case "ai":
        return (
          <div className="flex flex-col items-center gap-6 py-8">
            <FeatureIcon icon={Brain} color="orange" size="lg" />
            <div className="text-center space-y-2">
              <h3 className="font-medium text-lg">Configure Intelligence</h3>
              <p className="text-sm text-gray-500 max-w-xs">
                Choose your preferred AI provider and model to power Tron's
                intelligent features.
              </p>
            </div>
            <div className="space-y-4 w-full">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium opacity-80">
                  AI Provider
                </label>
                <select
                  value={aiConfig.provider}
                  onChange={(e) =>
                    setAiConfig((c) => ({
                      ...c,
                      provider: e.target.value as any,
                      model: "",
                    }))
                  }
                  className={`w-full p-2.5 rounded-lg border outline-none focus:border-purple-500 transition-colors 
                      ${
                        theme === "light"
                          ? "bg-white border-gray-200 text-gray-900 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                          : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50"
                      }
                    `}
                >
                  <option value="ollama" className="text-gray-900 bg-white">
                    Ollama (Local)
                  </option>
                  <option value="openai" className="text-gray-900 bg-white">
                    OpenAI
                  </option>
                  <option value="anthropic" className="text-gray-900 bg-white">
                    Anthropic
                  </option>
                </select>
              </div>

              {aiConfig.provider === "ollama" ? (
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium opacity-80">
                    Model
                  </label>
                  <select
                    value={aiConfig.model}
                    onChange={(e) =>
                      setAiConfig((c) => ({ ...c, model: e.target.value }))
                    }
                    className={`w-full p-2.5 rounded-lg border outline-none focus:border-purple-500 transition-colors 
                      ${
                        theme === "light"
                          ? "bg-white border-gray-200 text-gray-900 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                          : "bg-black/20 border-white/10 text-white focus:bg-black/40 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50"
                      }
                    `}
                  >
                    <option value="" className="text-gray-900 bg-white">
                      Select a model...
                    </option>
                    {ollamaModels.map((m) => (
                      <option
                        key={m}
                        value={m}
                        className="text-gray-900 bg-white"
                      >
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium opacity-80">
                      Model Name
                    </label>
                    <input
                      type="text"
                      value={aiConfig.model}
                      placeholder="e.g. gpt-4o"
                      onChange={(e) =>
                        setAiConfig((c) => ({ ...c, model: e.target.value }))
                      }
                      className={`w-full p-2.5 rounded-lg border outline-none focus:border-purple-500 transition-colors 
                        ${
                          theme === "light"
                            ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                            : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50"
                        }
                      `}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium opacity-80">
                      API Key
                    </label>
                    <input
                      type="password"
                      value={aiConfig.apiKey || ""}
                      onChange={(e) =>
                        setAiConfig((c) => ({ ...c, apiKey: e.target.value }))
                      }
                      className={`w-full p-2.5 rounded-lg border outline-none focus:border-purple-500 transition-colors 
                        ${
                          theme === "light"
                            ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                            : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50"
                        }
                      `}
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button
                  onClick={handleTestConnection}
                  disabled={connectionStatus === "testing" || !aiConfig.model}
                  className={`px-4 py-2 rounded-lg text-xs font-medium border transition-colors ${
                    connectionStatus === "success"
                      ? "border-green-500 text-green-500 bg-green-500/10"
                      : connectionStatus === "error"
                        ? "border-red-500 text-red-500 bg-red-500/10"
                        : "border-white/10 hover:bg-white/5"
                  }`}
                >
                  {connectionStatus === "testing"
                    ? "Connecting..."
                    : connectionStatus === "success"
                      ? "Connected"
                      : connectionStatus === "error"
                        ? "Connection Failed"
                        : "Test Connection"}
                </button>
              </div>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      {isWindowTooSmall && (
        <div className="absolute inset-0 z-60 flex items-center justify-center bg-black/90 backdrop-blur-md text-center p-8">
          <div className="space-y-4 max-w-md">
            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <Monitor className="w-8 h-8 text-red-500" />
            </div>
            <h3 className="text-xl font-bold">Window Too Small</h3>
            <p className="text-gray-400">
              Please resize your window to at least 600x600 pixels to continue
              setup.
            </p>
            <div className="text-xs text-gray-600 font-mono mt-4">
              Current: {windowSize.width}x{windowSize.height}
            </div>
          </div>
        </div>
      )}

      <div
        className={`w-full max-w-[500px] flex flex-col rounded-2xl shadow-2xl overflow-hidden transition-all duration-300 
          ${theme === "dark" ? "bg-gray-900 text-white border border-white/10" : ""}
          ${theme === "light" ? "bg-white text-gray-900 border border-gray-200" : ""}
          ${theme === "modern" ? "bg-black/80 text-white border border-white/10 backdrop-blur-2xl shadow-[0_0_50px_rgba(0,0,0,0.5)]" : ""}
          ${theme === "system" ? "bg-gray-900 text-white border border-white/10" : ""} 
        `}
      >
        {/* Header */}
        <div
          className="p-6 border-b border-white/5 flex items-center justify-between drag-region"
          style={{ WebkitAppRegion: "drag", appRegion: "drag" } as any}
        >
          <div>
            <h2 className="text-xl font-bold">Setup Tron</h2>
            <p className="text-sm opacity-60">
              Step {currentStep + 1} of {STEPS.length}:{" "}
              {STEPS[currentStep].title}
            </p>
          </div>
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-colors ${i === currentStep ? "bg-purple-500" : "bg-gray-500/30"}`}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-6 min-h-[300px]">
          <div className="mb-4 text-sm opacity-70">
            {STEPS[currentStep].description}
          </div>
          {renderStepContent()}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-white/5 flex justify-between items-center bg-black/20">
          <button
            onClick={() => setCurrentStep((c) => Math.max(0, c - 1))}
            disabled={currentStep === 0}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-white/5 disabled:opacity-0 transition-all"
          >
            Back
          </button>
          <button
            onClick={handleNext}
            disabled={
              STEPS[currentStep].id === "permissions" &&
              permissionStatus !== "success"
            }
            className="px-6 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-purple-900/20"
          >
            {currentStep === STEPS.length - 1 ? "Get Started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OnboardingWizard;
