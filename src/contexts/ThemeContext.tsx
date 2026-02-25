import React, { createContext, useContext, useEffect, useState } from "react";
import { STORAGE_KEYS } from "../constants/storage";
import { useConfig } from "./ConfigContext";

type Theme = "dark" | "light" | "system" | "modern";
export type ResolvedTheme = "dark" | "light" | "modern";
export type ViewMode = "terminal" | "agent";

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: ResolvedTheme; // The actual visual theme after resolving "system"
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { config, isLoaded, updateConfig } = useConfig();

  const [theme, setThemeState] = useState<Theme>(() => {
    // Read from localStorage for fast synchronous init (prevents flash)
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    return (stored as Theme) || "system";
  });

  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.VIEW_MODE);
    return (stored as ViewMode) || "terminal";
  });

  // When file-based config arrives, sync from it (source of truth)
  useEffect(() => {
    if (!isLoaded) return;
    if (config.theme && config.theme !== theme) {
      setThemeState(config.theme as Theme);
    }
    if (config.viewMode && config.viewMode !== viewMode) {
      setViewModeState(config.viewMode as ViewMode);
    }
    // Only run when config finishes loading
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    // localStorage = fast cache for next load; config = persistent source of truth
    localStorage.setItem(STORAGE_KEYS.THEME, newTheme);
    updateConfig({ theme: newTheme });
  };

  const setViewMode = (mode: ViewMode) => {
    setViewModeState(mode);
    localStorage.setItem(STORAGE_KEYS.VIEW_MODE, mode);
    updateConfig({ viewMode: mode });
  };

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    // Synchronously resolve initial theme to prevent flash
    const stored = localStorage.getItem(STORAGE_KEYS.THEME) as Theme | null;
    const pref = stored || "system";

    if (pref === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    if (pref === "modern") return "modern";
    return pref as ResolvedTheme;
  });

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark", "modern");

    let effective: ResolvedTheme;

    if (theme === "system") {
      const systemDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;
      effective = systemDark ? "dark" : "light";
    } else if (theme === "modern") {
      effective = "modern";
      root.classList.add("modern");
    } else {
      effective = theme;
    }

    root.classList.add(effective === "modern" ? "dark" : effective);
    setResolvedTheme(effective);
    // Keep localStorage in sync as fast cache
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  }, [theme]);

  // Listener for system theme changes if mode is 'system'
  useEffect(() => {
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const root = window.document.documentElement;
      root.classList.remove("light", "dark");
      const newResolved = mediaQuery.matches ? "dark" : "light";
      root.classList.add(newResolved);
      setResolvedTheme(newResolved);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const toggleTheme = () => {
    // Cycle: dark -> light -> modern -> system -> dark
    const next: Theme =
      theme === "dark" ? "light" :
      theme === "light" ? "modern" :
      theme === "modern" ? "system" : "dark";
    setTheme(next);
  };

  return (
    <ThemeContext.Provider
      value={{ theme, resolvedTheme, toggleTheme, setTheme, viewMode, setViewMode }}
    >
      {children}
    </ThemeContext.Provider>
  );
};
