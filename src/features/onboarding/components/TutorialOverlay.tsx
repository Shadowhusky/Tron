import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ArrowRight, ArrowLeft, Sparkles, Rocket } from "lucide-react";
import { useTheme } from "../../../contexts/ThemeContext";

interface TutorialStep {
  id: string;
  target?: string; // data-tutorial="<target>" selector, undefined = centered
  title: string;
  description: string;
  position?: "top" | "bottom" | "left" | "right";
}

const STEPS: TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to Tron",
    description:
      "Your AI-powered terminal. Let's take a quick tour of the key features.",
  },
  {
    id: "smart-input",
    target: "smart-input",
    title: "Smart Input",
    description:
      "Type commands or natural language — Tron auto-detects the mode. Press Enter to execute.",
    position: "top",
  },
  {
    id: "mode-switcher",
    target: "mode-switcher",
    title: "Input Modes",
    description:
      "Click to switch between Command, Advice, and Agent modes. Or double-tap Shift to cycle through them.",
    position: "top",
  },
  {
    id: "context-bar",
    target: "context-bar",
    title: "Context Bar",
    description:
      "Shows your working directory, context usage ring, and model switcher. Click to explore.",
    position: "top",
  },
  {
    id: "tab-bar",
    target: "tab-bar",
    title: "Tabs",
    description:
      "Manage multiple terminal sessions. Press ⌘T to open a new tab, ⌘W to close.",
    position: "bottom",
  },
  {
    id: "test-run",
    title: "Try It Out!",
    description:
      "Let's run your first agent task. We'll ask the AI to \"list files in this directory\" so you can see the full flow.",
  },
];

interface TutorialOverlayProps {
  onComplete: () => void;
  onSkip: () => void;
  onTestRun: (prompt: string) => void;
}

const TutorialOverlay: React.FC<TutorialOverlayProps> = ({
  onComplete,
  onSkip,
  onTestRun,
}) => {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [testRunStarted, setTestRunStarted] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const step = STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;

  // Find and measure target element
  const measureTarget = useCallback(() => {
    if (!step.target) {
      setTargetRect(null);
      return;
    }
    const el = document.querySelector(`[data-tutorial="${step.target}"]`);
    if (el) {
      setTargetRect(el.getBoundingClientRect());
    } else {
      setTargetRect(null);
    }
  }, [step.target]);

  useEffect(() => {
    measureTarget();
    // Re-measure on resize/scroll
    window.addEventListener("resize", measureTarget);
    window.addEventListener("scroll", measureTarget, true);
    const interval = setInterval(measureTarget, 500); // re-measure periodically
    return () => {
      window.removeEventListener("resize", measureTarget);
      window.removeEventListener("scroll", measureTarget, true);
      clearInterval(interval);
    };
  }, [measureTarget]);

  const handleNext = () => {
    if (isLast) {
      if (!testRunStarted) {
        setTestRunStarted(true);
        onTestRun("list files in this directory");
        // Auto-complete after a brief delay to let user see the agent panel
        setTimeout(() => onComplete(), 500);
      }
      return;
    }
    setCurrentStep((s) => s + 1);
  };

  const handleBack = () => {
    if (!isFirst) setCurrentStep((s) => s - 1);
  };

  // Compute tooltip position relative to target
  const getTooltipStyle = (): React.CSSProperties => {
    if (!targetRect) {
      // Center on screen
      return {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };
    }

    const padding = 16;
    const pos = step.position || "bottom";

    switch (pos) {
      case "top":
        return {
          bottom: window.innerHeight - targetRect.top + padding,
          left: targetRect.left + targetRect.width / 2,
          transform: "translateX(-50%)",
        };
      case "bottom":
        return {
          top: targetRect.bottom + padding,
          left: targetRect.left + targetRect.width / 2,
          transform: "translateX(-50%)",
        };
      case "left":
        return {
          top: targetRect.top + targetRect.height / 2,
          right: window.innerWidth - targetRect.left + padding,
          transform: "translateY(-50%)",
        };
      case "right":
        return {
          top: targetRect.top + targetRect.height / 2,
          left: targetRect.right + padding,
          transform: "translateY(-50%)",
        };
      default:
        return {
          top: targetRect.bottom + padding,
          left: targetRect.left + targetRect.width / 2,
          transform: "translateX(-50%)",
        };
    }
  };

  // Spotlight cutout dimensions
  const spotlightPad = 8;
  const spotlightRadius = 12;

  return (
    <div className="fixed inset-0 z-9999" style={{ pointerEvents: "auto" }}>
      {/* Backdrop with cutout */}
      {targetRect ? (
        <svg
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: "auto" }}
        >
          <defs>
            <mask id="tutorial-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={targetRect.left - spotlightPad}
                y={targetRect.top - spotlightPad}
                width={targetRect.width + spotlightPad * 2}
                height={targetRect.height + spotlightPad * 2}
                rx={spotlightRadius}
                ry={spotlightRadius}
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.65)"
            mask="url(#tutorial-mask)"
          />
        </svg>
      ) : (
        <div className="absolute inset-0 bg-black/65" />
      )}

      {/* Spotlight glow ring */}
      {targetRect && (
        <div
          className="absolute rounded-xl border-2 border-purple-400/60 shadow-[0_0_20px_rgba(168,85,247,0.3)]"
          style={{
            left: targetRect.left - spotlightPad,
            top: targetRect.top - spotlightPad,
            width: targetRect.width + spotlightPad * 2,
            height: targetRect.height + spotlightPad * 2,
            pointerEvents: "none",
            borderRadius: spotlightRadius,
          }}
        />
      )}

      {/* Skip button */}
      <button
        onClick={onSkip}
        className={`absolute top-4 right-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors z-10 ${
          isLight
            ? "bg-white/90 text-gray-600 hover:text-gray-900 hover:bg-white shadow"
            : "bg-white/10 text-gray-300 hover:text-white hover:bg-white/20"
        }`}
      >
        <X className="w-3 h-3" />
        Skip Tutorial
      </button>

      {/* Tooltip card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step.id}
          ref={tooltipRef}
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.96 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className={`fixed max-w-sm w-80 rounded-2xl p-5 shadow-2xl border z-10 ${
            isLight
              ? "bg-white border-gray-200 text-gray-900"
              : "bg-[#141420] border-white/10 text-white shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
          }`}
          style={getTooltipStyle()}
        >
          {/* Step icon */}
          <div className="flex items-center gap-2 mb-3">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                isLast
                  ? "bg-linear-to-br from-purple-500 to-pink-500"
                  : isFirst
                    ? "bg-linear-to-br from-purple-500 to-blue-500"
                    : "bg-purple-500/20"
              }`}
            >
              {isLast ? (
                <Rocket className="w-4 h-4 text-white" />
              ) : isFirst ? (
                <Sparkles className="w-4 h-4 text-white" />
              ) : (
                <span className="text-sm font-bold text-purple-400">
                  {currentStep}
                </span>
              )}
            </div>
            <div>
              <h3 className="text-sm font-bold">{step.title}</h3>
              <span
                className={`text-[10px] ${isLight ? "text-gray-400" : "text-gray-500"}`}
              >
                {currentStep + 1} of {STEPS.length}
              </span>
            </div>
          </div>

          {/* Description */}
          <p
            className={`text-xs leading-relaxed mb-4 ${isLight ? "text-gray-600" : "text-gray-300"}`}
          >
            {step.description}
          </p>

          {/* Navigation */}
          <div className="flex items-center justify-between">
            {/* Step dots */}
            <div className="flex gap-1">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                    i === currentStep
                      ? "bg-purple-400 w-4"
                      : i < currentStep
                        ? "bg-purple-400/40"
                        : isLight
                          ? "bg-gray-300"
                          : "bg-white/15"
                  }`}
                />
              ))}
            </div>

            {/* Buttons */}
            <div className="flex gap-2">
              {!isFirst && (
                <button
                  onClick={handleBack}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    isLight
                      ? "text-gray-500 hover:bg-gray-100"
                      : "text-gray-400 hover:bg-white/10"
                  }`}
                >
                  <ArrowLeft className="w-3 h-3" />
                  Back
                </button>
              )}
              <button
                onClick={handleNext}
                className="flex items-center gap-1 px-4 py-1.5 rounded-lg text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white transition-colors shadow-lg shadow-purple-900/20"
              >
                {isLast ? (
                  <>
                    <Rocket className="w-3 h-3" />
                    Run Agent
                  </>
                ) : (
                  <>
                    Next
                    <ArrowRight className="w-3 h-3" />
                  </>
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

export default TutorialOverlay;
