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
import { fadeIn } from "./utils/motion";
import { useHotkey } from "./hooks/useHotkey";
import CloseConfirmModal from "./components/layout/CloseConfirmModal";
import NotificationOverlay from "./components/layout/NotificationOverlay";
import SSHConnectModal from "./features/ssh/components/SSHConnectModal";

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
    renameTab,
    updateTabColor,
    duplicateTab,
    createSSHTab,
  } = useLayout();
  const { resolvedTheme } = useTheme();
  const { crossTabNotifications, dismissNotification, setActiveSessionForNotifications, duplicateAgentSession } = useAgentContext();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [showSSHModal, setShowSSHModal] = useState(false);

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

  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      await duplicateTab(tabId, duplicateAgentSession);
    },
    [duplicateTab, duplicateAgentSession]
  );

  // Prevent initial flash/blink by waiting for hydration
  if (!isHydrated) return null;

  // Sync active session ID for cross-tab notification filtering
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeSessionId = activeTab?.activeSessionId || null;
  setActiveSessionForNotifications(activeSessionId);

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
        onCreateSSH={() => setShowSSHModal(true)}
        onReorder={reorderTabs}
        onOpenSettings={openSettingsTab}
        isTabDirty={isTabDirty}
        onRenameTab={renameTab}
        onUpdateTabColor={updateTabColor}
        onDuplicateTab={handleDuplicateTab}
      />

      {/* Main Workspace — all tabs stay mounted to preserve terminal state */}
      <div className="flex-1 relative overflow-hidden">
        {/* Cross-tab agent notifications */}
        <NotificationOverlay
          notifications={crossTabNotifications}
          tabs={tabs}
          resolvedTheme={resolvedTheme}
          onSelectTab={selectTab}
          onDismiss={dismissNotification}
        />
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

      <CloseConfirmModal
        show={showCloseConfirm}
        resolvedTheme={resolvedTheme}
        onAction={handleCloseConfirm}
      />

      <SSHConnectModal
        show={showSSHModal}
        resolvedTheme={resolvedTheme}
        onConnect={async (config) => {
          await createSSHTab(config);
          setShowSSHModal(false);
        }}
        onClose={() => setShowSSHModal(false)}
      />
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
