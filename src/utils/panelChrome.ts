/**
 * Visibility resolution for the three collapsible chrome regions of a terminal
 * panel: the SmartInput box, the hints/desc bar under it, and the footer
 * (context bar).
 *
 * Precedence (highest first):
 *   1. Global master-hide (Settings → "hide in all panels") — hard hide.
 *   2. Per-panel override (button / hotkey, persisted per session) — tri-state.
 *   3. Auto-hide by available panel height — reclaim space on short panels.
 *
 * Pure (no IO / React) so it's trivially unit-testable.
 */
import type { PanelChromeRegion, PanelChromeState } from "../types";

export const PANEL_CHROME_REGIONS: PanelChromeRegion[] = [
  "input",
  "hints",
  "footer",
];

/**
 * Auto-hide thresholds (panel pixel height). When the panel is shorter than
 * the threshold AND there is no explicit per-panel override / global hide, the
 * region auto-collapses to give the terminal room. Footer goes first (least
 * essential), then hints. The input is never auto-hidden — only an explicit
 * toggle or the global setting can hide it.
 */
export const AUTO_HIDE_FOOTER_BELOW_PX = 220;
export const AUTO_HIDE_HINTS_BELOW_PX = 170;

export interface PanelChromeGlobals {
  hidePanelInput?: boolean;
  hidePanelHints?: boolean;
  hidePanelFooter?: boolean;
}

const GLOBAL_KEY: Record<PanelChromeRegion, keyof PanelChromeGlobals> = {
  input: "hidePanelInput",
  hints: "hidePanelHints",
  footer: "hidePanelFooter",
};

/** Whether a region is auto-visible at the given panel height (no override). */
export function autoVisible(
  region: PanelChromeRegion,
  panelHeight: number,
): boolean {
  // height 0 / unknown → treat as visible (don't hide before first measure)
  if (!panelHeight || panelHeight <= 0) return true;
  if (region === "footer") return panelHeight >= AUTO_HIDE_FOOTER_BELOW_PX;
  if (region === "hints") return panelHeight >= AUTO_HIDE_HINTS_BELOW_PX;
  return true; // input never auto-hides
}

/** Resolve the effective visibility of one region. */
export function resolveRegionVisible(
  region: PanelChromeRegion,
  opts: {
    globals: PanelChromeGlobals;
    perPanel: PanelChromeState | undefined;
    panelHeight: number;
  },
): boolean {
  if (opts.globals[GLOBAL_KEY[region]]) return false; // global master hide
  const override = opts.perPanel?.[region];
  if (override === true) return true;
  if (override === false) return false;
  return autoVisible(region, opts.panelHeight);
}

/** Resolve all three regions at once. */
export function resolvePanelChrome(opts: {
  globals: PanelChromeGlobals;
  perPanel: PanelChromeState | undefined;
  panelHeight: number;
}): Record<PanelChromeRegion, boolean> {
  return {
    input: resolveRegionVisible("input", opts),
    hints: resolveRegionVisible("hints", opts),
    footer: resolveRegionVisible("footer", opts),
  };
}

/**
 * Compute the next per-panel override when the user toggles a region. We flip
 * the *currently effective* visibility and pin it as an explicit override, so
 * one press always does the visually-obvious thing (hide a shown region / show
 * a hidden one) regardless of whether it was auto or manual before.
 */
export function toggleRegionOverride(
  region: PanelChromeRegion,
  currentlyVisible: boolean,
  perPanel: PanelChromeState | undefined,
): PanelChromeState {
  return { ...(perPanel || {}), [region]: !currentlyVisible };
}
