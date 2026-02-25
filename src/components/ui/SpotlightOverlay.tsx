import { useState, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { useTheme } from "../../contexts/ThemeContext";

interface SpotlightOverlayProps {
  targetSelector?: string;
  tooltipPosition?: "top" | "bottom" | "left" | "right";
  maskId?: string;
  tooltipWidth?: string;
  spotlightPad?: number;
  spotlightRadius?: number;
  backdropOpacity?: number;
  children: React.ReactNode;
}

const SPOT_TRANSITION = { duration: 0.35, ease: "easeOut" as const };

const SpotlightOverlay: React.FC<SpotlightOverlayProps> = ({
  targetSelector,
  tooltipPosition = "bottom",
  maskId = "spotlight-mask",
  tooltipWidth = "w-72",
  spotlightPad = 4,
  spotlightRadius = 10,
  backdropOpacity = 0.6,
  children,
}) => {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const measureTarget = useCallback(() => {
    if (!targetSelector) {
      setTargetRect(null);
      return;
    }
    const el = document.querySelector(targetSelector);
    if (el) {
      setTargetRect(el.getBoundingClientRect());
    } else {
      setTargetRect(null);
    }
  }, [targetSelector]);

  useEffect(() => {
    measureTarget();
    window.addEventListener("resize", measureTarget);
    const interval = setInterval(measureTarget, 300);
    return () => {
      window.removeEventListener("resize", measureTarget);
      clearInterval(interval);
    };
  }, [measureTarget]);

  // Clamp spotlight rect to viewport
  const clamped = targetRect
    ? {
        left: Math.max(0, targetRect.left - spotlightPad),
        top: Math.max(0, targetRect.top - spotlightPad),
        width: Math.min(
          targetRect.width + spotlightPad * 2,
          window.innerWidth - Math.max(0, targetRect.left - spotlightPad),
        ),
        height: Math.min(
          targetRect.height + spotlightPad * 2,
          window.innerHeight - Math.max(0, targetRect.top - spotlightPad),
        ),
      }
    : null;

  // Virtual anchor ref for Radix Popover — tracks the target element's rect
  const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () =>
      DOMRect.fromRect({
        width: 0,
        height: 0,
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }),
  });

  // Update anchor rect whenever targetRect changes
  if (targetRect) {
    anchorRef.current = {
      getBoundingClientRect: () => targetRect,
    };
  } else {
    // No target — anchor to center of viewport
    anchorRef.current = {
      getBoundingClientRect: () =>
        DOMRect.fromRect({
          width: 0,
          height: 0,
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        }),
    };
  }

  return (
    <div
      className="fixed inset-0 z-[9999]"
      style={{ pointerEvents: "none" }}
    >
      {/* Backdrop with cutout (visual only) */}
      {clamped ? (
        <svg
          className="absolute inset-0 h-full w-full"
          style={{ pointerEvents: "none" }}
        >
          <defs>
            <mask id={maskId}>
              <rect width="100%" height="100%" fill="white" />
              <motion.rect
                initial={false}
                animate={{
                  x: clamped.left,
                  y: clamped.top,
                  width: clamped.width,
                  height: clamped.height,
                }}
                transition={SPOT_TRANSITION}
                rx={spotlightRadius}
                ry={spotlightRadius}
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill={`rgba(0,0,0,${backdropOpacity})`}
            mask={`url(#${maskId})`}
          />
        </svg>
      ) : (
        <div
          className="absolute inset-0"
          style={{
            pointerEvents: "none",
            backgroundColor: `rgba(0,0,0,${backdropOpacity})`,
          }}
        />
      )}

      {/* Click-blocker frame: blocks backdrop clicks, leaves target area clickable */}
      {clamped ? (
        <>
          <div
            className="fixed top-0 left-0 w-full"
            style={{ height: clamped.top, pointerEvents: "auto" }}
          />
          <div
            className="fixed left-0 w-full"
            style={{
              top: clamped.top + clamped.height,
              bottom: 0,
              pointerEvents: "auto",
            }}
          />
          <div
            className="fixed left-0"
            style={{
              top: clamped.top,
              width: clamped.left,
              height: clamped.height,
              pointerEvents: "auto",
            }}
          />
          <div
            className="fixed"
            style={{
              top: clamped.top,
              left: clamped.left + clamped.width,
              right: 0,
              height: clamped.height,
              pointerEvents: "auto",
            }}
          />
        </>
      ) : (
        <div className="fixed inset-0" style={{ pointerEvents: "auto" }} />
      )}

      {/* Glow ring around target */}
      {clamped && (
        <motion.div
          className="absolute border-2 border-purple-400/70 shadow-[0_0_24px_rgba(168,85,247,0.4)]"
          initial={false}
          animate={{
            left: clamped.left,
            top: clamped.top,
            width: clamped.width,
            height: clamped.height,
          }}
          transition={SPOT_TRANSITION}
          style={{
            pointerEvents: "none",
            borderRadius: spotlightRadius,
          }}
        />
      )}

      {/* Tooltip — Radix Popover handles boundary detection & flipping */}
      <Popover.Root open>
        <Popover.Anchor virtualRef={anchorRef as any} />
        <Popover.Portal>
          <Popover.Content
            side={tooltipPosition}
            align="center"
            sideOffset={12}
            collisionPadding={12}
            className={`${tooltipWidth} rounded-xl border p-4 shadow-2xl z-[9999] ${
              isLight
                ? "border-gray-200 bg-white text-gray-900"
                : "border-white/10 bg-[#141420] text-white"
            }`}
            onOpenAutoFocus={(e) => e.preventDefault()}
            style={{ pointerEvents: "auto" }}
          >
            {children}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
};

export default SpotlightOverlay;
