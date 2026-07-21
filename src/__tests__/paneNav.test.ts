import { describe, it, expect } from "vitest";
import {
  nearestPaneInDirection,
  snapDividerPosition,
  redistributeAfterClose,
  removePaneFromTree,
  type PaneRect,
} from "../utils/paneNav";
import type { LayoutNode } from "../types";

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

describe("redistributeAfterClose (minimal layout shift)", () => {
  it("gives the freed space to the PREVIOUS sibling; others unchanged", () => {
    // [20, 30, 50] close index 1 -> previous absorbs: [50, 50]
    expect(redistributeAfterClose([20, 30, 50], 1)).toEqual([50, 50]);
  });
  it("gives space to the next sibling when the first pane closes", () => {
    expect(redistributeAfterClose([20, 30, 50], 0)).toEqual([50, 50]);
  });
  it("keeps custom proportions of untouched panes intact", () => {
    // [10, 20, 30, 40] close last -> [10, 20, 70]
    expect(redistributeAfterClose([10, 20, 30, 40], 3)).toEqual([10, 20, 70]);
  });
  it("handles the two-pane case (remaining takes all)", () => {
    expect(redistributeAfterClose([35, 65], 1)).toEqual([100]);
  });
});

describe("removePaneFromTree (preserves sibling sizes)", () => {
  const leaf = (id: string): LayoutNode => ({ type: "leaf", sessionId: id });

  it("removes a leaf and lets the neighbor absorb its share", () => {
    const root: LayoutNode = {
      type: "split", direction: "horizontal",
      children: [leaf("a"), leaf("b"), leaf("c")],
      sizes: [25, 25, 50],
    };
    const out = removePaneFromTree(root, "b");
    expect(out).not.toBeNull();
    if (out && out.type === "split") {
      expect(out.children.map((c) => c.type === "leaf" ? c.sessionId : "")).toEqual(["a", "c"]);
      expect(out.sizes).toEqual([50, 50]); // a absorbed b's 25; c untouched
    }
  });

  it("collapses a 2-child split into the surviving child", () => {
    const root: LayoutNode = {
      type: "split", direction: "horizontal",
      children: [leaf("a"), leaf("b")], sizes: [30, 70],
    };
    const out = removePaneFromTree(root, "a");
    expect(out).toEqual(leaf("b"));
  });

  it("keeps the OUTER split sizes when an inner split collapses", () => {
    // [a | (b/c)] sized [40, 60]; closing c collapses inner split to b,
    // but the outer 40/60 stays — no layout shift for a.
    const root: LayoutNode = {
      type: "split", direction: "horizontal",
      children: [
        leaf("a"),
        { type: "split", direction: "vertical", children: [leaf("b"), leaf("c")], sizes: [50, 50] },
      ],
      sizes: [40, 60],
    };
    const out = removePaneFromTree(root, "c");
    expect(out && out.type === "split" && out.sizes).toEqual([40, 60]);
    if (out && out.type === "split") expect(out.children[1]).toEqual(leaf("b"));
  });

  it("returns null when the last pane is removed", () => {
    expect(removePaneFromTree(leaf("only"), "only")).toBeNull();
  });

  it("defaults missing sizes to equal before redistributing (old persisted layouts)", () => {
    const root = {
      type: "split", direction: "horizontal",
      children: [leaf("a"), leaf("b"), leaf("c")], // no sizes -> 33.3 each
    } as unknown as LayoutNode;
    const out = removePaneFromTree(root, "c");
    if (out && out.type === "split") {
      expect(out.sizes![0]).toBeCloseTo(100 / 3, 3);
      expect(out.sizes![1]).toBeCloseTo(200 / 3, 3);
    }
  });
});
