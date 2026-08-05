/**
 * Pure geometry + key helpers for the radial tab switcher (weapon-wheel UI).
 * Angles are in degrees measured from 12 o'clock, increasing CLOCKWISE in
 * screen coordinates. Sector 0 is CENTERED at the top.
 */

/** Angle of (dx, dy) from the wheel center, 0° = up, clockwise, [0, 360). */
export function angleFromTop(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Sector picked by the mouse at offset (dx, dy) from the wheel center — pure
 * DIRECTION, any distance. Returns null inside the deadzone (selection keeps
 * its previous value there so the wheel doesn't jitter around the center).
 */
export function wheelSectorIndex(
  dx: number,
  dy: number,
  count: number,
  deadzone: number,
): number | null {
  if (count <= 0) return null;
  if (Math.hypot(dx, dy) < deadzone) return null;
  const step = 360 / count;
  return Math.floor(((angleFromTop(dx, dy) + step / 2) % 360) / step);
}

/** Point at radius r / angle deg (from top, clockwise) around (cx, cy). */
export function polarPoint(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

/** SVG path for an annular sector from startDeg to endDeg (clockwise). */
export function sectorPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startDeg: number,
  endDeg: number,
): string {
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  const os = polarPoint(cx, cy, rOuter, startDeg);
  const oe = polarPoint(cx, cy, rOuter, endDeg);
  const ie = polarPoint(cx, cy, rInner, endDeg);
  const is = polarPoint(cx, cy, rInner, startDeg);
  return [
    `M ${os.x} ${os.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${oe.x} ${oe.y}`,
    `L ${ie.x} ${ie.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${is.x} ${is.y}`,
    "Z",
  ].join(" ");
}

/** Parse a hotkey combo string ("ctrl+tab") into its parts. */
export function comboParts(combo: string): {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
} {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const mods = new Set(parts.slice(0, -1));
  return {
    key: parts[parts.length - 1] || "",
    ctrl: mods.has("ctrl") || mods.has("control"),
    meta: mods.has("meta") || mods.has("cmd"),
    shift: mods.has("shift"),
    alt: mods.has("alt") || mods.has("option"),
  };
}

/** Whether a keyup event releases part of the hold-combo (main key OR any of
 *  its modifiers) — releasing either commits the wheel selection. */
export function comboKeyReleased(e: { key: string }, combo: string): boolean {
  const parts = comboParts(combo);
  const k = e.key.toLowerCase();
  if (k === parts.key) return true;
  if (k === "control" && parts.ctrl) return true;
  if (k === "meta" && parts.meta) return true;
  if (k === "shift" && parts.shift) return true;
  if (k === "alt" && parts.alt) return true;
  return false;
}
