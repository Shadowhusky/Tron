import { describe, it, expect } from "vitest";
import {
  TAB_DRAG_THRESHOLD_PX,
  canArmTabDrag,
  shouldPromoteToDrag,
} from "../utils/tabDrag";

describe("shouldPromoteToDrag — clicks must never become drags", () => {
  it("ignores a dead-still click", () => {
    expect(shouldPromoteToDrag(500, 500)).toBe(false);
  });

  it("ignores the incidental travel a trackpad click produces", () => {
    // framer-motion would already be dragging at 3px; we must not be.
    for (const drift of [1, 2, 3, 5, 7, 8]) {
      expect(shouldPromoteToDrag(500, 500 + drift)).toBe(false);
      expect(shouldPromoteToDrag(500, 500 - drift)).toBe(false);
    }
  });

  it("promotes once travel exceeds the threshold, in either direction", () => {
    expect(shouldPromoteToDrag(500, 500 + TAB_DRAG_THRESHOLD_PX + 1)).toBe(true);
    expect(shouldPromoteToDrag(500, 500 - TAB_DRAG_THRESHOLD_PX - 1)).toBe(true);
  });

  it("is exclusive at the boundary", () => {
    expect(shouldPromoteToDrag(0, TAB_DRAG_THRESHOLD_PX)).toBe(false);
    expect(shouldPromoteToDrag(0, TAB_DRAG_THRESHOLD_PX + 0.5)).toBe(true);
  });

  it("stays under framer-motion's own 3px pan threshold in spirit — ours is stricter", () => {
    expect(TAB_DRAG_THRESHOLD_PX).toBeGreaterThan(3);
  });
});

describe("canArmTabDrag", () => {
  const base = { button: 0, pointerType: "mouse", isRenaming: false };

  it("arms for a primary mouse press on an idle tab", () => {
    expect(canArmTabDrag(base)).toBe(true);
    expect(canArmTabDrag({ ...base, pointerType: "pen" })).toBe(true);
  });

  it("ignores non-primary buttons so right-click opens the context menu", () => {
    expect(canArmTabDrag({ ...base, button: 1 })).toBe(false);
    expect(canArmTabDrag({ ...base, button: 2 })).toBe(false);
  });

  it("ignores touch so long-press still opens the context menu", () => {
    expect(canArmTabDrag({ ...base, pointerType: "touch" })).toBe(false);
  });

  it("ignores a tab being renamed so the text field stays usable", () => {
    expect(canArmTabDrag({ ...base, isRenaming: true })).toBe(false);
  });
});
