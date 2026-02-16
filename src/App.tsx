import { useState, useEffect, useRef } from "react";
import { LayoutProvider, useLayout } from "./contexts/LayoutContext";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { HistoryProvider } from "./contexts/HistoryContext";
import { AgentProvider } from "./contexts/AgentContext";
import OnboardingWizard from "./features/onboarding/components/OnboardingWizard";
import SplitPane from "./components/layout/SplitPane";

// Inner component to use contexts
const AppContent = () => {
  const {
    tabs,
    activeTabId,
    createTab,
    selectTab,
    closeTab,
    openSettingsTab,
    reorderTabs,
  } = useLayout();
  const dragTabRef = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const { resolvedTheme } = useTheme();
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    const hasConfigured = localStorage.getItem("tron_configured");
    if (!hasConfigured) {
      setShowOnboarding(true);
    }
  }, []);

  const handleOnboardingComplete = () => {
    localStorage.setItem("tron_configured", "true");
    setShowOnboarding(false);
  };

  // Global Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + , : Open Settings
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openSettingsTab();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openSettingsTab]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div
      className={`flex flex-col h-screen w-full overflow-hidden transition-colors duration-300 ${
        resolvedTheme === "dark"
          ? "bg-[#0a0a0a] text-white"
          : resolvedTheme === "modern"
            ? "bg-[#050510] text-white"
            : "bg-gray-50 text-gray-900"
      }`}
    >
      {/* Header / Tabs */}
      <div
        className={`flex items-center h-10 px-2 gap-2 border-b select-none shrink-0 ${
          resolvedTheme === "dark"
            ? "bg-gray-900/50 border-white/5"
            : resolvedTheme === "modern"
              ? "bg-black/40 border-purple-500/10 backdrop-blur-md shadow-[0_1px_0_rgba(168,85,247,0.1)]"
              : "bg-white border-gray-200"
        }`}
        style={{ WebkitAppRegion: "drag" } as any}
      >
        {/* Traffic Lights Spacer (Mac) */}
        <div className="w-16" />

        {/* Tabs */}
        <div
          className="flex items-center gap-1 flex-1 overflow-x-auto no-scrollbar"
          style={{ WebkitAppRegion: "drag" } as any}
        >
          {tabs.map((tab, tabIndex) => (
            <div key={tab.id} className="relative flex items-center">
              {/* Drop indicator — left edge */}
              {dragOverIndex === tabIndex && draggingIndex !== null && draggingIndex !== tabIndex && (
                <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-purple-500 z-20 -translate-x-0.5 animate-pulse" />
              )}
              <div
                onClick={() => selectTab(tab.id)}
                draggable
                onDragStart={(e) => {
                  dragTabRef.current = tabIndex;
                  setDraggingIndex(tabIndex);
                  e.dataTransfer.effectAllowed = "move";
                  // Custom ghost: clone the tab element with styling
                  const ghost = e.currentTarget.cloneNode(true) as HTMLElement;
                  ghost.style.position = "absolute";
                  ghost.style.top = "-1000px";
                  ghost.style.opacity = "0.85";
                  ghost.style.transform = "scale(0.95)";
                  ghost.style.borderRadius = "6px";
                  ghost.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
                  ghost.style.background = resolvedTheme === "light" ? "#fff" : "#1a1a2e";
                  ghost.style.border = "1px solid rgba(168,85,247,0.4)";
                  ghost.style.pointerEvents = "none";
                  document.body.appendChild(ghost);
                  e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
                  requestAnimationFrame(() => document.body.removeChild(ghost));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverIndex(tabIndex);
                }}
                onDragLeave={() => {
                  setDragOverIndex((prev) => (prev === tabIndex ? null : prev));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTabRef.current !== null && dragTabRef.current !== tabIndex) {
                    reorderTabs(dragTabRef.current, tabIndex);
                  }
                  dragTabRef.current = null;
                  setDraggingIndex(null);
                  setDragOverIndex(null);
                }}
                onDragEnd={() => {
                  dragTabRef.current = null;
                  setDraggingIndex(null);
                  setDragOverIndex(null);
                }}
                style={{ WebkitAppRegion: "no-drag" } as any}
                className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-md text-xs cursor-grab active:cursor-grabbing transition-all border max-w-[200px] min-w-[100px] ${
                  draggingIndex === tabIndex ? "opacity-30 scale-95" : ""
                } ${
                  tab.id === activeTabId
                    ? resolvedTheme === "dark"
                      ? "bg-gray-800 text-white border-white/10 shadow-sm"
                      : resolvedTheme === "modern"
                        ? "bg-purple-900/20 text-white border-purple-500/20 shadow-[0_0_10px_rgba(168,85,247,0.1)] backdrop-blur-md"
                        : "bg-white text-gray-900 border-gray-300 shadow-sm"
                    : resolvedTheme === "light"
                      ? "border-transparent hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                      : "border-transparent hover:bg-white/5 text-gray-500 hover:text-gray-300"
                }`}
              >
                <span className="truncate flex-1">{tab.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      tab.title === "Settings" ||
                      window.confirm(
                        "Are you sure you want to close this session?",
                      )
                    ) {
                      closeTab(tab.id);
                    }
                  }}
                  className={`opacity-0 group-hover:opacity-100 p-0.5 rounded-sm hover:bg-white/20 transition-opacity ${tab.id === activeTabId ? "opacity-100" : ""}`}
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
              {/* Drop indicator — right edge of last tab */}
              {tabIndex === tabs.length - 1 && dragOverIndex === tabs.length && draggingIndex !== null && (
                <div className="absolute right-0 top-1 bottom-1 w-0.5 rounded-full bg-purple-500 z-20 translate-x-0.5 animate-pulse" />
              )}
            </div>
          ))}
          <button
            onClick={createTab}
            style={{ WebkitAppRegion: "no-drag" } as any}
            className="p-1.5 rounded-md hover:bg-white/10 text-gray-500 transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        </div>

        {/* Settings Button */}
        <button
          onClick={openSettingsTab}
          className={`p-2 rounded-md transition-colors ${resolvedTheme === "modern" ? "hover:bg-white/20 text-purple-300" : resolvedTheme === "light" ? "hover:bg-gray-100 text-gray-500" : "hover:bg-white/10 text-gray-500"}`}
          title="Settings (Cmd+,)"
          style={{ WebkitAppRegion: "no-drag" } as any}
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </button>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 relative overflow-hidden">
        {activeTab ? (
          <SplitPane node={activeTab.root} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 flex-col gap-4">
            <div className="text-xl font-medium">No Open Tabs</div>
            <button
              onClick={createTab}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors shadow-lg shadow-purple-900/20"
            >
              Create New Terminal
            </button>
            <div className="text-xs opacity-50">
              Press Cmd+T to open a new tab
            </div>
          </div>
        )}
      </div>

      {/* Onboarding Wizard */}
      {showOnboarding && (
        <OnboardingWizard onComplete={handleOnboardingComplete} />
      )}
    </div>
  );
};

const App = () => {
  return (
    <ThemeProvider>
      <HistoryProvider>
        <AgentProvider>
          <LayoutProvider>
            <AppContent />
          </LayoutProvider>
        </AgentProvider>
      </HistoryProvider>
    </ThemeProvider>
  );
};

export default App;
