import { describe, it, expect } from "vitest";
import {
  angleFromTop,
  wheelSectorIndex,
  polarPoint,
  sectorPath,
  comboKeyReleased,
  comboParts,
} from "../utils/tabWheel";

describe("angleFromTop", () => {
  it("maps compass directions (screen coords, clockwise)", () => {
    expect(angleFromTop(0, -1)).toBeCloseTo(0);   // up
    expect(angleFromTop(1, 0)).toBeCloseTo(90);   // right
    expect(angleFromTop(0, 1)).toBeCloseTo(180);  // down
    expect(angleFromTop(-1, 0)).toBeCloseTo(270); // left
  });
});

describe("wheelSectorIndex", () => {
  it("centers sector 0 at the top and walks clockwise", () => {
    expect(wheelSectorIndex(0, -100, 4, 20)).toBe(0);   // up
    expect(wheelSectorIndex(100, 0, 4, 20)).toBe(1);    // right
    expect(wheelSectorIndex(0, 100, 4, 20)).toBe(2);    // down
    expect(wheelSectorIndex(-100, 0, 4, 20)).toBe(3);   // left
  });

  it("selects by direction regardless of distance", () => {
    expect(wheelSectorIndex(0, -25, 4, 20)).toBe(0);
    expect(wheelSectorIndex(0, -2500, 4, 20)).toBe(0);
  });

  it("straddles the top boundary correctly (sector 0 spans -half..+half)", () => {
    // 8 sectors → 45° each; 20° right of up is still sector 0, 30° is sector 1
    const x20 = Math.sin((20 * Math.PI) / 180) * 100;
    const y20 = -Math.cos((20 * Math.PI) / 180) * 100;
    expect(wheelSectorIndex(x20, y20, 8, 10)).toBe(0);
    const x30 = Math.sin((30 * Math.PI) / 180) * 100;
    const y30 = -Math.cos((30 * Math.PI) / 180) * 100;
    expect(wheelSectorIndex(x30, y30, 8, 10)).toBe(1);
    // slightly LEFT of up wraps to the last sector's half → still 0
    expect(wheelSectorIndex(-x20, y20, 8, 10)).toBe(0);
  });

  it("returns null inside the deadzone and for empty wheels", () => {
    expect(wheelSectorIndex(3, -4, 4, 20)).toBeNull(); // dist 5 < 20
    expect(wheelSectorIndex(0, -100, 0, 20)).toBeNull();
  });
});

describe("polarPoint / sectorPath", () => {
  it("places polar points from the top, clockwise", () => {
    expect(polarPoint(0, 0, 10, 0).y).toBeCloseTo(-10);
    expect(polarPoint(0, 0, 10, 90).x).toBeCloseTo(10);
  });

  it("builds a closed annular path", () => {
    const p = sectorPath(100, 100, 40, 90, -22.5, 22.5);
    expect(p.startsWith("M ")).toBe(true);
    expect(p.endsWith("Z")).toBe(true);
    expect((p.match(/A /g) || []).length).toBe(2);
  });
});

describe("comboParts / comboKeyReleased", () => {
  it("parses modifiers and main key", () => {
    expect(comboParts("ctrl+tab")).toEqual({ key: "tab", ctrl: true, meta: false, shift: false, alt: false });
    expect(comboParts("meta+shift+w").shift).toBe(true);
  });

  it("commits on release of the main key or a combo modifier only", () => {
    expect(comboKeyReleased({ key: "Tab" }, "ctrl+tab")).toBe(true);
    expect(comboKeyReleased({ key: "Control" }, "ctrl+tab")).toBe(true);
    expect(comboKeyReleased({ key: "Shift" }, "ctrl+tab")).toBe(false);
    expect(comboKeyReleased({ key: "a" }, "ctrl+tab")).toBe(false);
  });
});
