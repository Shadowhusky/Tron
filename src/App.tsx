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
import RemoteConnectionModal from "./components/layout/RemoteConnectionModal";
import Modal from "./components/ui/Modal";
import * as Popover from "@radix-ui/react-popover";
import { isSshOnly } from "./services/mode";
import { isTouchDevice } from "./utils/platform";
import { ExternalLink, PanelRight, FileText, FolderOpen, Copy, Eye } from "lucide-react";
import AgentStatusBar from "./pixel-agents/components/AgentStatusBar";

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
      // single rAF to avoid CSS custom-property churn.
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const h = vv.height;
        if (h !== lastH) {
          lastH = h;
          document.documentElement.style.setProperty("--app-height", `${h}px`);
        }
        // Always pin scroll to 0,0 — the browser may scroll the page to keep
        // the focused input visible when the keyboard opens. This must run
        // even when height hasn't changed (scroll-only events).
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0);
        }
      });
    };

    // Also listen for window scroll events — catches focus-triggered scrolls
    // that happen outside of visualViewport resize/scroll events.
    const pinScroll = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("scroll", pinScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("scroll", pinScroll);
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
    openBrowserTab,
    openEditorTab,
    createRemoteTab,
    reorderTabs,
    updateSessionConfig,
    discardPersistedLayout,
    isHydrated,
    renameTab,
    lockTabTitle,
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
  const [showRemoteModal, setShowRemoteModal] = useState(false);
  const [sshToast, setSshToast] = useState("");
  const [updateReady, setUpdateReady] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [installStep, setInstallStep] = useState("");
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ percent: number; bytesPerSecond: number; transferred: number; total: number } | null>(null);
  const [updateVersion, setUpdateVersion] = useState("");
  const [updateNotes, setUpdateNotes] = useState("");
  const [linkPopover, setLinkPopover] = useState<{ url: string; x: number; y: number } | null>(null);
  const linkAnchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: 0, y: 0 }),
  });
  if (linkPopover) {
    linkAnchorRef.current = {
      getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: linkPopover.x, y: linkPopover.y }),
    };
  }
  const [filePopover, setFilePopover] = useState<{ filePath: string; displayPath: string; x: number; y: number; isDirectory: boolean; isFile: boolean; canEdit: boolean; sourceSessionId: string } | null>(null);
  const fileAnchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: 0, y: 0 }),
  });
  if (filePopover) {
    fileAnchorRef.current = {
      getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, x: filePopover.x, y: filePopover.y }),
    };
  }
  const updateDismissedRef = useRef(false);
  const closingRef = useRef(false);

  // Generic confirm modal — replaces window.confirm for styled modals
  const [confirmModal, setConfirmModal] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);
  const confirmHandler = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => setConfirmModal({ message, resolve }));
  }, []);
  useEffect(() => { setConfirmHandler(confirmHandler); }, [setConfirmHandler, confirmHandler]);

  // Warn before page refresh (Cmd+R) if there are dirty terminal sessions.
  // Only blocks accidental refresh — not app quit (Cmd+Q / dock quit set closingRef).
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      // Skip if user already confirmed close via the modal or auto-close path
      if (closingRef.current) return;
      // Only block if there are sessions the user has actually interacted with
      const hasDirtySessions = Array.from(sessionsRef.current.entries()).some(
        ([id, session]) => !id.startsWith("settings") && !id.startsWith("browser-") && !id.startsWith("editor-") && !id.startsWith("ssh-connect") && !id.startsWith("pixel-agents") && session.dirty,
      );
      if (hasDirtySessions) {
        e.preventDefault();
        e.returnValue = "You have active terminal sessions. Are you sure you want to reload?";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

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

  // Listen for Remote modal open requests (from Settings)
  useEffect(() => {
    const handler = () => setShowRemoteModal(true);
    window.addEventListener("tron:open-remote-modal", handler);
    return () => window.removeEventListener("tron:open-remote-modal", handler);
  }, []);

  // Listen for window close confirmation from Electron main process.
  // Only show the close modal if there are active terminal sessions worth saving.
  // If the user just opened the app and hasn't done anything, close immediately.
  useEffect(() => {
    if (!window.electron?.ipcRenderer?.on) return;
    const cleanup = window.electron.ipcRenderer.on(
      IPC.WINDOW_CONFIRM_CLOSE,
      () => {
        const hasDirtySessions = Array.from(sessionsRef.current.entries()).some(
          ([id, session]) => !id.startsWith("settings") && !id.startsWith("browser-") && !id.startsWith("editor-") && !id.startsWith("ssh-connect") && !id.startsWith("pixel-agents") && session.dirty,
        );
        if (hasDirtySessions) {
          setShowCloseConfirm(true);
        } else {
          // No sessions worth saving — close immediately
          closingRef.current = true;
          window.electron?.ipcRenderer?.send(IPC.WINDOW_CLOSE_CONFIRMED, {});
        }
      },
    );
    return cleanup;
  }, []);

  // Cmd+Q / dock quit → main process sends forceClose before the close event.
  // Set closingRef so beforeunload doesn't block.
  useEffect(() => {
    if (!window.electron?.ipcRenderer?.on) return;
    return window.electron.ipcRenderer.on("window.forceClose", () => {
      closingRef.current = true;
    });
  }, []);

  // Reset dismissed flag when user manually checks for updates (from Settings)
  useEffect(() => {
    const reset = () => { updateDismissedRef.current = false; };
    window.addEventListener("tron:manual-update-check", reset);
    return () => window.removeEventListener("tron:manual-update-check", reset);
  }, []);

  // Generic toast event listener (e.g. from terminal link validation)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.message) {
        setSshToast(detail.message);
        setTimeout(() => setSshToast(""), 4000);
      }
    };
    window.addEventListener("tron:toast", handler);
    return () => window.removeEventListener("tron:toast", handler);
  }, []);

  // Listen for link clicks — show popover at click position
  // Defer by one frame so the originating click finishes before Radix Popover
  // installs its pointer-down-outside listener (otherwise it closes immediately).
  useEffect(() => {
    const handler = (e: Event) => {
      const { url, x, y } = (e as CustomEvent).detail;
      if (!url) return;
      // file:// URLs — open directly in system file manager, skip popover
      if (url.startsWith("file://")) {
        const filePath = decodeURIComponent(url.replace(/^file:\/\//, ""));
        if (window.electron?.ipcRenderer) {
          window.electron.ipcRenderer.invoke("shell.showItemInFolder", filePath)?.catch(() => {
            window.electron?.ipcRenderer?.invoke("shell.openPath", filePath)?.catch(() => {});
          });
        }
        return;
      }
      requestAnimationFrame(() => setLinkPopover({ url, x: x ?? 0, y: y ?? 0 }));
    };
    window.addEventListener("tron:linkClicked", handler);
    return () => window.removeEventListener("tron:linkClicked", handler);
  }, []);

  // Listen for file path clicks — show file popover at click position
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath) return;
      requestAnimationFrame(() => setFilePopover(detail));
    };
    window.addEventListener("tron:fileClicked", handler);
    return () => window.removeEventListener("tron:fileClicked", handler);
  }, []);

  // Open code editor tab from file path clicks (agent overlay, etc.)
  useEffect(() => {
    const handler = (e: Event) => {
      const { filePath, sourceSessionId } = (e as CustomEvent).detail;
      if (filePath) openEditorTab(filePath, sourceSessionId);
    };
    window.addEventListener("tron:openEditorTab", handler);
    return () => window.removeEventListener("tron:openEditorTab", handler);
  }, [openEditorTab]);

  // Listen for auto-updater status changes
  useEffect(() => {
    if (!window.electron?.ipcRenderer?.on) return;
    const cleanup = window.electron.ipcRenderer.on(
      IPC.UPDATER_STATUS,
      (data: any) => {
        if (data.status === "installing") {
          setUpdateInstalling(true);
          setUpdateDownloading(false);
          setUpdateAvailable(false);
          if (data.installStep) setInstallStep(data.installStep);
        } else if (data.status === "downloading") {
          setUpdateDownloading(true);
          setUpdateAvailable(false);
          if (data.downloadProgress) setDownloadProgress(data.downloadProgress);
        } else if (data.status === "error") {
          setUpdateDownloading(false);
          setDownloadProgress(null);
        } else if (data.updateInfo?.version && !updateDismissedRef.current) {
          if (data.status === "downloaded") {
            setUpdateVersion(data.updateInfo.version);
            setUpdateNotes(data.updateInfo.releaseNotes || "");
            setUpdateAvailable(false);
            setUpdateDownloading(false);
            setDownloadProgress(null);
            setUpdateReady(true);
          } else if (data.status === "available") {
            setUpdateVersion(data.updateInfo.version);
            setUpdateNotes(data.updateInfo.releaseNotes || "");
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
    // Disable beforeunload guard so the close actually goes through.
    // For "save", sessions are still in state and beforeunload would block.
    closingRef.current = true;
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
        onRenameTab={(sid, title) => { renameTab(sid, title, { force: true }); lockTabTitle(sid); }}
        onUpdateTabColor={updateTabColor}
        onDuplicateTab={handleDuplicateTab}
        onSaveTab={handleSaveTab}
        onLoadSavedTab={() => setShowSavedTabs(true)}
        onCreateRemote={() => setShowRemoteModal(true)}
        onCreateBrowser={() => openBrowserTab("https://www.google.com", "Web")}
      />

      <AgentStatusBar />

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

      <RemoteConnectionModal
        show={showRemoteModal}
        resolvedTheme={resolvedTheme}
        onConnect={async (url) => {
          try {
            await createRemoteTab(url);
            setShowRemoteModal(false);
          } catch (err: any) {
            // Error is shown in the modal
            throw err;
          }
        }}
        onClose={() => setShowRemoteModal(false)}
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
        onClose={updateInstalling ? () => {} : () => { updateDismissedRef.current = true; setUpdateReady(false); }}
        title={updateInstalling ? "Installing Update" : "Update Ready"}
        description={updateInstalling ? undefined : `A new version (v${updateVersion}) has been downloaded and is ready to install.`}
        buttons={updateInstalling ? [] : [
          { label: "Later", type: "ghost", onClick: () => { updateDismissedRef.current = true; setUpdateReady(false); } },
          { label: "Relaunch Now", type: "primary", onClick: () => window.electron?.ipcRenderer?.quitAndInstall?.() },
        ]}
      >
        {updateInstalling ? (
          <div className="px-4 pb-4">
            <p className={`text-sm mb-3 ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
              {installStep || "Preparing..."}
            </p>
            <div className={`w-full h-1.5 rounded-full overflow-hidden ${resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"}`}>
              <div
                className="h-full rounded-full bg-purple-500 animate-[indeterminate_1.5s_ease-in-out_infinite]"
                style={{ width: "40%" }}
              />
            </div>
            <p className={`text-[11px] mt-2 ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`}>
              The app will restart automatically when done.
            </p>
          </div>
        ) : updateNotes ? (
          <div className={`px-4 pb-3 text-[11px] leading-relaxed max-h-40 overflow-y-auto ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
            <div dangerouslySetInnerHTML={{ __html: updateNotes }} />
          </div>
        ) : null}
      </Modal>

      {/* Downloading update modal with progress bar */}
      <Modal
        show={updateDownloading && !updateReady}
        resolvedTheme={resolvedTheme}
        onClose={() => {}}
        title="Downloading Update"
        buttons={[]}
      >
        <div className="px-1 py-2">
          <p className={`text-sm mb-3 ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
            Downloading v{updateVersion}...{" "}
            {downloadProgress ? `${Math.round(downloadProgress.percent)}%` : ""}
          </p>
          <div className={`w-full h-2 rounded-full overflow-hidden ${resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"}`}>
            <div
              className="h-full rounded-full bg-purple-500 transition-all duration-300"
              style={{ width: `${downloadProgress?.percent ?? 0}%` }}
            />
          </div>
          {downloadProgress && downloadProgress.total > 0 && (
            <p className={`text-[11px] mt-2 ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`}>
              {(downloadProgress.transferred / 1024 / 1024).toFixed(1)} / {(downloadProgress.total / 1024 / 1024).toFixed(1)} MB
              {downloadProgress.bytesPerSecond > 0 && ` — ${(downloadProgress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`}
            </p>
          )}
        </div>
      </Modal>

      {/* Update available modal (when auto-download is off) */}
      <Modal
        show={updateAvailable && !updateReady && !updateDownloading}
        resolvedTheme={resolvedTheme}
        onClose={() => { updateDismissedRef.current = true; setUpdateAvailable(false); }}
        title="Update Available"
        description={`A new version (v${updateVersion}) is available.`}
        buttons={[
          { label: "Later", type: "ghost", onClick: () => { updateDismissedRef.current = true; setUpdateAvailable(false); } },
          { label: "Download", type: "primary", onClick: () => {
            setUpdateAvailable(false);
            setUpdateDownloading(true);
            window.electron?.ipcRenderer?.downloadUpdate?.();
          }},
        ]}
      >
        {updateNotes && (
          <div className={`px-4 pb-3 text-[11px] leading-relaxed max-h-40 overflow-y-auto ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
            <div dangerouslySetInnerHTML={{ __html: updateNotes }} />
          </div>
        )}
      </Modal>

      {/* Link click popover — context-menu style at click position */}
      <Popover.Root
        open={!!linkPopover}
        onOpenChange={(open) => { if (!open) setLinkPopover(null); }}
      >
        <Popover.Anchor virtualRef={linkAnchorRef as any} />
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className={`z-[200] min-w-[180px] max-w-[320px] overflow-hidden rounded-lg py-1 shadow-xl ${
              resolvedTheme === "light"
                ? "border border-gray-200 bg-white text-gray-800 shadow-xl"
                : resolvedTheme === "modern"
                  ? "border border-white/[0.15] bg-[#1a1a3e]/95 text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
                  : "border border-white/10 bg-[#1e1e1e] text-gray-200"
            }`}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {/* URL preview */}
            <div className={`px-3 py-1.5 text-[11px] truncate ${
              resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"
            }`}>
              {linkPopover?.url}
            </div>
            <div className={`my-0.5 h-px ${resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"}`} />
            <button
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                resolvedTheme === "light" ? "cursor-pointer hover:bg-gray-100" : "cursor-pointer hover:bg-white/10"
              }`}
              onClick={() => {
                if (linkPopover) {
                  if (window.electron?.ipcRenderer) {
                    window.electron.ipcRenderer.invoke("shell.openExternal", linkPopover.url)?.catch(() => {});
                  } else {
                    window.open(linkPopover.url, "_blank", "noopener,noreferrer");
                  }
                }
                setLinkPopover(null);
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Browser
            </button>
            <button
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                resolvedTheme === "light" ? "cursor-pointer hover:bg-gray-100" : "cursor-pointer hover:bg-white/10"
              }`}
              onClick={() => {
                if (linkPopover) openBrowserTab(linkPopover.url);
                setLinkPopover(null);
              }}
            >
              <PanelRight className="h-3.5 w-3.5" />
              Open in Tab
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {/* File path click popover — context-menu style at click position */}
      <Popover.Root
        open={!!filePopover}
        onOpenChange={(open) => { if (!open) setFilePopover(null); }}
      >
        <Popover.Anchor virtualRef={fileAnchorRef as any} />
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className={`z-[200] min-w-[180px] max-w-[320px] overflow-hidden rounded-lg py-1 shadow-xl ${
              resolvedTheme === "light"
                ? "border border-gray-200 bg-white text-gray-800 shadow-xl"
                : resolvedTheme === "modern"
                  ? "border border-white/[0.15] bg-[#1a1a3e]/95 text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
                  : "border border-white/10 bg-[#1e1e1e] text-gray-200"
            }`}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {/* Path preview */}
            <div className={`px-3 py-1.5 text-[11px] truncate ${
              resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"
            }`}>
              {filePopover?.displayPath}
            </div>
            <div className={`my-0.5 h-px ${resolvedTheme === "light" ? "bg-gray-200" : "bg-white/10"}`} />
            {/* Open in Editor — only for editable files */}
            {filePopover?.canEdit && filePopover?.isFile && (
              <button
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                  resolvedTheme === "light" ? "cursor-pointer hover:bg-gray-100" : "cursor-pointer hover:bg-white/10"
                }`}
                onClick={() => {
                  if (filePopover) {
                    window.dispatchEvent(new CustomEvent("tron:openEditorTab", {
                      detail: { filePath: filePopover.filePath, sourceSessionId: filePopover.sourceSessionId },
                    }));
                  }
                  setFilePopover(null);
                }}
              >
                <FileText className="h-3.5 w-3.5" />
                Open in Editor
              </button>
            )}
            {/* Open Folder / Reveal in Finder */}
            <button
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                resolvedTheme === "light" ? "cursor-pointer hover:bg-gray-100" : "cursor-pointer hover:bg-white/10"
              }`}
              onClick={() => {
                if (filePopover) {
                  if (filePopover.isDirectory) {
                    window.electron?.ipcRenderer?.invoke("shell.openPath", filePopover.filePath)?.catch(() => {});
                  } else {
                    window.electron?.ipcRenderer?.invoke("shell.showItemInFolder", filePopover.filePath)?.catch(() => {
                      window.electron?.ipcRenderer?.invoke("shell.openPath", filePopover.filePath)?.catch(() => {});
                    });
                  }
                }
                setFilePopover(null);
              }}
            >
              {filePopover?.isDirectory ? <FolderOpen className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {filePopover?.isDirectory ? "Open Folder" : "Reveal in Finder"}
            </button>
            {/* Copy path */}
            <button
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                resolvedTheme === "light" ? "cursor-pointer hover:bg-gray-100" : "cursor-pointer hover:bg-white/10"
              }`}
              onClick={() => {
                if (filePopover) {
                  navigator.clipboard.writeText(filePopover.filePath).catch(() => {});
                }
                setFilePopover(null);
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy Path
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

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
