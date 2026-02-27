import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LayoutProvider, useLayout } from "./contexts/LayoutContext";
import type { LayoutNode } from "./types";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { HistoryProvider } from "./contexts/HistoryContext";
import { AgentProvider, useAgentContext } from "./contexts/AgentContext";
import { ConfigProvider, useConfig } from "./contexts/ConfigContext";
import OnboardingWizard from "./features/onboarding/components/OnboardingWizard";
import TutorialOverlay from "./features/onboarding/components/TutorialOverlay";
import SplitPane from "./components/layout/SplitPane";
import TabBar from "./components/layout/TabBar";
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
import Modal from "./components/ui/Modal";
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

    let lastH = 0;
    let raf = 0;
    const update = () => {
      // Coalesce rapid events (keyboard animation fires per-pixel) into a
      // single rAF to avoid CSS custom-property churn and forced scrollTo.
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const h = vv.height;
        // Skip no-op updates (same height)
        if (h === lastH) return;
        lastH = h;
        document.documentElement.style.setProperty("--app-height", `${h}px`);
        // On iOS the page may scroll behind the keyboard — pin it back
        window.scrollTo(0, 0);
      });
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      if (raf) cancelAnimationFrame(raf);
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
    setConfirmHandler,
  } = useLayout();
  const { resolvedTheme } = useTheme();
  const { config, updateConfig, isLoaded: configLoaded } = useConfig();
  const { crossTabNotifications, dismissNotification, setActiveSessionForNotifications, getSessionPersistable, restoreAgentSession } = useAgentContext();
  const invalidateModels = useInvalidateModels();
  useVisualViewportHeight();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [showSSHModal, setShowSSHModal] = useState(false);
  const [showSavedTabs, setShowSavedTabs] = useState(false);
  const [sshToast, setSshToast] = useState("");
  const [updateReady, setUpdateReady] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateVersion, setUpdateVersion] = useState("");

  // Generic confirm modal — replaces window.confirm for styled modals
  const [confirmModal, setConfirmModal] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);
  const confirmHandler = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => setConfirmModal({ message, resolve }));
  }, []);
  useEffect(() => { setConfirmHandler(confirmHandler); }, [setConfirmHandler, confirmHandler]);

  useEffect(() => {
    if (!configLoaded) return; // Wait for file-based config before deciding

    // Allow embedding pages to skip onboarding via URL param
    const params = new URLSearchParams(window.location.search);
    if (params.get("skip-setup") === "true") {
      updateConfig({ configured: true, tutorialCompleted: true });
      return;
    }

    if (!config.configured) {
      setShowOnboarding(true);
      // Clear server-side SSH profiles so fresh setup starts clean
      window.electron?.ipcRenderer?.invoke?.("ssh.profiles.write", [])?.catch?.(() => { });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded]);

  const handleOnboardingComplete = () => {
    updateConfig({ configured: true });
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
    if (!config.tutorialCompleted) {
      setShowTutorial(true);
    }
  };

  const handleTutorialComplete = () => {
    updateConfig({ tutorialCompleted: true });
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

  // Listen for auto-updater status changes
  useEffect(() => {
    if (!window.electron?.ipcRenderer?.on) return;
    const cleanup = window.electron.ipcRenderer.on(
      IPC.UPDATER_STATUS,
      (data: any) => {
        if (data.updateInfo?.version) {
          if (data.status === "downloaded") {
            setUpdateVersion(data.updateInfo.version);
            setUpdateReady(true);
          } else if (data.status === "available") {
            // Surface "available" for users with auto-download off
            setUpdateVersion(data.updateInfo.version);
            setUpdateAvailable(true);
          }
        }
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
      await duplicateTab(tabId);
    },
    [duplicateTab]
  );

  const handleSaveTab = useCallback(
    async (tabId: string) => {
      await saveTab(tabId, getSessionPersistable);
      setSshToast("Tab saved");
      setTimeout(() => setSshToast(""), 3000);
    },
    [saveTab, getSessionPersistable]
  );

  const handleCloseTab = useCallback(
    (tabId: string) => closeTab(tabId),
    [closeTab],
  );

  const loadingSavedRef = useRef(false);
  const handleLoadSavedTab = useCallback(
    async (saved: any) => {
      if (loadingSavedRef.current) return;
      loadingSavedRef.current = true;
      try {
        await loadSavedTab(saved, restoreAgentSession);
        setShowSavedTabs(false);
      } finally {
        loadingSavedRef.current = false;
      }
    },
    [loadSavedTab, restoreAgentSession]
  );

  // Remove loading indicator once hydrated (covers both Electron and web mode)
  useEffect(() => {
    if (!isHydrated) return;
    const loader = document.getElementById("tron-loader");
    if (loader) {
      loader.classList.add("fade-out");
      setTimeout(() => loader.remove(), 300);
    }
  }, [isHydrated]);

  // Prevent initial flash/blink by waiting for hydration
  if (!isHydrated) return null;

  // Collect ALL session IDs in the active tab's layout tree for notification filtering.
  // This covers split panes — the agent may be running in a non-focused pane.
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeTabSessionIds = new Set<string>();
  if (activeTab) {
    const collect = (node: LayoutNode): void => {
      if (node.type === "leaf") { activeTabSessionIds.add(node.sessionId); return; }
      node.children.forEach(collect);
    };
    collect(activeTab.root);
  }
  setActiveSessionForNotifications(activeTabSessionIds);

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
        onConfirmClose={confirmHandler}
        onRenameTab={renameTab}
        onUpdateTabColor={updateTabColor}
        onDuplicateTab={handleDuplicateTab}
        onSaveTab={handleSaveTab}
        onLoadSavedTab={() => setShowSavedTabs(true)}
      />

      {/* Main Workspace — all tabs stay mounted to preserve terminal state */}
      <div className="flex-1 relative overflow-hidden">
        {/* Cross-tab agent notifications — filter out ALL sessions in the active tab
            to avoid toasts for the tab the user is currently looking at */}
        <NotificationOverlay
          notifications={crossTabNotifications.filter(n => !activeTabSessionIds.has(n.sessionId))}
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

      {/* Generic confirm modal (replaces window.confirm for tab close etc.) */}
      <Modal
        show={!!confirmModal}
        resolvedTheme={resolvedTheme}
        onClose={() => { confirmModal?.resolve(false); setConfirmModal(null); }}
        title={confirmModal?.message ?? ""}
        buttons={[
          { label: "Cancel", type: "ghost", onClick: () => { confirmModal?.resolve(false); setConfirmModal(null); } },
          { label: "Confirm", type: "primary", onClick: () => { confirmModal?.resolve(true); setConfirmModal(null); } },
        ]}
      />

      {/* Update ready modal */}
      <Modal
        show={updateReady}
        resolvedTheme={resolvedTheme}
        onClose={() => setUpdateReady(false)}
        title="Update Ready"
        description={`A new version (v${updateVersion}) has been downloaded and is ready to install.`}
        buttons={[
          { label: "Later", type: "ghost", onClick: () => setUpdateReady(false) },
          { label: "Relaunch Now", type: "primary", onClick: () => window.electron?.ipcRenderer?.quitAndInstall?.() },
        ]}
      />

      {/* Update available modal (when auto-download is off) */}
      <Modal
        show={updateAvailable && !updateReady}
        resolvedTheme={resolvedTheme}
        onClose={() => setUpdateAvailable(false)}
        title="Update Available"
        description={`A new version (v${updateVersion}) is available. Go to Settings to download it.`}
        buttons={[
          { label: "Later", type: "ghost", onClick: () => setUpdateAvailable(false) },
          { label: "Download", type: "primary", onClick: () => {
            setUpdateAvailable(false);
            window.electron?.ipcRenderer?.downloadUpdate?.();
          }},
        ]}
      />

      {/* SSH-only toast */}
      <AnimatePresence>
        {sshToast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className={`fixed bottom-14 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-lg text-xs font-medium shadow-lg backdrop-blur-md ${resolvedTheme === "light"
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
    <ConfigProvider>
      <ThemeProvider>
        <HistoryProvider>
          <AgentProvider>
            <LayoutProvider>
              <AppContent />
            </LayoutProvider>
          </AgentProvider>
        </HistoryProvider>
      </ThemeProvider>
    </ConfigProvider>
  );
};

export default App;
