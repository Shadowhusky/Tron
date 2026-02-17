/**
 * Shared framer-motion variants used across the app.
 * Import these instead of duplicating animation configs.
 */
import type { Variants, Transition } from "framer-motion";

// ── Timing presets ──────────────────────────────────────────────
export const spring: Transition = { type: "spring", stiffness: 400, damping: 30 };
export const springGentle: Transition = { type: "spring", stiffness: 300, damping: 25 };
export const springBouncy: Transition = { type: "spring", stiffness: 500, damping: 20 };
export const ease: Transition = { duration: 0.2, ease: "easeOut" };
export const easeSlow: Transition = { duration: 0.35, ease: "easeOut" };

// ── Fade ────────────────────────────────────────────────────────
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

// ── Fade + Scale (for modals, popovers, badges) ────────────────
export const fadeScale: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15, ease: "easeIn" } },
};

// ── Slide up (for panels, overlays, dropdowns) ─────────────────
export const slideUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" } },
  exit: { opacity: 0, y: 12, transition: { duration: 0.15, ease: "easeIn" } },
};

// ── Slide down (for dropdowns above) ────────────────────────────
export const slideDown: Variants = {
  hidden: { opacity: 0, y: -8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.12, ease: "easeIn" } },
};

// ── Slide panel from bottom (agent overlay, settings) ──────────
export const slidePanel: Variants = {
  hidden: { opacity: 0, y: 20, height: 0 },
  visible: {
    opacity: 1,
    y: 0,
    height: "auto",
    transition: { duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] },
  },
  exit: {
    opacity: 0,
    y: 10,
    height: 0,
    transition: { duration: 0.2, ease: "easeIn" },
  },
};

// ── Stagger container ──────────────────────────────────────────
export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.05,
    },
  },
  exit: {
    opacity: 0,
    transition: { staggerChildren: 0.02, staggerDirection: -1 },
  },
};

// Faster stagger for lists with many items
export const staggerFast: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.025,
      delayChildren: 0.02,
    },
  },
};

// ── Stagger child items ─────────────────────────────────────────
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.1 } },
};

export const staggerItemX: Variants = {
  hidden: { opacity: 0, x: -8 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, x: -8, transition: { duration: 0.1 } },
};

// ── Scale pop (for buttons, icons, badges) ──────────────────────
export const scalePop: Variants = {
  hidden: { opacity: 0, scale: 0.8 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { type: "spring", stiffness: 500, damping: 25 },
  },
  exit: { opacity: 0, scale: 0.8, transition: { duration: 0.1 } },
};

// ── Tab content swap ────────────────────────────────────────────
export const tabContent: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

// ── Overlay / backdrop ──────────────────────────────────────────
export const overlay: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.3 } },
  exit: { opacity: 0, transition: { duration: 0.25 } },
};

// ── Wizard step transition ──────────────────────────────────────
export const wizardStep: Variants = {
  hidden: { opacity: 0, x: 30 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.3, ease: "easeOut" } },
  exit: { opacity: 0, x: -30, transition: { duration: 0.2, ease: "easeIn" } },
};

// ── Layout height collapse/expand ───────────────────────────────
export const collapse: Variants = {
  hidden: { opacity: 0, height: 0, overflow: "hidden" },
  visible: {
    opacity: 1,
    height: "auto",
    overflow: "hidden",
    transition: { duration: 0.25, ease: "easeOut" },
  },
  exit: {
    opacity: 0,
    height: 0,
    overflow: "hidden",
    transition: { duration: 0.15, ease: "easeIn" },
  },
};
