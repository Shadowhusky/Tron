import { useState, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LayoutProvider, useLayout } from "./contexts/LayoutContext";
import type { LayoutNode } from "./types";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { HistoryProvider } from "./contexts/HistoryContext";
import { AgentProvider } from "./contexts/AgentContext";
import OnboardingWizard from "./features/onboarding/components/OnboardingWizard";
import SplitPane from "./components/layout/SplitPane";
import TabBar from "./components/layout/TabBar";
import { STORAGE_KEYS } from "./constants/storage";
import { getTheme } from "./utils/theme";
import { aiService } from "./services/ai";
import { fadeIn, fadeScale } from "./utils/motion";

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
    isHydrated,
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === ",") {
        e.preventDefault();
        openSettingsTab();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openSettingsTab]);

  // Check if any session in a tab's tree is dirty
  const isTabDirty = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return false;
      const check = (node: LayoutNode): boolean => {
        if (node.type === "leaf") {
          if (node.contentType === "settings") return false;
          return sessions.get(node.sessionId)?.dirty ?? false;
        }
        return node.children.some(check);
      };
      return check(tab.root);
    },
    [tabs, sessions],
  );

  // Prevent initial flash/blink by waiting for hydration
  if (!isHydrated) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className={`flex flex-col h-screen w-full overflow-hidden ${getTheme(resolvedTheme).appBg}`}
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
        isTabDirty={isTabDirty}
      />

      {/* Main Workspace — all tabs stay mounted to preserve terminal state */}
      <div className="flex-1 relative overflow-hidden">
        {tabs.length > 0 ? (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{
                visibility: tab.id === activeTabId ? "visible" : "hidden",
                zIndex: tab.id === activeTabId ? 1 : 0,
              }}
            >
              <SplitPane node={tab.root} />
            </div>
          ))
        ) : (
          <AnimatePresence>
            <motion.div
              key="empty"
              variants={fadeScale}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="flex items-center justify-center h-full text-gray-500 flex-col gap-4"
            >
              <div className="text-xl font-medium">No Open Tabs</div>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={createTab}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors shadow-lg shadow-purple-900/20"
              >
                Create New Terminal
              </motion.button>
              <div className="text-xs opacity-50">
                Press Cmd+T to open a new tab
              </div>
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      <AnimatePresence>
        {showOnboarding && (
          <motion.div
            key="onboarding"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <OnboardingWizard onComplete={handleOnboardingComplete} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
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
