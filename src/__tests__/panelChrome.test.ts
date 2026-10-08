import { describe, it, expect } from "vitest";
import {
  resolvePanelChrome,
  resolveRegionVisible,
  toggleRegionOverride,
  toggleAllOverride,
  autoVisible,
} from "../utils/panelChrome";

describe("panelChrome resolution", () => {
  const tall = 800;
  const short = 150;

  it("shows all regions on a tall panel with no overrides", () => {
    const v = resolvePanelChrome({ globals: {}, perPanel: undefined, panelHeight: tall });
    expect(v).toEqual({ input: true, hints: true, footer: true });
  });

  it("auto-hides footer then hints as the panel shrinks", () => {
    expect(autoVisible("footer", 210)).toBe(false);
    expect(autoVisible("hints", 210)).toBe(true);
    expect(autoVisible("hints", 160)).toBe(false);
    expect(autoVisible("input", 50)).toBe(true); // input never auto-hides
  });

  it("global master-hide wins over everything", () => {
    const v = resolvePanelChrome({
      globals: { hidePanelFooter: true },
      perPanel: { footer: true }, // even an explicit show is overridden
      panelHeight: tall,
    });
    expect(v.footer).toBe(false);
  });

  it("per-panel override beats auto-hide (force-show footer on a short panel)", () => {
    expect(
      resolveRegionVisible("footer", {
        globals: {},
        perPanel: { footer: true },
        panelHeight: short,
      }),
    ).toBe(true);
  });

  it("per-panel hide beats auto-show on a tall panel", () => {
    expect(
      resolveRegionVisible("input", {
        globals: {},
        perPanel: { input: false },
        panelHeight: tall,
      }),
    ).toBe(false);
  });

  it("toggling flips effective visibility into an explicit override", () => {
    // currently visible (auto) → toggle → explicit hide
    expect(toggleRegionOverride("footer", true, undefined)).toEqual({ footer: false });
    // currently hidden → toggle → explicit show, preserving other keys
    expect(toggleRegionOverride("hints", false, { input: false })).toEqual({
      input: false,
      hints: true,
    });
  });

  it("does not hide anything before the first height measurement (height 0)", () => {
    const v = resolvePanelChrome({ globals: {}, perPanel: undefined, panelHeight: 0 });
    expect(v).toEqual({ input: true, hints: true, footer: true });
  });
});

describe("toggleAllOverride", () => {
  const none = { input: false, hints: false, footer: false };
  const shown = { input: true, hints: true, footer: true };

  it("hides every region when all are showing", () => {
    expect(toggleAllOverride(shown, undefined, none)).toEqual({
      input: false,
      hints: false,
      footer: false,
    });
  });

  it("hides every region when only some are showing", () => {
    // footer auto-hidden on a short pane, input + hints still up → one press hides the rest
    expect(
      toggleAllOverride({ input: true, hints: true, footer: false }, undefined, none),
    ).toEqual({ input: false, hints: false, footer: false });
  });

  it("shows every region when all are hidden", () => {
    expect(
      toggleAllOverride(
        { input: false, hints: false, footer: false },
        { input: false, hints: false, footer: false },
        none,
      ),
    ).toEqual({ input: true, hints: true, footer: true });
  });

  it("leaves globally hidden regions out of the override", () => {
    // footer hidden in Settings for all panels — it can't be shown per-panel,
    // and it mustn't count as "something still showing" either
    const next = toggleAllOverride(
      { input: false, hints: false, footer: false },
      { input: false, hints: false },
      { input: false, hints: false, footer: true },
    );
    expect(next).toEqual({ input: true, hints: true });
  });
});

