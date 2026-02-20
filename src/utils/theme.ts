// ---------------------------------------------------------------------------
// Theme Token System — data-driven, extensible theme registry
// ---------------------------------------------------------------------------

export type ResolvedTheme = "dark" | "light" | "modern";

/** Semantic token set for a theme. All values are Tailwind class strings. */
export interface ThemeTokens {
  /** Whether this is a light-base theme (affects status colors, etc.) */
  isLight: boolean;

  // App root
  appBg: string;

  // Surfaces
  surface: string; // Card/panel bg + border
  surfaceHover: string; // Hover state
  surfaceActive: string; // Active/selected state
  surfaceInput: string; // Input fields
  surfaceOverlay: string; // Modal/overlay panels

  // Borders
  border: string; // Default border
  borderSubtle: string; // Subtle/divider border
  borderFocus: string; // Focus ring

  // Text
  text: string; // Primary text
  textMuted: string; // Secondary text
  textFaint: string; // Tertiary/hint text

  // Bars (tab bar, context bar, footer)
  bar: string; // Bar background
  barBorder: string; // Bar border

  // Glass effects
  glass: string; // Backdrop-blur + transparency

  // Accent
  accent: string; // Accent text
  accentMuted: string; // Muted accent
  accentBg: string; // Accent background
  accentGlow: string; // Glow shadow
}

// ---------------------------------------------------------------------------
// Built-in Themes
// ---------------------------------------------------------------------------

const darkTheme: ThemeTokens = {
  isLight: false,
  appBg: "bg-[#0a0a0a] text-white",

  surface: "bg-white/5 border border-white/5",
  surfaceHover: "hover:bg-white/5",
  surfaceActive: "bg-white/10 border-white/10",
  surfaceInput:
    "bg-black/20 border-white/10 text-white focus:bg-black/40 focus:border-purple-500/50",
  surfaceOverlay: "bg-[#0a0a0a]/95 border-white/10 text-white",

  border: "border-white/10",
  borderSubtle: "border-white/5",
  borderFocus: "border-purple-500/50",

  text: "text-white",
  textMuted: "text-gray-400",
  textFaint: "text-gray-500",

  bar: "bg-[#0a0a0a]",
  barBorder: "border-white/5",

  glass: "",

  accent: "text-purple-400",
  accentMuted: "text-purple-500",
  accentBg: "bg-purple-500/10",
  accentGlow: "",
};

const lightTheme: ThemeTokens = {
  isLight: true,
  appBg: "bg-gray-100 text-gray-900",

  surface: "bg-white border border-gray-200",
  surfaceHover: "hover:bg-gray-100",
  surfaceActive: "bg-gray-100 border-gray-300",
  surfaceInput:
    "bg-white border-gray-200 text-gray-900 focus:border-purple-500",
  surfaceOverlay: "bg-white/95 border-gray-200 text-gray-900",

  border: "border-gray-200",
  borderSubtle: "border-gray-200/60",
  borderFocus: "border-purple-500",

  text: "text-gray-900",
  textMuted: "text-gray-500",
  textFaint: "text-gray-400",

  bar: "bg-gray-100",
  barBorder: "border-gray-200",

  glass: "",

  accent: "text-purple-600",
  accentMuted: "text-purple-400",
  accentBg: "bg-purple-50",
  accentGlow: "",
};

const modernTheme: ThemeTokens = {
  isLight: false,
  appBg:
    "bg-gradient-to-br from-[#020010] via-[#050520] to-[#0a0a2e] text-white",

  surface: "bg-white/[0.03] border border-white/[0.06]",
  surfaceHover: "hover:bg-white/[0.06]",
  surfaceActive: "bg-white/[0.08] border-white/[0.1]",
  surfaceInput:
    "bg-white/[0.03] border-white/[0.08] text-white focus:border-purple-400/30 focus:bg-white/[0.05]",
  surfaceOverlay: "bg-[#0c0c1e]/90 border-white/[0.06] text-white",

  border: "border-white/[0.08]",
  borderSubtle: "border-white/[0.04]",
  borderFocus: "border-purple-400/30",

  text: "text-white",
  textMuted: "text-gray-400",
  textFaint: "text-gray-500",

  bar: "bg-white/[0.02]",
  barBorder: "border-white/[0.06]",

  glass: "",

  accent: "text-purple-300",
  accentMuted: "text-purple-400/60",
  accentBg: "bg-purple-500/[0.08]",
  accentGlow: "shadow-[0_0_20px_rgba(168,85,247,0.08)]",
};

// ---------------------------------------------------------------------------
// Theme Registry
// ---------------------------------------------------------------------------

const themeRegistry: Record<string, ThemeTokens> = {
  dark: darkTheme,
  light: lightTheme,
  modern: modernTheme,
};

/** Get the full theme token object for a resolved theme. */
export function getTheme(resolvedTheme: string): ThemeTokens {
  return themeRegistry[resolvedTheme] ?? themeRegistry.dark;
}

/** Register a custom theme (for future user-created themes). */
export function registerTheme(id: string, tokens: ThemeTokens): void {
  themeRegistry[id] = tokens;
}

/** Get all registered theme IDs. */
export function getThemeIds(): string[] {
  return Object.keys(themeRegistry);
}

/**
 * Returns the appropriate class string for the current resolved theme.
 * Useful for component-specific overrides that don't fit into tokens.
 */
export function themeClass(
  resolvedTheme: string,
  classes: {
    dark: string;
    light: string;
    modern?: string;
    [key: string]: string | undefined;
  },
): string {
  return classes[resolvedTheme] ?? classes.dark;
}
