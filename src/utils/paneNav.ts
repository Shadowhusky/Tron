/**
 * Pure geometry helpers for split-pane behaviors — directional focus
 * navigation and divider magnet-snap. Kept free of DOM/React so they're
 * unit-tested; callers pass in measured rectangles / positions.
 */

export interface PaneRect {
  sessionId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type FocusDirection = "left" | "right" | "up" | "down";

const centerX = (r: PaneRect) => (r.left + r.right) / 2;
const centerY = (r: PaneRect) => (r.top + r.bottom) / 2;
/** 1-D overlap length of two intervals. */
const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Pick the pane to move focus to from `fromId` in `direction`, iTerm2/tmux
 * style: only panes strictly on that side are candidates, ranked by distance
 * along the axis with a strong bonus for perpendicular overlap (so focus
 * follows the visually-adjacent pane, not a far diagonal one). Returns the
 * chosen sessionId, or null when there's nothing in that direction.
 */
export function nearestPaneInDirection(
  fromId: string,
  panes: PaneRect[],
  direction: FocusDirection,
): string | null {
  const from = panes.find((p) => p.sessionId === fromId);
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;

  let best: { id: string; score: number } | null = null;
  for (const p of panes) {
    if (p.sessionId === fromId) continue;
    // Must be on the correct side (by center, with a small epsilon so panes
    // sharing an edge but clearly on one side still count).
    const along = horizontal ? centerX(p) - centerX(from) : centerY(p) - centerY(from);
    if (sign < 0 ? along >= -1 : along <= 1) continue;
    const dist = Math.abs(along);
    // Perpendicular overlap ratio (0..1) relative to the source pane's extent.
    const perp = horizontal
      ? overlap(p.top, p.bottom, from.top, from.bottom) / Math.max(1, from.bottom - from.top)
      : overlap(p.left, p.right, from.left, from.right) / Math.max(1, from.right - from.left);
    // Lower is better: distance, discounted heavily when the panes overlap.
    const score = dist * (perp > 0 ? 1 - 0.5 * perp : 3);
    if (!best || score < best.score) best = { id: p.sessionId, score };
  }
  return best ? best.id : null;
}

/**
 * Magnet-snap for a dragged divider: if `pos` is within `threshold` px of any
 * other divider position on the same axis, return that aligned position so the
 * two dividers line up (most editors/terminals do this). Snaps to the CLOSEST
 * candidate within range; returns `pos` unchanged when nothing is near.
 */
export function snapDividerPosition(
  pos: number,
  otherPositions: number[],
  threshold: number,
): number {
  let bestPos = pos;
  let bestDist = threshold;
  for (const o of otherPositions) {
    const d = Math.abs(o - pos);
    if (d <= bestDist) {
      bestDist = d;
      bestPos = o;
    }
  }
  return bestPos;
}
