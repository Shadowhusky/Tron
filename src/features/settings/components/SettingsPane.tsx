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
  Star,
  Sparkles,
  Globe,
  Trash2,
  Plus,
  Wifi,
  RefreshCw,
  Copy,
  ExternalLink,
} from "lucide-react";


// Per-provider saved configs (model, apiKey, baseUrl)
type ProviderCache = Record<string, { model?: string; apiKey?: string; baseUrl?: string }>;

const HOTKEY_LABELS: Record<string, string> = {
  newTab: "New Tab",
  closeTab: "Close Tab",
  splitHorizontal: "Split Horizontal",
  splitVertical: "Split Vertical",
  openSettings: "Open Settings",
  toggleOverlay: "Toggle Agent Panel",
  stopAgent: "Stop Agent",
  clearTerminal: "Clear Terminal",
  clearAgent: "Clear Agent Panel",
  modeCommand: "Command Mode",
  modeAdvice: "Advice Mode",
  modeAgent: "Agent Mode",
  modeAuto: "Auto Mode",
  cycleMode: "Cycle Mode",
  forceAgent: "Force Agent (in input)",
  forceCommand: "Force Command (in input)",
};

const NAV_SECTIONS_BASE = [
  { id: "ai", label: "AI", icon: Cpu },
  { id: "ai-features", label: "AI Features", icon: Sparkles },
  { id: "view", label: "View Mode", icon: Monitor },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "web-server", label: "Web Server", icon: Wifi },
  { id: "ssh", label: "SSH", icon: Globe },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
] as const;

// Web Server section only shown in Electron mode
const NAV_SECTIONS = window.electron
  ? NAV_SECTIONS_BASE
  : NAV_SECTIONS_BASE.filter((s) => s.id !== "web-server");

// --- SSH Profiles Sub-component ---
function SSHProfilesSection({ cardClass, t, resolvedTheme }: {
  cardClass: string;
  t: any;
  resolvedTheme: string;
}) {
  const [profiles, setProfiles] = useState<any[]>([]);
  const refreshProfiles = useCallback(() => {
    const ipc = window.electron?.ipcRenderer;
    if (ipc?.readSSHProfiles) {
      ipc.readSSHProfiles().then(setProfiles).catch(() => { });
    }
  }, []);
  useEffect(() => {
    refreshProfiles();
    // Refresh when SSH modal closes (new profile may have been created)
    window.addEventListener("focus", refreshProfiles);
    window.addEventListener("tron:ssh-profiles-changed", refreshProfiles);
    return () => {
      window.removeEventListener("focus", refreshProfiles);
      window.removeEventListener("tron:ssh-profiles-changed", refreshProfiles);
    };
  }, [refreshProfiles]);
  const deleteProfile = async (id: string) => {
    const updated = profiles.filter((p: any) => p.id !== id);
    const ipc = window.electron?.ipcRenderer;
    if (ipc?.writeSSHProfiles) {
      await ipc.writeSSHProfiles(updated);
    }
    setProfiles(updated);
  };
  const toggleCredentials = async (id: string) => {
    const updated = profiles.map((p: any) =>
      p.id === id ? { ...p, saveCredentials: !p.saveCredentials, ...(!p.saveCredentials ? {} : { savedPassword: undefined, savedPassphrase: undefined }) } : p,
    );
    const ipc = window.electron?.ipcRenderer;
    if (ipc?.writeSSHProfiles) {
      await ipc.writeSSHProfiles(updated);
    }
    setProfiles(updated);
  };
  const openSSHModal = () => {
    window.dispatchEvent(new CustomEvent("tron:open-ssh-modal"));
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}>
          <Globe className="w-3.5 h-3.5" />
          SSH Profiles
        </h3>
        <button
          onClick={openSSHModal}
          className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors ${t.border} ${t.textMuted} ${t.surfaceHover}`}
          title="New SSH Connection"
        >
          <Plus className="w-3 h-3" />
          New
        </button>
      </div>
      {profiles.length === 0 ? (
        <div className={`${cardClass} text-center py-4`}>
          <p className={`text-xs ${t.textMuted}`}>No saved SSH profiles</p>
          <p className={`text-[10px] ${t.textFaint} mt-1`}>
            Add a new connection to get started
          </p>
        </div>
      ) : (
        <div className={`${cardClass} divide-y ${resolvedTheme === "light" ? "divide-gray-100" : "divide-white/5"}`}>
          {profiles.map((p: any) => (
            <div key={p.id} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-medium truncate ${t.text}`}>{p.name || `${p.username}@${p.host}`}</div>
                <div className={`text-[10px] ${t.textFaint}`}>{p.username}@{p.host}:{p.port || 22} ({p.authMethod})</div>
              </div>
              <div className="flex items-center gap-1.5 ml-2">
                <button
                  onClick={() => toggleCredentials(p.id)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${p.saveCredentials
                      ? "border-green-500/50 text-green-400 bg-green-500/10"
                      : `${t.border} ${t.textMuted} ${t.surfaceHover}`
                    }`}
                  title={p.saveCredentials ? "Credentials saved" : "Credentials not saved"}
                >
                  {p.saveCredentials ? "Creds saved" : "No creds"}
                </button>
                <button
                  onClick={() => deleteProfile(p.id)}
                  className={`p-1 rounded transition-colors ${t.surfaceHover} text-red-400 hover:text-red-300`}
                  title="Delete profile"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Web Server Sub-component (Electron only) ---
function WebServerSection({ cardClass, t, resolvedTheme }: {
  cardClass: string;
  t: any;
  resolvedTheme: string;
}) {
  const { config: tronConfig, updateConfig } = useConfig();
  const wsConfig = tronConfig.webServer ?? { enabled: true, port: 3888 };

  const [status, setStatus] = useState<{ running: boolean; port: number | null; localIPs: string[]; error: string | null }>({ running: false, port: null, localIPs: [], error: null });
  const [portInput, setPortInput] = useState(String(wsConfig.port));
  const [portWarning, setPortWarning] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const portCheckTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const ipc = window.electron?.ipcRenderer;

  // Poll server status
  useEffect(() => {
    const poll = () => {
      ipc?.getWebServerStatus?.().then(setStatus).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [ipc]);

  // Debounced port-in-use check
  useEffect(() => {
    clearTimeout(portCheckTimer.current);
    const port = Number(portInput);
    if (!port || port < 1 || port > 65535) {
      setPortWarning("Invalid port number");
      return;
    }
    setPortWarning("");
    portCheckTimer.current = setTimeout(() => {
      if (status.running && status.port === port) return;
      ipc?.checkPort?.(port).then((res) => {
        if (!res.available) setPortWarning(`Port ${port} is in use`);
      }).catch(() => {});
    }, 500);
  }, [portInput, ipc, status.running, status.port]);

  const handleToggle = async () => {
    const next = !wsConfig.enabled;
    updateConfig({ webServer: { ...wsConfig, enabled: next } });
    if (next) {
      await ipc?.startWebServer?.(wsConfig.port);
    } else {
      await ipc?.stopWebServer?.();
    }
    ipc?.getWebServerStatus?.().then(setStatus).catch(() => {});
  };

  const handlePortBlur = () => {
    const port = Number(portInput);
    if (port >= 1 && port <= 65535 && port !== wsConfig.port) {
      updateConfig({ webServer: { ...wsConfig, port } });
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    const port = Number(portInput) || wsConfig.port;
    await ipc?.stopWebServer?.();
    updateConfig({ webServer: { ...wsConfig, port, enabled: true } });
    await ipc?.startWebServer?.(port);
    ipc?.getWebServerStatus?.().then(setStatus).catch(() => {});
    setRestarting(false);
  };

  const displayPort = status.port || wsConfig.port;
  const primaryIP = status.localIPs[0] || "127.0.0.1";

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    }).catch(() => {});
  };

  const handleOpen = (url: string) => {
    ipc?.openExternal?.(url);
  };

  return (
    <div className="space-y-3">
      <h3 className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}>
        <Wifi className="w-3.5 h-3.5" />
        Web Server
      </h3>

      {/* Enable toggle */}
      <div className={cardClass}>
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <span className={`text-xs font-medium ${t.text}`}>Enable Web Server</span>
            <span className={`text-[10px] ${t.textFaint}`}>
              Access your terminal from any browser on the network
            </span>
          </div>
          <button
            role="switch"
            aria-checked={wsConfig.enabled}
            onClick={handleToggle}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${wsConfig.enabled
              ? "bg-purple-500"
              : resolvedTheme === "light"
                ? "bg-gray-300"
                : "bg-white/15"
              }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${wsConfig.enabled ? "translate-x-[18px]" : "translate-x-[3px]"}`}
            />
          </button>
        </div>
      </div>

      {/* Status */}
      <div className={cardClass}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status.running ? "bg-green-400" : "bg-red-400"}`} />
            <span className={`text-xs ${t.text}`}>
              {status.running ? `Running on port ${status.port}` : "Stopped"}
            </span>
          </div>
          {wsConfig.enabled && (
            <button
              onClick={handleRestart}
              disabled={restarting}
              className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors ${t.border} ${t.textMuted} ${t.surfaceHover} ${restarting ? "opacity-50" : ""}`}
              title="Restart server"
            >
              <RefreshCw className={`w-3 h-3 ${restarting ? "animate-spin" : ""}`} />
              {restarting ? "Restarting..." : "Restart"}
            </button>
          )}
        </div>
        {!status.running && status.error && (
          <p className="text-[10px] text-red-400 mt-1.5">{status.error}</p>
        )}
      </div>

      {/* IP Address (read-only) + Port (editable) */}
      <div className={cardClass}>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <label className={`text-xs font-medium mb-1.5 block ${t.textMuted}`}>IP Address</label>
            <div className={`px-2 py-1 text-xs rounded border ${t.border} ${resolvedTheme === "light" ? "bg-gray-50 text-gray-500" : "bg-white/3 text-gray-400"}`}>
              {status.localIPs.length > 0 ? primaryIP : "—"}
            </div>
          </div>
          <div>
            <label className={`text-xs font-medium mb-1.5 block ${t.textMuted}`}>Port</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={65535}
                value={portInput}
                onChange={(e) => setPortInput(e.target.value)}
                onBlur={handlePortBlur}
                className={`w-20 px-2 py-1 text-xs rounded border ${t.border} ${t.surface} ${t.text} outline-none focus:border-purple-500`}
              />
            </div>
          </div>
        </div>
        {portWarning && (
          <span className="text-[10px] text-amber-400 mt-1.5 block">{portWarning}</span>
        )}
        {status.localIPs.length > 1 && (
          <p className={`text-[10px] ${t.textFaint} mt-1.5`}>
            Also available on: {status.localIPs.slice(1).join(", ")}
          </p>
        )}
        {status.running && status.port !== null && Number(portInput) !== status.port ? (
          <p className="text-[10px] text-red-400 mt-1.5">
            Port changed — restart to apply
          </p>
        ) : (
          <p className={`text-[10px] ${t.textFaint} mt-1`}>
            Restart required after changing port
          </p>
        )}
      </div>

      {/* Access URLs */}
      {status.running && (
        <div className={cardClass}>
          <label className={`text-xs font-medium mb-2 block ${t.textMuted}`}>Access URLs</label>
          <div className="space-y-1.5">
            {[`http://localhost:${displayPort}`, ...(status.localIPs.length > 0 ? [`http://${primaryIP}:${displayPort}`] : [])].map((url) => (
              <div key={url} className="flex items-center gap-1.5">
                <code className={`text-xs px-2 py-1 rounded ${resolvedTheme === "light" ? "bg-gray-100 text-gray-800" : "bg-white/5 text-gray-300"} flex-1 truncate`}>
                  {url}
                </code>
                <button
                  onClick={() => handleCopy(url)}
                  className={`p-1 rounded border transition-colors ${t.border} ${t.textMuted} ${t.surfaceHover}`}
                  title="Copy URL"
                >
                  {copiedUrl === url ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                </button>
                <button
                  onClick={() => handleOpen(url)}
                  className={`p-1 rounded border transition-colors ${t.border} ${t.textMuted} ${t.surfaceHover}`}
                  title="Open in browser"
                >
                  <ExternalLink className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
          <p className={`text-[10px] ${t.textFaint} mt-2 leading-relaxed`}>
            Use the IP address to access from other devices on your local network.
            For remote access, use Tailscale or a reverse proxy to securely expose this address.
          </p>
        </div>
      )}
    </div>
  );
}

const SettingsPane = () => {
  const { theme, resolvedTheme, setTheme, viewMode, setViewMode } = useTheme();
  const { sessions, updateSessionConfig, pendingSettingsSection, clearPendingSettingsSection } = useLayout();
  const { config: appConfig, hotkeys, updateHotkey, resetHotkeys, aiBehavior, updateAIBehavior, updateConfig: updateAppConfig } = useConfig();
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
  const providerCacheRef = useRef<ProviderCache>({ ...appConfig.providerConfigs });

  // Hotkey recording state
  const [recordingAction, setRecordingAction] = useState<string | null>(null);

  // Sidebar active section tracking (page-based — each section is a page)
  const [activeSection, setActiveSection] = useState<string>("ai");

  // Navigate to a specific section when requested externally (e.g. model click → AI page)
  useEffect(() => {
    if (pendingSettingsSection) {
      setActiveSection(pendingSettingsSection);
      clearPendingSettingsSection();
    }
  }, [pendingSettingsSection, clearPendingSettingsSection]);

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

  const toggleFavorite = (e: React.MouseEvent, modelName: string) => {
    e.stopPropagation();
    setConfig((prev) => {
      const favs = prev.favoritedModels || [];
      const newFavs = favs.includes(modelName)
        ? favs.filter((m) => m !== modelName)
        : [...favs, modelName];
      // Automatically save favorited models to global storage without requiring "Save Settings" click
      const newConfig = { ...prev, favoritedModels: newFavs };
      aiService.saveConfig(newConfig);
      return newConfig;
    });
  };

  // When switching providers, save current config to cache and load the new provider's cached config
  const handleProviderChange = (newProvider: string) => {
    // Save current provider's config to cache
    const cache = providerCacheRef.current;
    cache[config.provider] = {
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    updateAppConfig({ providerConfigs: { ...cache } });

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
    updateAppConfig({ providerConfigs: { ...cache } });

    // For non-baseUrl providers, explicitly clear baseUrl so it doesn't leak
    const configToSave = { ...config };
    if (!providerUsesBaseUrl(config.provider)) {
      configToSave.baseUrl = undefined;
    }

    // Save globally — in-memory + localStorage cache + file-based config
    aiService.saveConfig(configToSave);
    updateAppConfig({ ai: configToSave });
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

  // Auto-save changes with 1s debounce
  useEffect(() => {
    if (hasChanges) {
      const handler = setTimeout(() => {
        handleSave();
      }, 1000);
      return () => clearTimeout(handler);
    }
  }, [config, hasChanges]);

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
    <div data-testid="settings-pane" className={`w-full h-full flex ${t.appBg}`}>
      {/* Sidebar — icon-only on narrow screens, full labels on wider */}
      <nav
        className={`shrink-0 w-10 sm:w-40 flex flex-col border-r pt-4 pb-4 gap-1 px-1 sm:px-2 ${resolvedTheme === "light"
          ? "bg-gray-50/80 border-gray-200"
          : resolvedTheme === "modern"
            ? "bg-white/[0.02] border-white/6"
            : "bg-[#0a0a0a] border-white/5"
          }`}
      >
        <div className={`px-1 sm:px-2 pb-3 mb-1 border-b ${t.borderSubtle}`}>
          <h1 className={`text-sm font-bold ${t.text} hidden sm:block`}>Settings</h1>
          <SlidersHorizontal className={`w-4 h-4 mx-auto ${t.text} sm:hidden`} />
        </div>
        {NAV_SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            data-testid={`settings-nav-${id}`}
            onClick={() => setActiveSection(id)}
            title={label}
            className={`flex items-center justify-center sm:justify-start gap-2 px-1 sm:px-2 py-1.5 rounded-lg text-xs transition-colors text-left ${activeSection === id
              ? resolvedTheme === "light"
                ? "bg-purple-50 text-purple-700 font-medium"
                : "bg-purple-500/10 text-purple-300 font-medium"
              : `${t.textMuted} hover:${t.surfaceHover}`
              }`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}

        {/* Auto-save status indicator at bottom of sidebar */}
        <div className="mt-auto pt-3 h-8 flex items-center justify-center">
          <span
            className={`text-[10px] flex items-center gap-1.5 transition-opacity duration-500 ${saveStatus === "saved" ? "text-green-500 opacity-100" : "opacity-0"
              }`}
          >
            <Save className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Saved</span>
          </span>
        </div>
      </nav>

      {/* Content */}
      <div className="flex-1 min-w-0 overflow-y-auto p-2 sm:p-4 flex flex-col items-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSection}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-xl flex flex-col gap-4 sm:gap-6 pb-16"
          >
            {/* AI Configuration */}
            {activeSection === "ai" && (
              <div
                className="space-y-3"
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
                                {localModels.map((m) => {
                                  const isFav = config.favoritedModels?.includes(m.name);
                                  return (
                                    <div
                                      key={m.name}
                                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center group transition-colors ${config.model === m.name
                                        ? "bg-purple-500/10 text-purple-400"
                                        : `${t.surfaceHover} ${t.textMuted}`
                                        }`}
                                    >
                                      <button
                                        data-testid={`model-item-${m.name}`}
                                        onClick={() => setConfig({ ...config, model: m.name })}
                                        className="flex-1 flex items-center gap-2 truncate text-left"
                                      >
                                        <span className="truncate">{m.name}</span>
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
                                      <button
                                        onClick={(e) => toggleFavorite(e, m.name)}
                                        className={`shrink-0 p-1 opacity-50 hover:opacity-100 transition-opacity ml-2 ${isFav ? "text-yellow-400 opacity-100" : "text-gray-400 group-hover:opacity-100 opacity-0"}`}
                                      >
                                        <Star className={`w-3.5 h-3.5 ${isFav ? "fill-current" : ""}`} />
                                      </button>
                                    </div>
                                  );
                                })}
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
                                        <div className={`rounded-lg border overflow-hidden max-h-32 overflow-y-auto mb-1 ${t.surfaceInput}`}>
                                          {modelList.map((name) => {
                                            const isFav = config.favoritedModels?.includes(name);
                                            return (
                                              <div
                                                key={name}
                                                className={`w-full flex items-center px-3 py-1.5 text-xs transition-colors group ${config.model === name
                                                  ? "bg-purple-500/10 text-purple-400"
                                                  : `${t.surfaceHover} ${t.textMuted}`
                                                  }`}
                                              >
                                                <button
                                                  onClick={() => setConfig({ ...config, model: name })}
                                                  className="flex-1 text-left truncate"
                                                >
                                                  {name}
                                                </button>
                                                <button
                                                  onClick={(e) => toggleFavorite(e, name)}
                                                  className={`shrink-0 p-1 opacity-50 hover:opacity-100 transition-opacity ml-2 ${isFav ? "text-yellow-400 opacity-100" : "text-gray-400 group-hover:opacity-100 opacity-0"}`}
                                                >
                                                  <Star className={`w-3.5 h-3.5 ${isFav ? "fill-current" : ""}`} />
                                                </button>
                                              </div>
                                            );
                                          })}
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
                                  data-testid="api-key-input"
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
                        updateAppConfig({ providerConfigs: { ...cache } });

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
              </div>
            )}

            {/* AI Features */}
            {activeSection === "ai-features" && (
              <div className="space-y-3">
                <h3
                  className={`text-[10px] font-semibold ${t.textFaint} uppercase tracking-wider flex items-center gap-2`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  AI Features
                </h3>

                <div className={`${cardClass} divide-y ${resolvedTheme === "light" ? "divide-gray-100" : "divide-white/5"}`}>
                  {([
                    { key: "ghostText" as const, label: "Ghost Text", desc: "AI-generated inline suggestions when input is empty" },
                    { key: "autoDetect" as const, label: "Auto-Detect Mode", desc: "Automatically classify input as command or agent prompt" },
                    { key: "adviceMode" as const, label: "Advice Mode", desc: "Ask AI for command suggestions before running" },
                    { key: "aiTabTitles" as const, label: "AI Tab Titles", desc: "Automatically generate tab titles from agent tasks" },
                    { key: "inputHints" as const, label: "Input Hints", desc: "Show keyboard shortcuts and mode hints below input" },
                  ]).map(({ key, label, desc }) => (
                    <div
                      key={key}
                      className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className={`text-xs font-medium ${t.text}`}>{label}</span>
                        <span className={`text-[10px] ${t.textFaint}`}>{desc}</span>
                      </div>
                      <button
                        data-testid={`toggle-${key}`}
                        role="switch"
                        aria-checked={aiBehavior[key]}
                        onClick={() => updateAIBehavior({ [key]: !aiBehavior[key] })}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${aiBehavior[key]
                          ? "bg-purple-500"
                          : resolvedTheme === "light"
                            ? "bg-gray-300"
                            : "bg-white/15"
                          }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${aiBehavior[key] ? "translate-x-[18px]" : "translate-x-[3px]"
                            }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* View Mode */}
            {activeSection === "view" && (
              <div
                className="space-y-3"
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
              </div>
            )}

            {/* Appearance */}
            {activeSection === "appearance" && (
              <div
                className="space-y-3"
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
              </div>
            )}

            {/* Web Server (Electron only) */}
            {activeSection === "web-server" && window.electron && (
              <WebServerSection
                cardClass={cardClass}
                t={t}
                resolvedTheme={resolvedTheme}
              />
            )}

            {/* SSH Profiles */}
            {activeSection === "ssh" && (
              <SSHProfilesSection
                cardClass={cardClass}
                t={t}
                resolvedTheme={resolvedTheme}
              />
            )}

            {/* Keyboard Shortcuts */}
            {activeSection === "shortcuts" && (
              <div
                className="space-y-3"
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
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div >
  );
};

export default SettingsPane;
