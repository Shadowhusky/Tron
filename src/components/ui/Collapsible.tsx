import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * Smoothly collapses/expands a region by animating its height. Unmounts the
 * children when hidden (via AnimatePresence) so they don't capture focus or
 * keystrokes.
 *
 * Overflow handling: child popovers (completion dropdowns, model pickers) can
 * extend ABOVE the region, so we clip (`overflow: hidden`) only while the
 * height animation is running and switch back to `visible` once it settles —
 * otherwise a steady-state clip would cut those popovers off. Driven by
 * framer-motion's onAnimationStart/Complete (no effect, no cascading renders).
 */
export function Collapsible({
  visible,
  children,
  className,
  durationMs = 200,
}: {
  visible: boolean;
  children: React.ReactNode;
  className?: string;
  durationMs?: number;
}) {
  const [clipped, setClipped] = useState(false);

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key="collapsible"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: durationMs / 1000, ease: [0.4, 0, 0.2, 1] }}
          onAnimationStart={() => setClipped(true)}
          onAnimationComplete={() => setClipped(false)}
          style={{ overflow: clipped ? "hidden" : "visible" }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
