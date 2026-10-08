import { useCallback, useMemo } from "react";
import { useConfig } from "../contexts/ConfigContext";
import { useAgent } from "../contexts/AgentContext";
import {
  resolvePanelChrome,
  toggleAllOverride,
  toggleRegionOverride,
} from "../utils/panelChrome";
import type { PanelChromeRegion, PanelChromeState } from "../types";

// Collapsible animates height for 200ms; without this the terminal's
// ResizeObserver fits (and SIGWINCHes the PTY) several times mid-animation.
const COLLAPSE_SETTLE_MS = 260;

/**
 * Resolves the visibility of a terminal panel's three collapsible chrome
 * regions (input / hints / footer) and exposes toggles. Combines the global
 * master-hide config, the per-panel persisted override, and a measured panel
 * height for auto-hide.
 *
 * @param sessionId  the panel's session
 * @param panelHeight measured panel height in px (0 = not yet measured)
 */
export function usePanelChrome(sessionId: string, panelHeight: number) {
  const { config } = useConfig();
  const { panelChrome, setPanelChrome } = useAgent(sessionId);

  const globals = useMemo(
    () => ({
      hidePanelInput: config.hidePanelInput,
      hidePanelHints: config.hidePanelHints,
      hidePanelFooter: config.hidePanelFooter,
    }),
    [config.hidePanelInput, config.hidePanelHints, config.hidePanelFooter],
  );

  const visible = useMemo(
    () => resolvePanelChrome({ globals, perPanel: panelChrome, panelHeight }),
    [globals, panelChrome, panelHeight],
  );

  // Whether a region's current state is forced by the global master-hide —
  // used to disable per-panel toggles (they can't override a global hide).
  const globallyHidden = useMemo(
    () => ({
      input: !!globals.hidePanelInput,
      hints: !!globals.hidePanelHints,
      footer: !!globals.hidePanelFooter,
    }),
    [globals],
  );

  // Same deferral as pane maximize: terminals hold fit() until the collapse
  // settles, then resize once.
  const applyOverride = useCallback(
    (next: PanelChromeState) => {
      window.dispatchEvent(new Event("tron:splitDragStart"));
      setPanelChrome(next);
      setTimeout(() => window.dispatchEvent(new Event("tron:splitDragEnd")), COLLAPSE_SETTLE_MS);
    },
    [setPanelChrome],
  );

  const toggle = useCallback(
    (region: PanelChromeRegion) => {
      // No-op when globally hidden — the master switch wins.
      if (globallyHidden[region]) return;
      applyOverride(toggleRegionOverride(region, visible[region], panelChrome));
    },
    [globallyHidden, applyOverride, visible, panelChrome],
  );

  /** Hide every region if any is showing, otherwise show them all. */
  const toggleAll = useCallback(() => {
    applyOverride(toggleAllOverride(visible, panelChrome, globallyHidden));
  }, [applyOverride, visible, panelChrome, globallyHidden]);

  /** Force-show every region that isn't globally hidden (restore-all). */
  const showAll = useCallback(() => {
    const next = { ...(panelChrome || {}) };
    (["input", "hints", "footer"] as PanelChromeRegion[]).forEach((r) => {
      if (!globallyHidden[r]) next[r] = true;
    });
    applyOverride(next);
  }, [globallyHidden, panelChrome, applyOverride]);

  /** True when at least one region is hidden (so a restore affordance shows). */
  const anyHidden = !visible.input || !visible.hints || !visible.footer;

  return { visible, toggle, toggleAll, showAll, anyHidden, globallyHidden };
}
