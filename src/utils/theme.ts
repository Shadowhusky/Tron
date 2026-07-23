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
    "bg-black/20 border-white/10 text-white focus:bg-black/40 focus:border-blue-500/50",
  surfaceOverlay: "bg-[#0a0a0a]/95 border-white/10 text-white",

  border: "border-white/10",
  borderSubtle: "border-white/5",
  borderFocus: "border-blue-500/50",

  text: "text-white",
  textMuted: "text-gray-400",
  textFaint: "text-gray-500",

  bar: "bg-[#0a0a0a]",
  barBorder: "border-white/5",

  glass: "",

  accent: "text-blue-400",
  accentMuted: "text-blue-500",
  accentBg: "bg-blue-500/10",
  accentGlow: "",
};

const lightTheme: ThemeTokens = {
  isLight: true,
  appBg: "bg-gray-100 text-gray-900",

  surface: "bg-white border border-gray-200",
  surfaceHover: "hover:bg-gray-100",
  surfaceActive: "bg-gray-100 border-gray-300",
  surfaceInput:
    "bg-white border-gray-200 text-gray-900 focus:border-blue-500",
  surfaceOverlay: "bg-white/95 border-gray-200 text-gray-900",

  border: "border-gray-200",
  borderSubtle: "border-gray-200/60",
  borderFocus: "border-blue-500",

  text: "text-gray-900",
  textMuted: "text-gray-500",
  textFaint: "text-gray-400",

  bar: "bg-gray-100",
  barBorder: "border-gray-200",

  glass: "",

  accent: "text-blue-600",
  accentMuted: "text-blue-400",
  accentBg: "bg-blue-50",
  accentGlow: "",
};

// Modern = Apple-material theme: translucent chrome (backdrop-blur on
// PERSISTENT surfaces only) over a luminous backdrop (see App.tsx modern
// backdrop layers) so the glass has something to refract. Transient
// overlays stay near-opaque per the no-blur-on-overlays rule.
const modernTheme: ThemeTokens = {
  isLight: false,
  appBg:
    "bg-gradient-to-br from-[#06080f] via-[#0a0e1a] to-[#101827] text-white",

  surface: "bg-white/[0.05] border border-white/[0.08]",
  surfaceHover: "hover:bg-white/[0.08]",
  surfaceActive: "bg-white/[0.1] border-white/[0.12]",
  surfaceInput:
    "bg-white/[0.04] border-white/[0.1] text-white focus:border-blue-400/40 focus:bg-white/[0.06]",
  surfaceOverlay: "bg-[#0d1220]/95 border-white/[0.08] text-white",

  border: "border-white/[0.08]",
  borderSubtle: "border-white/[0.05]",
  borderFocus: "border-blue-400/40",

  text: "text-white",
  textMuted: "text-gray-300",
  textFaint: "text-gray-500",

  bar: "bg-white/[0.03]",
  barBorder: "border-white/[0.08]",

  glass: "backdrop-blur-xl backdrop-saturate-150",

  accent: "text-blue-300",
  accentMuted: "text-blue-400/60",
  accentBg: "bg-blue-400/[0.08]",
  accentGlow: "",
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
