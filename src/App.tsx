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
import { IPC } from "./constants/ipc";
import { getTheme } from "./utils/theme";
import { aiService } from "./services/ai";
import { fadeIn, fadeScale, overlay } from "./utils/motion";

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
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

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

  // Listen for window close confirmation from Electron main process
  useEffect(() => {
    if (!window.electron?.ipcRenderer?.on) return;
    const cleanup = window.electron.ipcRenderer.on(IPC.WINDOW_CONFIRM_CLOSE, () => {
      setShowCloseConfirm(true);
    });
    return cleanup;
  }, []);

  const handleCloseConfirm = (action: "save" | "discard" | "cancel") => {
    setShowCloseConfirm(false);
    if (action === "cancel") {
      window.electron?.ipcRenderer?.send(IPC.WINDOW_CLOSE_CANCELLED, {});
      return;
    }
    if (action === "discard") {
      localStorage.removeItem(STORAGE_KEYS.LAYOUT);
    }
    window.electron?.ipcRenderer?.send(IPC.WINDOW_CLOSE_CONFIRMED, {});
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

      <AnimatePresence>
        {showCloseConfirm && (
          <motion.div
            key="close-confirm"
            variants={overlay}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => handleCloseConfirm("cancel")}
          >
            <motion.div
              variants={fadeScale}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
              className={`w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden
                ${resolvedTheme === "light" ? "bg-white text-gray-900 border border-gray-200" : ""}
                ${resolvedTheme === "dark" ? "bg-gray-900 text-white border border-white/10" : ""}
                ${resolvedTheme === "modern" ? "bg-black/80 text-white border border-white/10 backdrop-blur-2xl shadow-[0_0_50px_rgba(0,0,0,0.5)]" : ""}
              `}
            >
              <div className="p-6 space-y-2">
                <h3 className="text-lg font-semibold">Close Tron?</h3>
                <p className={`text-sm ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
                  You have active terminal sessions. What would you like to do?
                </p>
              </div>
              <div className={`px-6 pb-6 flex flex-col gap-2`}>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleCloseConfirm("save")}
                  className="w-full px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-sm font-medium transition-colors shadow-lg shadow-purple-900/20"
                >
                  Exit & Save Session
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleCloseConfirm("discard")}
                  className={`w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-colors border ${
                    resolvedTheme === "light"
                      ? "border-gray-200 hover:bg-gray-50 text-gray-700"
                      : "border-white/10 hover:bg-white/5 text-gray-300"
                  }`}
                >
                  Exit Without Saving
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleCloseConfirm("cancel")}
                  className={`w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    resolvedTheme === "light"
                      ? "hover:bg-gray-100 text-gray-500"
                      : "hover:bg-white/5 text-gray-500"
                  }`}
                >
                  Cancel
                </motion.button>
              </div>
            </motion.div>
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
