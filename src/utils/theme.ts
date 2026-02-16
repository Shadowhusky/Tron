type ResolvedTheme = "dark" | "light" | "modern";

/**
 * Returns the appropriate class string for the current resolved theme.
 * Replaces nested ternaries like:
 *   resolvedTheme === "dark" ? "..." : resolvedTheme === "modern" ? "..." : "..."
 */
export function themeClass(
  resolvedTheme: ResolvedTheme,
  classes: { dark: string; light: string; modern?: string },
): string {
  if (resolvedTheme === "light") return classes.light;
  if (resolvedTheme === "modern") return classes.modern ?? classes.dark;
  return classes.dark;
}
