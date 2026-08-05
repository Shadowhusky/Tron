import { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useTheme } from "../../../contexts/ThemeContext";
import { useConfig } from "../../../contexts/ConfigContext";
import { formatHotkey } from "../../../hooks/useHotkey";
import { sectorPath } from "../../../utils/tabWheel";
import type { AIConfig } from "../../../types";
import { aiService, getCloudProviderList, providerUsesBaseUrl } from "../../../services/ai";
import { Monitor, Gem, Terminal, Bot, Maximize2, Command, History } from "lucide-react";
import logoSvg from "../../../assets/logo.svg";
import {
  useModelsWithCaps,
  useInvalidateProviderModels,
} from "../../../hooks/useModels";
import FeatureIcon from "../../../components/ui/FeatureIcon";
import {
  fadeScale,
  staggerContainer,
  staggerItem,
  scalePop,
} from "../../../utils/motion";

interface OnboardingWizardProps {
  onComplete: () => void;
}

const STEPS = [
  {
    id: "theme",
    title: "Appearance",
    description: "Choose the look that suits your space.",
  },
  {
    id: "viewmode",
    title: "View Mode",
    description: "Pick the interface that fits your workflow.",
  },
  {
    id: "ai",
    title: "Intelligence",
    description: "Connect an AI provider — or do it later in Settings.",
  },
  {
    id: "features",
    title: "Highlights",
    description: "A few things worth knowing before you start.",
  },
];

/** Miniature of the actual tab-wheel geometry (see utils/tabWheel). */
const MiniWheel: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20">
    {[0, 1, 2, 3].map((i) => (
      <path
        key={i}
        d={sectorPath(10, 10, 3.5, 9, i * 90 - 42, i * 90 + 42)}
        fill="currentColor"
        opacity={i === 0 ? 1 : 0.3}
      />
    ))}
  </svg>
);

const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onComplete }) => {
  const { theme, resolvedTheme, setTheme, viewMode, setViewMode } = useTheme();
  const { hotkeys } = useConfig();
  const reduceMotion = useReducedMotion();
  const isLight = resolvedTheme === "light";
  const [currentStep, setCurrentStep] = useState(0);
  const [stepDirection, setStepDirection] = useState(1); // 1 = forward, -1 = back
  const [aiConfig, setAiConfig] = useState<AIConfig>(aiService.getConfig());
  const [connectionStatus, setConnectionStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [showValidationWarn, setShowValidationWarn] = useState(false);

  const isAiStep = STEPS[currentStep].id === "ai";
  const isLocalProvider = aiConfig.provider === "ollama" || aiConfig.provider === "lmstudio";
  const { data: allModels = [] } = useModelsWithCaps(
    providerUsesBaseUrl(aiConfig.provider) ? aiConfig.baseUrl : undefined,
    isAiStep && isLocalProvider,
    aiConfig.provider,
    aiConfig.apiKey,
  );
  const invalidateModels = useInvalidateProviderModels();
  const ollamaModels = allModels.filter((m) => m.provider === "ollama");
  const lmstudioModels = allModels.filter((m) => m.provider === "lmstudio");

  // Reset connection status when config changes
  useEffect(() => {
    setConnectionStatus("idle");
  }, [aiConfig.provider, aiConfig.model, aiConfig.apiKey, aiConfig.baseUrl]);

  // Auto-select first model when models load for local providers,
  // or when current model isn't in the available list
  const localModels = isLocalProvider
    ? (aiConfig.provider === "lmstudio" ? lmstudioModels : ollamaModels)
    : [];
  const firstLocalModel = localModels[0]?.name || "";
  const modelNames = localModels.map((m) => m.name);
  useEffect(() => {
    if (!firstLocalModel) return;
    setAiConfig((c) => {
      // Auto-select if no model chosen or current model isn't available
      if (!c.model || !modelNames.includes(c.model)) {
        return { ...c, model: firstLocalModel };
      }
      return c;
    });
  }, [firstLocalModel, modelNames.join(",")]);

  const handleTestConnection = async (): Promise<boolean> => {
    setConnectionStatus("testing");
    try {
      const result = await window.electron.ipcRenderer.testAIConnection(aiConfig);
      const success = typeof result === "boolean" ? result : result?.success;
      setConnectionStatus(success ? "success" : "error");
      return !!success;
    } catch {
      setConnectionStatus("error");
      return false;
    }
  };

  const advance = () => {
    setStepDirection(1);
    setCurrentStep((c) => c + 1);
    setShowValidationWarn(false);
  };

  const handleNext = async () => {
    // Leaving the AI step — validate (second click skips), save, then advance.
    if (STEPS[currentStep].id === "ai") {
      if (!aiConfig.model) {
        if (!showValidationWarn) {
          setShowValidationWarn(true);
          return;
        }
        aiService.saveConfig(aiConfig); // second click = skip
        advance();
        return;
      }
      if (isLocalProvider && connectionStatus !== "success") {
        if (showValidationWarn) {
          aiService.saveConfig(aiConfig); // second click after failed test = skip
          advance();
          return;
        }
        const ok = await handleTestConnection();
        if (ok) {
          aiService.saveConfig(aiConfig);
          advance();
        } else {
          setShowValidationWarn(true);
        }
        return;
      }
      // Cloud provider with model set, or local already tested
      aiService.saveConfig(aiConfig);
      advance();
      return;
    }

    if (currentStep < STEPS.length - 1) {
      advance();
      return;
    }
    onComplete();
  };

  const handleBack = () => {
    setStepDirection(-1);
    setCurrentStep((c) => Math.max(0, c - 1));
  };

  // Critically damped springs; enter/exit mirror along the same axis. Reduced
  // motion swaps the slide for a plain cross-fade.
  const stepVariants = {
    hidden: (dir: number) => ({
      opacity: 0,
      x: reduceMotion ? 0 : dir > 0 ? 40 : -40,
    }),
    visible: {
      opacity: 1,
      x: 0,
      transition: { type: "spring" as const, bounce: 0, duration: 0.4 },
    },
    exit: (dir: number) => ({
      opacity: 0,
      x: reduceMotion ? 0 : dir > 0 ? -40 : 40,
      transition: { duration: 0.15, ease: "easeIn" as const },
    }),
  };

  const renderStepContent = () => {
    switch (STEPS[currentStep].id) {
      case "theme":
        return (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="flex flex-col items-center gap-4 py-4"
          >
            <motion.div variants={scalePop}>
              <FeatureIcon
                icon={theme === "modern" ? Gem : Monitor}
                color="blue"
                size="lg"
              />
            </motion.div>
            <motion.div variants={staggerItem} className="text-center">
              <h3 className="font-semibold tracking-tight text-[15px]">Choose Appearance</h3>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="hidden"
              animate="visible"
              className="grid grid-cols-2 gap-3 w-full"
            >
              {[
                {
                  id: "light" as const,
                  label: "Light",
                  swatch: (
                    <div className="w-8 h-8 rounded-full bg-gray-200 border border-gray-300" />
                  ),
                },
                {
                  id: "dark" as const,
                  label: "Dark",
                  swatch: (
                    <div className="w-8 h-8 rounded-full bg-gray-900 border border-gray-700" />
                  ),
                },
                {
                  id: "system" as const,
                  label: "Auto",
                  swatch: (
                    <div className="w-8 h-8 rounded-full border border-gray-500/30 overflow-hidden flex relative">
                      <div className="flex-1 bg-gray-200" />
                      <div className="flex-1 bg-gray-900" />
                    </div>
                  ),
                },
                {
                  id: "modern" as const,
                  label: "Modern",
                  swatch: (
                    <div
                      className={`p-1.5 rounded-lg transition-colors ${theme === "modern" ? "bg-blue-500/20 text-blue-400" : "text-gray-400"}`}
                    >
                      <Gem className="w-6 h-6" />
                    </div>
                  ),
                },
              ].map(({ id, label, swatch }) => (
                <motion.button
                  key={id}
                  data-testid={`onboarding-theme-${id}`}
                  variants={staggerItem}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setTheme(id)}
                  className={`p-3 border rounded-xl flex flex-col items-center gap-2 transition-colors ${
                    theme === id
                      ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500"
                      : isLight
                        ? "border-transparent bg-gray-50 hover:bg-gray-100"
                        : "border-transparent bg-white/5 hover:bg-white/10"
                  }`}
                >
                  {swatch}
                  <span className="text-sm font-medium">{label}</span>
                </motion.button>
              ))}
            </motion.div>
          </motion.div>
        );

      case "viewmode":
        return (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="flex flex-col items-center gap-4 py-4"
          >
            <motion.div variants={scalePop}>
              <FeatureIcon icon={Monitor} color="blue" size="lg" />
            </motion.div>
            <motion.div variants={staggerItem} className="text-center">
              <h3 className="font-semibold tracking-tight text-[15px]">Choose Your View</h3>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="hidden"
              animate="visible"
              className="grid grid-cols-2 gap-3 w-full"
            >
              {(
                [
                  {
                    id: "terminal" as const,
                    label: "Terminal",
                    desc: "Traditional terminal with AI overlay",
                    icon: Terminal,
                    activeBorder:
                      "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500",
                  },
                  {
                    id: "agent" as const,
                    label: "Agent",
                    desc: "Chat-focused, AI-first interface",
                    icon: Bot,
                    activeBorder:
                      "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500",
                  },
                ] as const
              ).map(({ id, label, desc, icon: Icon, activeBorder }) => (
                <motion.button
                  key={id}
                  data-testid={`onboarding-view-${id}`}
                  variants={staggerItem}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setViewMode(id)}
                  className={`p-4 border rounded-xl flex flex-col items-center gap-2 transition-colors ${
                    viewMode === id
                      ? activeBorder
                      : isLight
                        ? "border-transparent bg-gray-50 hover:bg-gray-100"
                        : "border-transparent bg-white/5 hover:bg-white/10"
                  }`}
                >
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      id === "terminal"
                        ? "bg-gray-700 text-green-300"
                        : "bg-blue-500/30 text-blue-300"
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-[11px] text-gray-500 text-center">
                    {desc}
                  </span>
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
            className="flex flex-col gap-3 py-2"
          >
            <motion.div variants={staggerItem} className="space-y-3 w-full">
              <div className="flex flex-col gap-2">
                <label className="text-[13px] font-medium opacity-80">
                  AI Provider
                </label>
                <select
                  data-testid="onboarding-provider-select"
                  value={aiConfig.provider}
                  onChange={(e) => {
                    const newProvider = e.target.value;
                    const defaultBaseUrls: Record<string, string> = {
                      ollama: "http://localhost:11434",
                      lmstudio: "http://127.0.0.1:1234",
                    };
                    setAiConfig((c) => ({
                      ...c,
                      provider: newProvider as any,
                      model: "",
                      baseUrl: providerUsesBaseUrl(newProvider) ? (defaultBaseUrls[newProvider] || "") : undefined,
                    }));
                    setConnectionStatus("idle");
                  }}
                  className={`w-full p-2.5 pr-8 rounded-lg border outline-none focus:border-blue-500 transition-colors
                      ${
                        resolvedTheme === "light"
                          ? "bg-white border-gray-200 text-gray-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                          : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50"
                      }
                    `}
                >
                  <optgroup label="Local">
                    <option value="ollama" className="text-gray-900 bg-white">Ollama (Local)</option>
                    <option value="lmstudio" className="text-gray-900 bg-white">LM Studio (Local)</option>
                  </optgroup>
                  <optgroup label="Cloud">
                    {getCloudProviderList()
                      .filter(({ id }) => !["lmstudio", "openai-compat", "anthropic-compat"].includes(id))
                      .map(({ id, info }) => (
                        <option key={id} value={id} className="text-gray-900 bg-white">{info.label}</option>
                      ))}
                  </optgroup>
                  <optgroup label="Custom">
                    <option value="openai-compat" className="text-gray-900 bg-white">OpenAI Compatible</option>
                    <option value="anthropic-compat" className="text-gray-900 bg-white">Anthropic Compatible</option>
                  </optgroup>
                </select>
              </div>

              <AnimatePresence mode="wait">
                {isLocalProvider ? (
                  <motion.div
                    key="local"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25 }}
                    className="flex flex-col gap-4 overflow-hidden"
                  >
                    <div className="flex flex-col gap-2">
                      <label className="text-[13px] font-medium opacity-80">
                        {aiConfig.provider === "lmstudio" ? "LM Studio" : "Ollama"} URL
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={aiConfig.baseUrl || (aiConfig.provider === "lmstudio" ? "http://127.0.0.1:1234" : "http://localhost:11434")}
                          onChange={(e) => {
                            const newUrl = e.target.value;
                            setAiConfig((c) => ({ ...c, baseUrl: newUrl }));
                          }}
                          onBlur={() => {
                            invalidateModels();
                          }}
                          className={`flex-1 p-2.5 rounded-lg border outline-none focus:border-blue-500 transition-colors font-mono text-[12px]
                            ${
                              resolvedTheme === "light"
                                ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                                : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50"
                            }
                          `}
                          placeholder={aiConfig.provider === "lmstudio" ? "http://127.0.0.1:1234" : "http://localhost:11434"}
                        />
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => {
                            invalidateModels();
                          }}
                          className={`shrink-0 px-2.5 py-2 rounded-lg border text-xs transition-colors ${
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
                      <label className="text-[13px] font-medium opacity-80">
                        API Key (optional)
                      </label>
                      <input
                        type="password"
                        value={aiConfig.apiKey || ""}
                        onChange={(e) =>
                          setAiConfig((c) => ({ ...c, apiKey: e.target.value }))
                        }
                        placeholder="Leave empty if not required"
                        className={`w-full p-2.5 rounded-lg border outline-none focus:border-blue-500 transition-colors
                          ${
                            resolvedTheme === "light"
                              ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                              : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50"
                          }
                        `}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-[13px] font-medium opacity-80">
                        Model
                      </label>
                      {(() => {
                        const localModels = aiConfig.provider === "lmstudio" ? lmstudioModels : ollamaModels;
                        return (
                          <div
                            className={`w-full rounded-lg border overflow-hidden max-h-24 overflow-y-auto ${
                              resolvedTheme === "light"
                                ? "bg-white border-gray-200"
                                : "bg-black/20 border-white/10"
                            }`}
                          >
                            {localModels.length === 0 && (
                              <div className="px-3 py-2 text-xs italic text-gray-500">
                                No models found
                              </div>
                            )}
                            {localModels.map((m, i) => (
                              <motion.button
                                key={m.name}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: i * 0.03 }}
                                onClick={() =>
                                  setAiConfig((c) => ({ ...c, model: m.name }))
                                }
                                className={`w-full text-left px-3 py-2 text-[12px] font-mono flex items-center gap-2 transition-colors ${
                                  aiConfig.model === m.name
                                    ? "bg-blue-500/10 text-blue-400"
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
                                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                        cap === "thinking"
                                          ? "bg-blue-500/20 text-blue-400"
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
                        );
                      })()}
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
                    {(aiConfig.provider === "openai-compat" || aiConfig.provider === "anthropic-compat") && (
                      <div className="flex flex-col gap-2">
                        <label className="text-[13px] font-medium opacity-80">
                          Base URL
                        </label>
                        <input
                          type="text"
                          value={aiConfig.baseUrl || ""}
                          onChange={(e) =>
                            setAiConfig((c) => ({ ...c, baseUrl: e.target.value }))
                          }
                          placeholder={aiConfig.provider === "anthropic-compat" ? "https://your-proxy.example.com" : "https://your-api.example.com/v1"}
                          className={`w-full p-2.5 rounded-lg border outline-none focus:border-blue-500 transition-colors font-mono text-[12px]
                            ${
                              resolvedTheme === "light"
                                ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                                : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50"
                            }
                          `}
                        />
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <label className="text-[13px] font-medium opacity-80">
                        Model Name
                      </label>
                      <input
                        type="text"
                        value={aiConfig.model}
                        placeholder="e.g. gpt-4o"
                        onChange={(e) =>
                          setAiConfig((c) => ({ ...c, model: e.target.value }))
                        }
                        className={`w-full p-2.5 rounded-lg border outline-none focus:border-blue-500 transition-colors font-mono text-[12px]
                          ${
                            resolvedTheme === "light"
                              ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                              : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50"
                          }
                        `}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-[13px] font-medium opacity-80">
                        API Key{(aiConfig.provider === "openai-compat" || aiConfig.provider === "anthropic-compat") ? " (optional)" : ""}
                      </label>
                      <input
                        type="password"
                        value={aiConfig.apiKey || ""}
                        onChange={(e) =>
                          setAiConfig((c) => ({ ...c, apiKey: e.target.value }))
                        }
                        className={`w-full p-2.5 rounded-lg border outline-none focus:border-blue-500 transition-colors
                          ${
                            resolvedTheme === "light"
                              ? "bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                              : "bg-black/20 border-white/10 text-white placeholder-white/30 focus:bg-black/40 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50"
                          }
                        `}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {isLocalProvider && (
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
              )}
            </motion.div>
          </motion.div>
        );

      case "features": {
        const rows = [
          {
            icon: <MiniWheel />,
            tint: "text-blue-400 bg-blue-500/15",
            title: "Tab Wheel",
            desc: "Hold, point, release — flick between tabs like a game weapon wheel.",
            hint: formatHotkey(hotkeys.tabWheel),
          },
          {
            icon: <Maximize2 className="h-4 w-4" strokeWidth={1.8} />,
            tint: isLight ? "text-gray-600 bg-gray-200/70" : "text-gray-300 bg-white/10",
            title: "Maximize Pane",
            desc: "Zoom any split pane to fill the tab, then drop it back in place.",
            hint: formatHotkey(hotkeys.maximizePane),
          },
          {
            icon: <Command className="h-4 w-4" strokeWidth={1.8} />,
            tint: isLight ? "text-gray-600 bg-gray-200/70" : "text-gray-300 bg-white/10",
            title: "Command Palette",
            desc: "Every action — tabs, panes, themes — one keystroke away.",
            hint: formatHotkey(hotkeys.commandPalette),
          },
          {
            icon: <History className="h-4 w-4" strokeWidth={1.8} />,
            tint: "text-green-400 bg-green-500/15",
            title: "Sessions That Come Back",
            desc: "Claude Code and Codex conversations resume after a restart — on their own.",
            hint: "Automatic",
          },
        ];
        return (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="flex flex-col gap-2 py-2"
          >
            {rows.map((row) => (
              <motion.div
                key={row.title}
                variants={staggerItem}
                className={`flex items-center gap-3 rounded-xl border p-3 ${
                  isLight ? "border-gray-200 bg-gray-50" : "border-white/5 bg-white/5"
                }`}
              >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${row.tint}`}>
                  {row.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold tracking-tight">{row.title}</div>
                  <div className={`text-[12px] leading-snug ${isLight ? "text-gray-500" : "text-gray-400"}`}>
                    {row.desc}
                  </div>
                </div>
                <kbd
                  className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${
                    isLight
                      ? "border-gray-200 bg-white text-gray-500"
                      : "border-white/10 bg-black/20 text-gray-400"
                  }`}
                >
                  {row.hint}
                </kbd>
              </motion.div>
            ))}
          </motion.div>
        );
      }
    }
  };

  return (
    <div data-testid="onboarding-wizard" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <motion.div
        variants={fadeScale}
        initial="hidden"
        animate="visible"
        className={`w-full max-w-[360px] max-h-[calc(100dvh-2rem)] flex flex-col rounded-2xl shadow-2xl overflow-hidden
          ${resolvedTheme === "light" ? "bg-white text-gray-900 border border-gray-200" : ""}
          ${resolvedTheme === "dark" ? "bg-gray-900 text-white border border-white/10" : ""}
          ${resolvedTheme === "modern" ? "bg-[#0d0d0d] text-white border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)]" : ""}
        `}
      >
        {/* Header */}
        <div
          className={`px-5 py-3 sm:py-4 border-b flex items-center justify-between drag-region shrink-0 ${
            isLight ? "border-gray-200" : "border-white/5"
          }`}
          style={{ WebkitAppRegion: "drag", appRegion: "drag" } as any}
        >
          <div className="flex items-center gap-2.5">
            <img src={logoSvg} alt="Tron" className="w-8 h-8" />
            <div>
              <h2 className="text-base font-medium tracking-tight">Setup Tron</h2>
              <p className="text-[13px] opacity-60">
                Step {currentStep + 1} of {STEPS.length}:{" "}
                {STEPS[currentStep].title}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, i) => (
              <motion.div
                key={i}
                animate={{
                  width: i === currentStep ? 20 : 8,
                  backgroundColor:
                    i <= currentStep ? "#3b82f6" : "rgba(107,114,128,0.3)",
                }}
                transition={{ type: "spring", bounce: 0, duration: 0.35 }}
                className="h-2 rounded-full"
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="px-5 py-3 sm:py-4 min-h-0 flex-1 overflow-y-auto">
          <motion.div
            key={currentStep}
            className="mb-4 text-[13px] opacity-70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.7 }}
            transition={{ delay: 0.1 }}
          >
            {STEPS[currentStep].description}
          </motion.div>
          <AnimatePresence mode="wait" custom={stepDirection}>
            <motion.div
              key={currentStep}
              custom={stepDirection}
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
        <div className={`px-5 py-3 border-t flex flex-col gap-2 shrink-0 ${
          isLight ? "border-gray-200 bg-gray-50" : "border-white/5 bg-black/20"
        }`}>
          {showValidationWarn && (
            <motion.p
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className={`text-xs text-center ${isLight ? "text-amber-600" : "text-amber-400"}`}
            >
              {!aiConfig.model
                ? "No model validated yet — click again to skip."
                : connectionStatus === "error"
                  ? "Connection failed — click again to continue anyway."
                  : "Click again to skip."}
            </motion.p>
          )}
          <div className="flex justify-between items-center">
            <motion.button
              whileHover={currentStep > 0 ? { x: -2 } : {}}
              whileTap={currentStep > 0 ? { scale: 0.95 } : {}}
              onClick={handleBack}
              disabled={currentStep === 0}
              className="px-4 py-2 rounded-lg text-[13px] font-medium hover:bg-white/5 disabled:opacity-0 transition-all"
              data-testid="onboarding-prev"
            >
              Back
            </motion.button>
            <motion.button
              whileHover={connectionStatus !== "testing" ? { scale: 1.03 } : {}}
              whileTap={connectionStatus !== "testing" ? { scale: 0.97 } : {}}
              onClick={handleNext}
              disabled={connectionStatus === "testing"}
              data-testid="onboarding-next"
              className={`px-6 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                connectionStatus === "testing"
                  ? "bg-blue-500/60 text-white/70 cursor-wait"
                  : "bg-blue-500 hover:bg-blue-600 text-white"
              }`}
            >
              {connectionStatus === "testing"
                ? "Connecting..."
                : currentStep === STEPS.length - 1 ? "Get Started" : "Continue"}
            </motion.button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default OnboardingWizard;
