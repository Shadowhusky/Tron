import React, { createContext, useContext, useEffect, useState } from "react";
import { STORAGE_KEYS } from "../constants/storage";

type Theme = "dark" | "light" | "system" | "modern";
export type ResolvedTheme = "dark" | "light" | "modern";

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: ResolvedTheme; // The actual visual theme after resolving "system"
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
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
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    return (stored as Theme) || "system";
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");

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
    setTheme((prev) => {
      if (prev === "dark") return "light";
      if (prev === "light") return "modern";
      if (prev === "modern") return "system";
      return "dark";
    });
  };

  const setThemeValue = (newTheme: Theme) => {
    setTheme(newTheme);
  };

  return (
    <ThemeContext.Provider
      value={{ theme, resolvedTheme, toggleTheme, setTheme: setThemeValue }}
    >
      {children}
    </ThemeContext.Provider>
  );
};
