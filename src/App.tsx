import { useState, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LayoutProvider, useLayout } from "./contexts/LayoutContext";
import type { LayoutNode } from "./types";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { HistoryProvider } from "./contexts/HistoryContext";
import { AgentProvider, useAgentContext } from "./contexts/AgentContext";
import { ConfigProvider } from "./contexts/ConfigContext";
import OnboardingWizard from "./features/onboarding/components/OnboardingWizard";
import TutorialOverlay from "./features/onboarding/components/TutorialOverlay";
import SplitPane from "./components/layout/SplitPane";
import TabBar from "./components/layout/TabBar";
import { STORAGE_KEYS } from "./constants/storage";
import { IPC } from "./constants/ipc";
import { getTheme } from "./utils/theme";
import { aiService } from "./services/ai";
import { fadeIn, fadeScale, overlay } from "./utils/motion";
import { useHotkey } from "./hooks/useHotkey";

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
    discardPersistedLayout,
    isHydrated,
  } = useLayout();
  const { resolvedTheme } = useTheme();
  const { crossTabNotifications, dismissNotification, setActiveSessionForNotifications } = useAgentContext();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
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
    // Show tutorial if not previously completed
    const tutorialDone = localStorage.getItem(STORAGE_KEYS.TUTORIAL_COMPLETED);
    if (!tutorialDone) {
      setShowTutorial(true);
    }
  };

  const handleTutorialComplete = () => {
    localStorage.setItem(STORAGE_KEYS.TUTORIAL_COMPLETED, "true");
    setShowTutorial(false);
  };

  const handleTutorialTestRun = (prompt: string) => {
    // Dispatch event that the active TerminalPane can listen for
    window.dispatchEvent(
      new CustomEvent("tutorial-run-agent", { detail: { prompt } }),
    );
  };

  // Listen for window close confirmation from Electron main process
  useEffect(() => {
    if (!window.electron?.ipcRenderer?.on) return;
    const cleanup = window.electron.ipcRenderer.on(
      IPC.WINDOW_CONFIRM_CLOSE,
      () => {
        setShowCloseConfirm(true);
      },
    );
    return cleanup;
  }, []);

  const handleCloseConfirm = async (action: "save" | "discard" | "cancel") => {
    setShowCloseConfirm(false);
    if (action === "cancel") {
      window.electron?.ipcRenderer?.send(IPC.WINDOW_CLOSE_CANCELLED, {});
      return;
    }
    if (action === "discard") {
      // Clear localStorage + flush to disk before closing window
      await discardPersistedLayout();
    }
    window.electron?.ipcRenderer?.send(IPC.WINDOW_CLOSE_CONFIRMED, {});
  };

  // Global Shortcuts
  useHotkey("openSettings", openSettingsTab, [openSettingsTab]);

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

  // Sync active session ID for cross-tab notification filtering
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeSessionId = activeTab?.activeSessionId || null;
  // Using a ref sync via effect would be cleaner, but for simplicity:
  setActiveSessionForNotifications(activeSessionId);

  // Find session's tab for click-to-switch
  const findTabForSession = (sessionId: string): string | null => {
    for (const tab of tabs) {
      const check = (node: LayoutNode): boolean => {
        if (node.type === "leaf") return node.sessionId === sessionId;
        return node.children.some(check);
      };
      if (check(tab.root)) return tab.id;
    }
    return null;
  };

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
        {/* Cross-tab agent notifications */}
        {crossTabNotifications.length > 0 && (
          <div className="absolute top-2 right-3 z-50 flex flex-col gap-2" style={{ maxWidth: 340 }}>
            {crossTabNotifications.map((n) => {
              const targetTabId = findTabForSession(n.sessionId);
              const targetTab = targetTabId ? tabs.find(t => t.id === targetTabId) : null;
              return (
                <motion.div
                  key={n.id}
                  initial={{ opacity: 0, x: 40 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 40 }}
                  className={`rounded-lg px-3 py-2 text-xs shadow-lg cursor-pointer border backdrop-blur-md ${resolvedTheme === "light"
                      ? "bg-white/90 border-gray-200 text-gray-700"
                      : "bg-gray-800/90 border-gray-600 text-gray-200"
                    }`}
                  onClick={() => {
                    if (targetTabId) selectTab(targetTabId);
                    dismissNotification(n.id);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-green-400 text-[10px]">●</span>
                    <span className="font-medium truncate">
                      {targetTab?.title || "Background tab"}
                    </span>
                    <button
                      className="ml-auto text-gray-400 hover:text-gray-200 text-[10px]"
                      onClick={(e) => { e.stopPropagation(); dismissNotification(n.id); }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-0.5 truncate opacity-75">{n.message}</div>
                </motion.div>
              );
            })}
          </div>
        )}
        {tabs.map((tab) => (
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
        ))}
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
        {showTutorial && (
          <motion.div
            key="tutorial"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TutorialOverlay
              onComplete={handleTutorialComplete}
              onSkip={handleTutorialComplete}
              onTestRun={handleTutorialTestRun}
            />
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
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70"
            onClick={() => handleCloseConfirm("cancel")}
          >
            <motion.div
              variants={fadeScale}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
              className={`w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden
                ${resolvedTheme === "light" ? "bg-white text-gray-900 border border-gray-200" : ""}
                ${resolvedTheme === "dark" ? "bg-gray-900 text-white border border-white/10" : ""}
                ${resolvedTheme === "modern" ? "bg-[#111] text-white border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)]" : ""}
              `}
            >
              <div className="px-6 pt-3 pb-4 space-y-2">
                <h3 className="text-lg font-semibold">Close Tron?</h3>
                <p
                  className={`text-sm ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}
                >
                  You have active terminal sessions. What would you like to do?
                </p>
              </div>
              <div className={`px-6 pb-6 flex flex-row gap-3`}>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleCloseConfirm("save")}
                  className="flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-sm font-medium transition-colors shadow-lg shadow-purple-900/20 whitespace-nowrap"
                >
                  Exit & Save Session
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleCloseConfirm("discard")}
                  className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-colors border whitespace-nowrap ${resolvedTheme === "light"
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
                  className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap ${resolvedTheme === "light"
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
      <ConfigProvider>
        <HistoryProvider>
          <AgentProvider>
            <LayoutProvider>
              <AppContent />
            </LayoutProvider>
          </AgentProvider>
        </HistoryProvider>
      </ConfigProvider>
    </ThemeProvider>
  );
};

export default App;
