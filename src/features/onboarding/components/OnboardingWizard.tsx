import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "../../../contexts/ThemeContext";
import type { AIConfig, AIModel } from "../../../types";
import { aiService } from "../../../services/ai";
import { Shield, Monitor, Brain, Check, Gem } from "lucide-react";
import FeatureIcon from "../../../components/ui/FeatureIcon";
import {
  fadeScale,
  overlay,
  staggerContainer,
  staggerItem,
  scalePop,
} from "../../../utils/motion";

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
  const { theme, resolvedTheme, setTheme } = useTheme();
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
  const [stepDirection, setStepDirection] = useState(1); // 1 = forward, -1 = back
  const [permissionStatus, setPermissionStatus] = useState<
    "idle" | "fixing" | "waitingForUser" | "success" | "error"
  >("idle");
  const [aiConfig, setAiConfig] = useState<AIConfig>(aiService.getConfig());
  const [ollamaModels, setOllamaModels] = useState<AIModel[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");

  // Fetch Ollama models on mount, then lazy-load capabilities
  useEffect(() => {
    aiService.getModels().then(async (list) => {
      const ollama = list.filter((m) => m.provider === "ollama");
      setOllamaModels(ollama);
      for (const m of ollama) {
        m.capabilities = await aiService.getModelCapabilities(m.name);
      }
      setOllamaModels([...ollama]);
    });
  }, []);

  const handleFixPermissions = async () => {
    setPermissionStatus("fixing");
    try {
      if (!window.electron?.ipcRenderer?.checkPermissions) {
        setPermissionStatus("error");
        alert(
          "Update incomplete. Please restart the app (Ctrl+C in terminal, then npm run dev) to apply changes.",
        );
        return;
      }

      const hasFDA = await window.electron.ipcRenderer.checkPermissions();

      if (!hasFDA) {
        await window.electron.ipcRenderer.openPrivacySettings();
        setPermissionStatus("waitingForUser");
        return;
      }

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
      setStepDirection(1);
      setCurrentStep((c) => c + 1);
    } else {
      aiService.saveConfig(aiConfig);
      onComplete();
    }
  };

  const handleBack = () => {
    setStepDirection(-1);
    setCurrentStep((c) => Math.max(0, c - 1));
  };

  const stepVariants = {
    hidden: { opacity: 0, x: stepDirection > 0 ? 40 : -40 },
    visible: { opacity: 1, x: 0, transition: { duration: 0.3, ease: "easeOut" as const } },
    exit: { opacity: 0, x: stepDirection > 0 ? -40 : 40, transition: { duration: 0.2, ease: "easeIn" as const } },
  };

  const renderStepContent = () => {
    switch (STEPS[currentStep].id) {
      case "permissions":
        return (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="flex flex-col items-center gap-6 py-8"
          >
            <motion.div variants={scalePop}>
              <FeatureIcon
                icon={
                  permissionStatus === "success"
                    ? Check
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
            </motion.div>

            <motion.div variants={staggerItem} className="text-center space-y-2 max-w-sm">
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
            </motion.div>

            <AnimatePresence mode="wait">
              {permissionStatus === "success" ? (
                <motion.div
                  key="success"
                  variants={scalePop}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="flex items-center gap-2 text-green-500 font-medium bg-green-500/10 px-4 py-2 rounded-full border border-green-500/20"
                >
                  <Check className="w-4 h-4" />
                  <span>Permissions Verified</span>
                </motion.div>
              ) : (
                <motion.div
                  key="actions"
                  variants={staggerItem}
                  initial="hidden"
                  animate="visible"
                  className="flex flex-col items-center gap-3"
                >
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={handleFixPermissions}
                    disabled={permissionStatus === "fixing"}
                    className={`px-6 py-2.5 rounded-xl font-medium text-sm transition-all shadow-lg ${
                      permissionStatus === "fixing"
                        ? "bg-gray-100 text-gray-400 shadow-none"
                        : permissionStatus === "waitingForUser"
                          ? "bg-orange-500 text-white shadow-orange-500/20"
                          : "bg-purple-600 text-white shadow-purple-500/20"
                    }`}
                  >
                    {permissionStatus === "fixing"
                      ? "Checking..."
                      : permissionStatus === "waitingForUser"
                        ? "I've Enabled It, Verify"
                        : permissionStatus === "error"
                          ? "Open Settings & Retry"
                          : "Open System Settings"}
                  </motion.button>

                  {(permissionStatus === "error" ||
                    permissionStatus === "waitingForUser") && (
                    <button
                      onClick={() => setPermissionStatus("success")}
                      className="text-xs text-gray-400 hover:text-gray-300 underline underline-offset-2 transition-colors"
                    >
                      Skip verification (Development Mode)
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );

      case "theme":
        return (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="flex flex-col items-center gap-6 py-8"
          >
            <motion.div variants={scalePop}>
              <FeatureIcon
                icon={theme === "modern" ? Gem : Monitor}
                color={theme === "modern" ? "purple" : "blue"}
                size="lg"
              />
            </motion.div>
            <motion.div variants={staggerItem} className="text-center space-y-2">
              <h3 className="font-medium text-lg">Choose Appearance</h3>
              <p className="text-sm text-gray-500 max-w-xs">
                Select a theme that best suits your working environment.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="hidden"
              animate="visible"
              className="grid grid-cols-2 gap-3 w-full"
            >
              {[
                { id: "light" as const, label: "Light", swatch: <div className="w-8 h-8 rounded-full bg-gray-200 border border-gray-300" /> },
                { id: "dark" as const, label: "Dark", swatch: <div className="w-8 h-8 rounded-full bg-gray-900 border border-gray-700" /> },
                { id: "system" as const, label: "Auto", swatch: (
                  <div className="w-8 h-8 rounded-full border border-gray-500/30 overflow-hidden flex relative">
                    <div className="flex-1 bg-gray-200" />
                    <div className="flex-1 bg-gray-900" />
                  </div>
                ) },
                { id: "modern" as const, label: "Modern", swatch: (
                  <div className={`p-1.5 rounded-lg transition-colors ${theme === "modern" ? "bg-purple-500/20 text-purple-400" : "text-gray-400"}`}>
                    <Gem className="w-6 h-6" />
                  </div>
                ) },
              ].map(({ id, label, swatch }) => (
                <motion.button
                  key={id}
                  variants={staggerItem}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setTheme(id)}
                  className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-colors ${
                    theme === id
                      ? id === "modern"
                        ? "border-purple-500/50 bg-black/40 shadow-[0_0_20px_rgba(168,85,247,0.15)] ring-1 ring-purple-500/50 backdrop-blur-xl"
                        : "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500"
                      : "border-transparent hover:bg-white/5 bg-white/5"
                  }`}
                >
                  {swatch}
                  <span className="text-sm font-medium">{label}</span>
                </motion.button>
              ))}
            </motion.div>
          </motion.div>
        );

      case "ai":
        return (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="flex flex-col items-center gap-6 py-8"
          >
            <motion.div variants={scalePop}>
              <FeatureIcon icon={Brain} color="orange" size="lg" />
            </motion.div>
            <motion.div variants={staggerItem} className="text-center space-y-2">
              <h3 className="font-medium text-lg">Configure Intelligence</h3>
              <p className="text-sm text-gray-500 max-w-xs">
                Choose your preferred AI provider and model to power Tron's
                intelligent features.
              </p>
            </motion.div>
            <motion.div variants={staggerItem} className="space-y-4 w-full">
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
                        resolvedTheme === "light"
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

              <AnimatePresence mode="wait">
                {aiConfig.provider === "ollama" ? (
                  <motion.div
                    key="ollama"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25 }}
                    className="flex flex-col gap-4 overflow-hidden"
                  >
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium opacity-80">
                        Ollama URL
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={aiConfig.baseUrl || "http://localhost:11434"}
                          onChange={(e) => {
                            const newUrl = e.target.value;
                            setAiConfig((c) => ({ ...c, baseUrl: newUrl }));
                          }}
                          onBlur={() => {
                            aiService.getModels(aiConfig.baseUrl).then((list) => {
                              setOllamaModels(list.filter((m) => m.provider === "ollama"));
                            });
                          }}
                          className={`flex-1 p-2.5 rounded-lg border outline-none focus:border-purple-500 transition-colors
                            ${
                              resolvedTheme === "light"
                                ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                                : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50"
                            }
                          `}
                          placeholder="http://localhost:11434"
                        />
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => {
                            setOllamaModels([]);
                            aiService.getModels(aiConfig.baseUrl).then((list) => {
                              setOllamaModels(list.filter((m) => m.provider === "ollama"));
                            });
                          }}
                          className={`px-3 py-2 rounded-lg border transition-colors ${
                            resolvedTheme === "light"
                              ? "border-gray-200 hover:bg-gray-50 text-gray-600"
                              : "border-white/10 hover:bg-white/5 text-gray-400"
                          }`}
                          title="Refresh Models"
                        >
                          Refresh
                        </motion.button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium opacity-80">
                        Model
                      </label>
                      <div
                        className={`w-full rounded-lg border overflow-hidden max-h-48 overflow-y-auto ${
                          resolvedTheme === "light"
                            ? "bg-white border-gray-200"
                            : "bg-black/20 border-white/10"
                        }`}
                      >
                        {ollamaModels.length === 0 && (
                          <div className="px-3 py-2 text-xs italic text-gray-500">
                            No models found
                          </div>
                        )}
                        {ollamaModels.map((m, i) => (
                          <motion.button
                            key={m.name}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: i * 0.03 }}
                            onClick={() =>
                              setAiConfig((c) => ({ ...c, model: m.name }))
                            }
                            className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                              aiConfig.model === m.name
                                ? "bg-purple-500/10 text-purple-400"
                                : resolvedTheme === "light"
                                  ? "text-gray-700 hover:bg-gray-50"
                                  : "text-gray-300 hover:bg-white/5"
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
                          </motion.button>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="cloud"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25 }}
                    className="space-y-4 overflow-hidden"
                  >
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
                            resolvedTheme === "light"
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
                            resolvedTheme === "light"
                              ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                              : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50"
                          }
                        `}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex justify-end pt-2">
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
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
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <AnimatePresence>
        {isWindowTooSmall && (
          <motion.div
            key="too-small"
            variants={overlay}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute inset-0 z-60 flex items-center justify-center bg-black/90 backdrop-blur-md text-center p-8"
          >
            <motion.div variants={fadeScale} initial="hidden" animate="visible" className="space-y-4 max-w-md">
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        variants={fadeScale}
        initial="hidden"
        animate="visible"
        className={`w-full max-w-[500px] flex flex-col rounded-2xl shadow-2xl overflow-hidden
          ${resolvedTheme === "light" ? "bg-white text-gray-900 border border-gray-200" : ""}
          ${resolvedTheme === "dark" ? "bg-gray-900 text-white border border-white/10" : ""}
          ${resolvedTheme === "modern" ? "bg-black/80 text-white border border-white/10 backdrop-blur-2xl shadow-[0_0_50px_rgba(0,0,0,0.5)]" : ""}
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
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <motion.div
                key={i}
                animate={{
                  scale: i === currentStep ? 1.3 : 1,
                  backgroundColor: i === currentStep ? "#a855f7" : i < currentStep ? "#a855f7" : "rgba(107,114,128,0.3)",
                }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className="w-2 h-2 rounded-full"
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-6 min-h-[300px] overflow-hidden">
          <motion.div
            key={currentStep}
            className="mb-4 text-sm opacity-70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.7 }}
            transition={{ delay: 0.1 }}
          >
            {STEPS[currentStep].description}
          </motion.div>
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              variants={stepVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              {renderStepContent()}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-white/5 flex justify-between items-center bg-black/20">
          <motion.button
            whileHover={currentStep > 0 ? { x: -2 } : {}}
            whileTap={currentStep > 0 ? { scale: 0.95 } : {}}
            onClick={handleBack}
            disabled={currentStep === 0}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-white/5 disabled:opacity-0 transition-all"
          >
            Back
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={handleNext}
            disabled={
              STEPS[currentStep].id === "permissions" &&
              permissionStatus !== "success"
            }
            className="px-6 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-purple-900/20"
          >
            {currentStep === STEPS.length - 1 ? "Get Started" : "Next"}
          </motion.button>
        </div>
      </motion.div>
    </div>
  );
};

export default OnboardingWizard;
