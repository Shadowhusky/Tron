import { useState } from "react";
import { ArrowRight, ArrowLeft, Sparkles, Rocket } from "lucide-react";
import { useTheme } from "../../../contexts/ThemeContext";
import SpotlightOverlay from "../../../components/ui/SpotlightOverlay";

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
      "Click to switch between Command, Advice, and Agent modes. Or press Ctrl+Shift+M to cycle through them.",
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
  const [testRunStarted, setTestRunStarted] = useState(false);

  const step = STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;

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

  return (
    <SpotlightOverlay
      targetSelector={
        step.target ? `[data-tutorial="${step.target}"]` : undefined
      }
      tooltipPosition={step.position || "bottom"}
      maskId="tutorial-mask"
      tooltipWidth="w-80"
      spotlightPad={2}
      spotlightRadius={12}
      backdropOpacity={0.65}
    >
      {/* Step icon */}
      <div className="mb-3 flex items-center gap-2">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${
            isLast
              ? "bg-linear-to-br from-purple-500 to-pink-500"
              : isFirst
                ? "bg-linear-to-br from-purple-500 to-blue-500"
                : "bg-purple-500/20"
          }`}
        >
          {isLast ? (
            <Rocket className="h-4 w-4 text-white" />
          ) : isFirst ? (
            <Sparkles className="h-4 w-4 text-white" />
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
        className={`mb-4 text-xs leading-relaxed ${isLight ? "text-gray-600" : "text-gray-300"}`}
      >
        {step.description}
      </p>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        {/* Step dots + skip */}
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === currentStep
                    ? "w-4 bg-purple-400"
                    : i < currentStep
                      ? "w-1.5 bg-purple-400/40"
                      : isLight
                        ? "w-1.5 bg-gray-300"
                        : "w-1.5 bg-white/15"
                }`}
              />
            ))}
          </div>
          <button
            onClick={onSkip}
            className={`text-[11px] font-medium transition-colors ${
              isLight
                ? "text-gray-400 hover:text-gray-600"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Skip
          </button>
        </div>

        {/* Buttons */}
        <div className="flex gap-2">
          {!isFirst && (
            <button
              onClick={handleBack}
              className={`ml-3 flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isLight
                  ? "text-gray-500 hover:bg-gray-100"
                  : "text-gray-400 hover:bg-white/10"
              }`}
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </button>
          )}
          <button
            onClick={handleNext}
            className="flex items-center gap-1 rounded-lg bg-purple-600 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-purple-900/20 transition-colors hover:bg-purple-500"
          >
            {isLast ? (
              <>
                <Rocket className="h-3 w-3" />
                Run Agent
              </>
            ) : (
              <>
                Next
                <ArrowRight className="h-3 w-3" />
              </>
            )}
          </button>
        </div>
      </div>
    </SpotlightOverlay>
  );
};

export default TutorialOverlay;
