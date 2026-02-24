import { useState, useEffect, useCallback, useLayoutEffect } from "react";
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
import { useInvalidateModels } from "./hooks/useModels";
import CloseConfirmModal from "./components/layout/CloseConfirmModal";
import NotificationOverlay from "./components/layout/NotificationOverlay";
import SSHConnectModal from "./features/ssh/components/SSHConnectModal";
import SavedTabsModal from "./components/layout/SavedTabsModal";
import { isSshOnly } from "./services/mode";
import { isTouchDevice } from "./utils/platform";

/**
 * On mobile, the virtual keyboard shrinks the visible area but the browser
 * viewport (100vh/100dvh) doesn't always update. We use the visualViewport
 * API to set a CSS custom property --app-height that tracks the real visible
 * height, keeping the input/toolbar above the keyboard.
 */
function useVisualViewportHeight() {
  useLayoutEffect(() => {
    if (!isTouchDevice()) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const h = vv.height;
      document.documentElement.style.setProperty("--app-height", `${h}px`);
      // On iOS the page may scroll behind the keyboard — pin it back
      window.scrollTo(0, 0);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);
}

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
    saveTab,
    loadSavedTab,
    deleteSavedTab,
  } = useLayout();
  const { resolvedTheme } = useTheme();
  const { crossTabNotifications, dismissNotification, setActiveSessionForNotifications, duplicateAgentSession, getSessionPersistable, restoreAgentSession } = useAgentContext();
  const invalidateModels = useInvalidateModels();
  useVisualViewportHeight();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [showSSHModal, setShowSSHModal] = useState(false);
  const [showSavedTabs, setShowSavedTabs] = useState(false);
  const [savedTabCloseConfirm, setSavedTabCloseConfirm] = useState<{ tabId: string; savedTabId: string } | null>(null);
  const [sshToast, setSshToast] = useState("");

  useEffect(() => {
    // Allow embedding pages to skip onboarding via URL param
    const params = new URLSearchParams(window.location.search);
    if (params.get("skip-setup") === "true") {
      localStorage.setItem(STORAGE_KEYS.CONFIGURED, "true");
      localStorage.setItem(STORAGE_KEYS.TUTORIAL_COMPLETED, "true");
      return;
    }

    const hasConfigured = localStorage.getItem(STORAGE_KEYS.CONFIGURED);
    if (!hasConfigured) {
      setShowOnboarding(true);
      // Clear server-side SSH profiles so fresh setup starts clean
      window.electron?.ipcRenderer?.invoke?.("ssh.profiles.write", [])?.catch?.(() => {});
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
    // Refresh model list so ContextBar picks up the newly configured models
    invalidateModels();
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
    if (isSshOnly()) {
      // In SSH-only mode, agent needs an SSH session first — open the connect modal
      setShowSSHModal(true);
      setSshToast("Connect to a server first, then try the agent.");
      setTimeout(() => setSshToast(""), 4000);
      return;
    }
    // Dispatch event that the active TerminalPane can listen for
    window.dispatchEvent(
      new CustomEvent("tutorial-run-agent", { detail: { prompt } }),
    );
  };

  // Listen for SSH modal open requests (from Settings, LayoutContext, etc.)
  useEffect(() => {
    const handler = () => setShowSSHModal(true);
    window.addEventListener("tron:open-ssh-modal", handler);
    return () => window.removeEventListener("tron:open-ssh-modal", handler);
  }, []);

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

  const handleSaveTab = useCallback(
    async (tabId: string) => {
      await saveTab(tabId, getSessionPersistable);
      setSshToast("Tab saved");
      setTimeout(() => setSshToast(""), 3000);
    },
    [saveTab, getSessionPersistable]
  );

  /** Intercept tab close: if the tab was loaded from saved tabs, prompt the user. */
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find(t => t.id === tabId);
      if (tab?.savedTabId) {
        setSavedTabCloseConfirm({ tabId, savedTabId: tab.savedTabId });
        return;
      }
      closeTab(tabId);
    },
    [tabs, closeTab],
  );

  const handleSavedTabCloseAction = useCallback(
    async (action: "close" | "remove" | "cancel") => {
      if (!savedTabCloseConfirm) return;
      const { tabId, savedTabId } = savedTabCloseConfirm;
      setSavedTabCloseConfirm(null);
      if (action === "cancel") return;
      closeTab(tabId);
      if (action === "remove") {
        await deleteSavedTab(savedTabId);
      }
    },
    [savedTabCloseConfirm, closeTab, deleteSavedTab],
  );

  const handleLoadSavedTab = useCallback(
    async (saved: any) => {
      await loadSavedTab(saved, restoreAgentSession);
      setShowSavedTabs(false);
    },
    [loadSavedTab, restoreAgentSession]
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
      className={`flex flex-col h-full w-full overflow-hidden ${getTheme(resolvedTheme).appBg}`}
    >
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        resolvedTheme={resolvedTheme}
        onSelect={selectTab}
        onClose={handleCloseTab}
        onCreate={createTab}
        onCreateSSH={() => setShowSSHModal(true)}
        onReorder={reorderTabs}
        onOpenSettings={openSettingsTab}
        isTabDirty={isTabDirty}
        onRenameTab={renameTab}
        onUpdateTabColor={updateTabColor}
        onDuplicateTab={handleDuplicateTab}
        onSaveTab={handleSaveTab}
        onLoadSavedTab={() => setShowSavedTabs(true)}
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
        show={showSSHModal && !showOnboarding}
        resolvedTheme={resolvedTheme}
        onConnect={async (config) => {
          await createSSHTab(config);
          setShowSSHModal(false);
          window.dispatchEvent(new CustomEvent("tron:ssh-profiles-changed"));
        }}
        onClose={() => setShowSSHModal(false)}
        preventClose={false}
      />

      <SavedTabsModal
        show={showSavedTabs}
        resolvedTheme={resolvedTheme}
        onLoad={handleLoadSavedTab}
        onClose={() => setShowSavedTabs(false)}
      />

      {/* Saved tab close confirmation */}
      <AnimatePresence>
        {savedTabCloseConfirm && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => handleSavedTabCloseAction("cancel")}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className={`relative w-full max-w-sm mx-4 rounded-lg shadow-2xl overflow-hidden ${
                resolvedTheme === "light"
                  ? "bg-white border border-gray-200"
                  : resolvedTheme === "modern"
                    ? "bg-[#12121a]/95 backdrop-blur-2xl border border-white/[0.08]"
                    : "bg-[#141414] border border-white/[0.06]"
              }`}
            >
              <div className="px-5 pt-5 pb-3">
                <h3 className={`text-sm font-semibold mb-1.5 ${
                  resolvedTheme === "light" ? "text-gray-800" : "text-gray-200"
                }`}>
                  Close saved tab?
                </h3>
                <p className={`text-[13px] leading-relaxed ${
                  resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"
                }`}>
                  This tab was loaded from your saved tabs. Would you like to keep it saved for later, or remove it everywhere?
                </p>
              </div>
              <div className={`flex gap-2 px-5 py-3 border-t ${
                resolvedTheme === "light" ? "border-gray-100" : "border-white/5"
              }`}>
                <button
                  onClick={() => handleSavedTabCloseAction("cancel")}
                  className={`flex-1 px-3 py-1.5 rounded text-[13px] font-medium transition-colors ${
                    resolvedTheme === "light"
                      ? "hover:bg-gray-100 text-gray-600"
                      : "hover:bg-white/10 text-gray-400"
                  }`}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleSavedTabCloseAction("close")}
                  className={`flex-1 px-3 py-1.5 rounded text-[13px] font-medium transition-colors ${
                    resolvedTheme === "light"
                      ? "bg-gray-100 hover:bg-gray-200 text-gray-700"
                      : "bg-white/[0.06] hover:bg-white/[0.12] text-gray-300"
                  }`}
                >
                  Close tab
                </button>
                <button
                  onClick={() => handleSavedTabCloseAction("remove")}
                  className={`flex-1 px-3 py-1.5 rounded text-[13px] font-medium transition-colors ${
                    resolvedTheme === "light"
                      ? "bg-red-50 hover:bg-red-100 text-red-600"
                      : "bg-red-500/10 hover:bg-red-500/20 text-red-400"
                  }`}
                >
                  Remove from saved
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SSH-only toast */}
      <AnimatePresence>
        {sshToast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className={`fixed bottom-14 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-lg text-xs font-medium shadow-lg backdrop-blur-md ${
              resolvedTheme === "light"
                ? "bg-white/95 text-gray-700 border border-gray-200"
                : "bg-gray-800/95 text-gray-200 border border-gray-600"
            }`}
          >
            {sshToast}
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
