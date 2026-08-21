/**
 * Gate that decides when a held pointer on a tab becomes a real drag.
 *
 * Why this exists: framer-motion's `Reorder.Item` hard-enables `drag={axis}`,
 * and its PanSession promotes a pointerdown into a drag after only 3px
 * (`distanceThreshold = 3`). From that moment the item is out of layout flow
 * and `checkReorder` evaluates swaps on every pointer move, comparing the
 * dragged item's edge against a neighbour's centre using layout boxes measured
 * at the last render. If the tab strip has scrolled since that measurement,
 * those boxes are stale and a swap can fire almost immediately — so an
 * ordinary click occasionally reordered tabs.
 *
 * Suppressing the reorder after the fact doesn't work: framer-motion has
 * already entered drag state. Instead TabBar sets `dragListener={false}` and
 * starts the drag itself, only once this gate says the pointer really moved.
 */

/** Horizontal travel (px) before a press counts as a drag rather than a click. */
export const TAB_DRAG_THRESHOLD_PX = 8;

/** True when a held pointer has travelled far enough horizontally to drag. */
export function shouldPromoteToDrag(
  startX: number,
  currentX: number,
  threshold: number = TAB_DRAG_THRESHOLD_PX,
): boolean {
  return Math.abs(currentX - startX) > threshold;
}

/** Whether a pointerdown is eligible to arm the drag gate at all.
 *  Touch is excluded so long-press keeps opening the context menu, and a tab
 *  being renamed must stay a plain text field. */
export function canArmTabDrag(opts: {
  button: number;
  pointerType: string;
  isRenaming: boolean;
}): boolean {
  return opts.button === 0 && opts.pointerType !== "touch" && !opts.isRenaming;
}
