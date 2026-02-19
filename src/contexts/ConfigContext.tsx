import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { TronConfig, HotkeyMap } from "../types";
import { STORAGE_KEYS } from "../constants/storage";

export const DEFAULT_HOTKEYS: HotkeyMap = {
  openSettings: "meta+,",
  toggleOverlay: "meta+.",
  stopAgent: "ctrl+c",
  clearTerminal: "meta+k",
  clearAgent: "meta+shift+k",
  modeCommand: "meta+1",
  modeAdvice: "meta+2",
  modeAgent: "meta+3",
  modeAuto: "meta+0",
  forceAgent: "shift+enter",
  forceCommand: "meta+enter",
};

const DEFAULT_CONFIG: TronConfig = {
  hotkeys: { ...DEFAULT_HOTKEYS },
};

interface ConfigContextType {
  config: TronConfig;
  hotkeys: HotkeyMap;
  updateConfig: (partial: Partial<TronConfig>) => void;
  updateHotkey: (action: string, combo: string) => void;
  resetHotkeys: () => void;
  isLoaded: boolean;
}

const ConfigContext = createContext<ConfigContextType | null>(null);

/** Build config from localStorage (migration path) */
function migrateFromLocalStorage(): TronConfig {
  const config: TronConfig = { hotkeys: { ...DEFAULT_HOTKEYS } };
  try {
    const aiRaw = localStorage.getItem(STORAGE_KEYS.AI_CONFIG);
    if (aiRaw) config.ai = JSON.parse(aiRaw);
    const provRaw = localStorage.getItem(STORAGE_KEYS.PROVIDER_CONFIGS);
    if (provRaw) config.providerConfigs = JSON.parse(provRaw);
    const theme = localStorage.getItem(STORAGE_KEYS.THEME);
    if (theme) config.theme = theme;
    const viewMode = localStorage.getItem(STORAGE_KEYS.VIEW_MODE);
    if (viewMode) config.viewMode = viewMode;
    const configured = localStorage.getItem(STORAGE_KEYS.CONFIGURED);
    if (configured) config.configured = configured === "true";
  } catch (e) {
    console.warn("Config migration from localStorage failed:", e);
  }
  return config;
}

export const ConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<TronConfig>(DEFAULT_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load config from file on mount
  useEffect(() => {
    const load = async () => {
      try {
        const fileConfig = await window.electron?.ipcRenderer?.readConfig?.();
        if (fileConfig) {
          // Ensure hotkeys have all defaults filled in
          const merged: TronConfig = {
            ...fileConfig,
            hotkeys: { ...DEFAULT_HOTKEYS, ...(fileConfig.hotkeys || {}) },
          };
          setConfig(merged);
        } else {
          // No config file — migrate from localStorage and write
          const migrated = migrateFromLocalStorage();
          setConfig(migrated);
          window.electron?.ipcRenderer?.writeConfig?.(migrated as Record<string, unknown>);
        }
      } catch {
        // Fallback: try localStorage migration (web mode, no Electron)
        setConfig(migrateFromLocalStorage());
      }
      setIsLoaded(true);
    };
    load();
  }, []);

  // Write config to file (debounced)
  const persistConfig = useCallback((cfg: TronConfig) => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      window.electron?.ipcRenderer?.writeConfig?.(cfg as Record<string, unknown>);
    }, 300);
  }, []);

  const updateConfig = useCallback((partial: Partial<TronConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...partial };
      persistConfig(next);
      return next;
    });
  }, [persistConfig]);

  const updateHotkey = useCallback((action: string, combo: string) => {
    setConfig((prev) => {
      const next = {
        ...prev,
        hotkeys: { ...DEFAULT_HOTKEYS, ...prev.hotkeys, [action]: combo },
      };
      persistConfig(next);
      return next;
    });
  }, [persistConfig]);

  const resetHotkeys = useCallback(() => {
    setConfig((prev) => {
      const next = { ...prev, hotkeys: { ...DEFAULT_HOTKEYS } };
      persistConfig(next);
      return next;
    });
  }, [persistConfig]);

  const hotkeys = config.hotkeys || DEFAULT_HOTKEYS;

  return (
    <ConfigContext.Provider value={{ config, hotkeys, updateConfig, updateHotkey, resetHotkeys, isLoaded }}>
      {children}
    </ConfigContext.Provider>
  );
};

export const useConfig = () => {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used within ConfigProvider");
  return ctx;
};

export { ConfigContext };
