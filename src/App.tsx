import { useState, useEffect } from "react";
import { LayoutProvider, useLayout } from "./contexts/LayoutContext";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { HistoryProvider } from "./contexts/HistoryContext";
import { AgentProvider } from "./contexts/AgentContext";
import OnboardingWizard from "./features/onboarding/components/OnboardingWizard";
import SplitPane from "./components/layout/SplitPane";
import TabBar from "./components/layout/TabBar";
import { STORAGE_KEYS } from "./constants/storage";
import { themeClass } from "./utils/theme";
import { aiService } from "./services/ai";

// Inner component to use contexts
const AppContent = () => {
  const {
    tabs,
    activeTabId,
    sessions,
    createTab,
    selectTab,
    closeTab,
    openSettingsTab,
    reorderTabs,
    updateSessionConfig,
  } = useLayout();
  const { resolvedTheme } = useTheme();
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    const hasConfigured = localStorage.getItem(STORAGE_KEYS.CONFIGURED);
    if (!hasConfigured) {
      setShowOnboarding(true);
    }
  }, []);

  const handleOnboardingComplete = () => {
    localStorage.setItem(STORAGE_KEYS.CONFIGURED, "true");
    setShowOnboarding(false);
    // Apply the newly saved config to all existing sessions
    const newConfig = aiService.getConfig();
    sessions.forEach((_, sessionId) => {
      if (sessionId !== "settings") {
        updateSessionConfig(sessionId, newConfig);
      }
    });
  };

  // Global Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
      className={`flex flex-col h-screen w-full overflow-hidden transition-colors duration-300 ${themeClass(
        resolvedTheme,
        {
          dark: "bg-[#0a0a0a] text-white",
          modern: "bg-[#050510] text-white",
          light: "bg-gray-50 text-gray-900",
        },
      )}`}
    >
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        resolvedTheme={resolvedTheme}
        onSelect={selectTab}
        onClose={closeTab}
        onCreate={createTab}
        onReorder={reorderTabs}
        onOpenSettings={openSettingsTab}
      />

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
