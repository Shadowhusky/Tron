import { describe, it, expect } from "vitest";
import { nearestPaneInDirection, snapDividerPosition, type PaneRect } from "../utils/paneNav";

const rect = (sessionId: string, left: number, top: number, right: number, bottom: number): PaneRect =>
  ({ sessionId, left, top, right, bottom });

describe("nearestPaneInDirection", () => {
  // Layout:  A | B   (side by side), C below A
  const A = rect("A", 0, 0, 100, 100);
  const B = rect("B", 100, 0, 200, 100);
  const C = rect("C", 0, 100, 100, 200);
  const panes = [A, B, C];

  it("moves right to the adjacent pane", () => {
    expect(nearestPaneInDirection("A", panes, "right")).toBe("B");
  });
  it("moves down to the pane below", () => {
    expect(nearestPaneInDirection("A", panes, "down")).toBe("C");
  });
  it("moves left/up back to A", () => {
    expect(nearestPaneInDirection("B", panes, "left")).toBe("A");
    expect(nearestPaneInDirection("C", panes, "up")).toBe("A");
  });
  it("returns null when nothing lies in that direction", () => {
    expect(nearestPaneInDirection("A", panes, "left")).toBeNull();
    expect(nearestPaneInDirection("A", panes, "up")).toBeNull();
  });
  it("prefers the overlapping neighbor over a far diagonal one", () => {
    // D is directly right and overlaps; E is right but far down (no overlap)
    const S = rect("S", 0, 0, 100, 100);
    const D = rect("D", 100, 0, 200, 100);
    const E = rect("E", 120, 300, 220, 400);
    expect(nearestPaneInDirection("S", [S, D, E], "right")).toBe("D");
  });
  it("returns null for an unknown source pane", () => {
    expect(nearestPaneInDirection("Z", panes, "right")).toBeNull();
  });
});

describe("snapDividerPosition", () => {
  it("snaps to a nearby divider within threshold", () => {
    expect(snapDividerPosition(402, [200, 400, 800], 8)).toBe(400);
  });
  it("does not snap when nothing is within threshold", () => {
    expect(snapDividerPosition(402, [200, 420, 800], 8)).toBe(402);
  });
  it("snaps to the closest candidate when several are near", () => {
    expect(snapDividerPosition(400, [398, 405], 8)).toBe(398);
  });
  it("returns the position unchanged with no candidates", () => {
    expect(snapDividerPosition(300, [], 8)).toBe(300);
  });
  it("snaps at exactly the threshold boundary", () => {
    expect(snapDividerPosition(408, [400], 8)).toBe(400);
    expect(snapDividerPosition(409, [400], 8)).toBe(409);
  });
});
