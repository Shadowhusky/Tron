import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import type {
  LayoutNode,
  Tab,
  TerminalSession,
  SplitDirection,
  AIConfig,
  SSHConnectionConfig,
  SyncTab,
  AgentStep,
} from "../types";
import { aiService } from "../services/ai";
import { STORAGE_KEYS } from "../constants/storage";
import { IPC } from "../constants/ipc";
import { isSshOnly } from "../services/mode";
import { onServerReconnect } from "../services/ws-bridge";
import { matchesHotkey } from "../hooks/useHotkey";
import { selectTabByIndex } from "../utils/tabSwitcher";
import { useConfig } from "./ConfigContext";
import { isElectronApp } from "../utils/platform";
import { connectRemote, createRemotePTY, getRemoteConnectionId, reviveRemoteSession, unregisterRemoteSession } from "../services/remote-bridge";

// --- Mock UUID if crypto not avail in browser (though we use electron) ---
function uuid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface LayoutContextType {
  tabs: Tab[];
  activeTabId: string;
  sessions: Map<string, TerminalSession>;
  activeSessionId: string | null;
  createTab: () => Promise<void>;
  closeTab: (tabId: string) => void;
  selectTab: (tabId: string) => void;
  splitUserAction: (direction: SplitDirection) => Promise<void>;
  closeSession: (sessionId: string) => void;
  /** Remove a specific pane from the layout tree and kill its PTY session. */
  closePane: (sessionId: string) => void;
  updateSessionConfig: (sessionId: string, config: Partial<AIConfig>) => void;
  updateSession: (sessionId: string, updates: Partial<TerminalSession>) => void;
  addInteraction: (
    sessionId: string,
    interaction: { role: "user" | "agent"; content: string; timestamp: number },
  ) => void;
  clearInteractions: (sessionId: string) => void;
  markSessionDirty: (sessionId: string) => void;
  updateSplitSizes: (path: number[], sizes: number[]) => void;
  openSettingsTab: (section?: string) => void;
  openBrowserTab: (url: string, title?: string) => void;
  openEditorTab: (filePath: string, sourceSessionId?: string) => void;
  createRemoteTab: (url: string) => Promise<void>;
  /** Which settings section to show when settings tab opens. */
  pendingSettingsSection: string | null;
  clearPendingSettingsSection: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  focusSession: (sessionId: string) => void;
  renameTab: (sessionId: string, title: string, opts?: { force?: boolean }) => void;
  /** Check whether the tab containing sessionId has its title locked (user-renamed or auto-named). */
  isTabTitleLocked: (sessionId: string) => boolean;
  /** Lock the tab title for the tab containing sessionId (prevents future auto-renames). */
  lockTabTitle: (sessionId: string) => void;
  updateTabColor: (tabId: string, color?: string) => void;
  duplicateTab: (tabId: string) => Promise<void>;
  createSSHTab: (config: SSHConnectionConfig) => Promise<void>;
  /** Stop auto-saving layout and clear persisted data. Call before window close without saving. */
  discardPersistedLayout: () => void;
  /** Save a tab's complete state to remote storage (one-shot, no sync tracking). */
  saveTab: (tabId: string, getAgentState: (sessionId: string) => { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string; thinkingEnabled?: boolean; scrollPosition?: number } | null) => Promise<void>;
  /** Load a saved tab snapshot, creating fresh PTY sessions with restored state. */
  loadSavedTab: (saved: SyncTab, restoreAgent: (sessionId: string, data: { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string; thinkingEnabled?: boolean; scrollPosition?: number }) => void) => Promise<void>;
  /** Delete a saved tab snapshot from persistent storage. */
  deleteSavedTab: (savedTabId: string) => Promise<void>;
  isHydrated: boolean;
  /** Server is unreachable — tabs restored from cache, terminal panes show retry overlay. */
  serverDisconnected: boolean;
  /** Register a styled confirm dialog (replaces window.confirm for tab close). */
  setConfirmHandler: (handler: (message: string) => Promise<boolean>) => void;
  /** Trigger an immediate CWD refresh for a session (or the active session). */
  refreshCwd: (sessionId?: string) => Promise<void>;
  /** Reconnect a disconnected SSH session using its stored profile. */
  reconnectSSH: (sessionId: string) => Promise<void>;
}

const LayoutContext = createContext<LayoutContextType | null>(null);

export const useLayout = () => {
  const context = useContext(LayoutContext);
  if (!context) throw new Error("useLayout must be used within LayoutProvider");
  return context;
};

export const LayoutProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [sessions, setSessions] = useState<Map<string, TerminalSession>>(
    new Map(),
  );

  // Expose sessions for E2E tests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__layoutSessions = sessions;

  // Ref tracking latest tabs for use in closures
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // Tab visit history — most recent at end. Used to jump to last-visited tab on close.
  const tabHistoryRef = useRef<string[]>([]);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // Track which sessions were live-PTY reconnects (PTY survived in server memory).
  // Used to set the `reconnected` flag accurately — avoids false positives when
  // a fresh PTY is created with the same session ID after grace period expiry.
  const livePtyReconnectsRef = useRef(new Set<string>());

  // Helper: Create a new PTY and return its ID (with retry for flaky mobile connections)
  const createPTY = async (
    cwd?: string,
    reconnectId?: string,
  ): Promise<string> => {
    const MAX_RETRIES = 3;
    const DELAYS = [0, 1000, 2000]; // exponential-ish backoff

    /** Parse createSession result — handles both old string and new object format. */
    const parseResult = (result: any): string => {
      if (typeof result === "object" && result?.sessionId) {
        if (result.reconnected) livePtyReconnectsRef.current.add(result.sessionId);
        return result.sessionId;
      }
      return result as string;
    };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.warn(`[Layout] createPTY retry ${attempt}/${MAX_RETRIES - 1} (reconnectId=${reconnectId?.slice(0, 8) ?? "none"})`);
        await new Promise(r => setTimeout(r, DELAYS[attempt]));
      }
      try {
        const result = await window.electron!.ipcRenderer.invoke(IPC.TERMINAL_CREATE, {
          cols: 80,
          rows: 30,
          cwd,
          reconnectId,
        });
        return parseResult(result);
      } catch (err) {
        console.warn(`[Layout] createPTY attempt ${attempt + 1} failed:`, err);
      }
    }

    // All retries with reconnectId failed — try once without it (fresh PTY)
    if (reconnectId) {
      try {
        console.warn("[Layout] createPTY falling back to fresh PTY (no reconnectId)");
        const result = await window.electron!.ipcRenderer.invoke(IPC.TERMINAL_CREATE, {
          cols: 80,
          rows: 30,
          cwd,
        });
        return parseResult(result);
      } catch (err) {
        console.warn("[Layout] createPTY fresh fallback also failed:", err);
      }
    }

    // Absolute last resort — mock session so the app doesn't crash
    return `mock-${uuid()}`;
  };

  // Server disconnected state — when true, tabs are restored from localStorage
  // but have no PTY backing. Terminal panes show a retry overlay.
  const [serverDisconnected, setServerDisconnected] = useState(false);

  /** Restore tab structure from saved state WITHOUT creating PTY sessions.
   *  Used when the server is unreachable on startup so tabs don't disappear. */
  const restoreTabsOffline = (
    savedTabs: Tab[],
    savedCwds: Record<string, string>,
    parsed: any,
  ): { tabs: Tab[]; sessions: Map<string, TerminalSession> } | null => {
    if (!savedTabs || savedTabs.length === 0) return null;
    const offlineSessions = new Map<string, TerminalSession>();
    // Keep existing session IDs from the saved layout — no PTY behind them
    const collectSessions = (node: LayoutNode) => {
      if (node.type === "leaf") {
        if (node.contentType === "settings" || node.contentType === "browser" || node.contentType === "editor" || node.contentType === "ssh-connect") return;
        const id = node.sessionId;
        const config = (parsed.sessionConfigs || {})[id] || aiService.getConfig();
        const savedTitle = (parsed.sessionTitles || {})[id];
        offlineSessions.set(id, {
          id,
          title: savedTitle || "Terminal",
          titleLocked: (parsed.sessionTitleLocked || {})[id] ?? false,
          cwd: savedCwds[id],
          aiConfig: config,
          interactions: (parsed.sessionInteractions || {})[id] || [],
          dirty: false, // Reset on app restart — user hasn't interacted yet this session
          sshProfileId: (parsed.sessionSSHProfileIds || {})[id],
          remoteUrl: (parsed.sessionRemoteUrls || {})[id],
        });
      } else if (node.children) {
        node.children.forEach(collectSessions);
      }
    };
    savedTabs.forEach((tab) => collectSessions(tab.root));
    // Back-compat: infer tab.titleLocked from session-level lock if missing
    const tabsWithLock = savedTabs.map((tab) => {
      if (tab.titleLocked) return tab;
      let locked = false;
      const walk = (n: LayoutNode) => {
        if (locked) return;
        if (n.type === "leaf") {
          if ((parsed.sessionTitleLocked || {})[n.sessionId]) locked = true;
        } else n.children.forEach(walk);
      };
      walk(tab.root);
      return locked ? { ...tab, titleLocked: true } : tab;
    });
    return { tabs: tabsWithLock, sessions: offlineSessions };
  };

  // Flag to disable auto-save when user chose "Exit Without Saving"
  const skipSaveRef = useRef(false);
  // Guard: prevent save effect from running before init has read saved state
  const initDoneRef = useRef(false);
  // Guard: prevent double-init from React StrictMode (effects fire twice in dev)
  const initCalledRef = useRef(false);

  const discardPersistedLayout = useCallback(async () => {
    skipSaveRef.current = true;
    // Clear persisted data
    localStorage.removeItem(STORAGE_KEYS.LAYOUT);
    // Write discard flag to sessions file (fs.writeFileSync — guaranteed on disk)
    // On next startup, hydration checks this flag and ignores localStorage
    await window.electron?.ipcRenderer?.writeSessions?.({ _discardLayout: true })?.catch?.(() => { });
    // Clear in-memory state so auto-save effect has nothing to re-save
    setTabs([]);
    setSessions(new Map());
    setActiveTabId("");
  }, []);

  // Persistence Logic — guarded by initDoneRef to prevent clearing saved state
  // before init has read it (save effect fires before init effect on first render)
  useEffect(() => {
    if (!initDoneRef.current) return; // Don't persist until initialization is complete
    if (serverDisconnected) return; // Don't overwrite saved state while offline (sessions have no PTY backing)
    if (skipSaveRef.current) {
      // Actively clear any stale saved state after "Exit Without Saving"
      localStorage.removeItem(STORAGE_KEYS.LAYOUT);
      return;
    }
    // Filter out ssh-connect tabs from persistence (they're regenerated on startup)
    const persistableTabs = tabs.filter((t) => t.root.type !== "leaf" || t.root.contentType !== "ssh-connect");
    if (persistableTabs.length === 0) {
      // All tabs are connect-tabs or empty — clear stale layout so refresh starts fresh
      localStorage.removeItem(STORAGE_KEYS.LAYOUT);
      return;
    }
    if (persistableTabs.length > 0) {
      const state = {
        tabs: persistableTabs,
        activeTabId,
        sessionCwds: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => ({
            ...acc,
            [id]: session.cwd || "",
          }),
          {} as Record<string, string>,
        ),
        sessionConfigs: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => ({
            ...acc,
            [id]: session.aiConfig,
          }),
          {} as Record<string, AIConfig | undefined>,
        ),
        sessionInteractions: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => ({
            ...acc,
            [id]: session.interactions,
          }),
          {} as Record<
            string,
            | { role: "user" | "agent"; content: string; timestamp: number }[]
            | undefined
          >,
        ),
        sessionSummaries: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => ({
            ...acc,
            [id]: {
              summary: session.contextSummary,
              sourceLength: session.contextSummarySourceLength,
            },
          }),
          {} as Record<
            string,
            { summary?: string; sourceLength?: number } | undefined
          >,
        ),
        sessionDirtyFlags: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => ({
            ...acc,
            [id]: session.dirty ?? false,
          }),
          {} as Record<string, boolean>,
        ),
        sessionSSHProfileIds: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => {
            if (session.sshProfileId) acc[id] = session.sshProfileId;
            return acc;
          },
          {} as Record<string, string>,
        ),
        sessionRemoteUrls: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => {
            if (session.remoteUrl) acc[id] = session.remoteUrl;
            return acc;
          },
          {} as Record<string, string>,
        ),
        sessionTitles: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => ({
            ...acc,
            [id]: session.title,
          }),
          {} as Record<string, string>,
        ),
        sessionTitleLocked: Array.from(sessions.entries()).reduce(
          (acc, [id, session]) => {
            if (session.titleLocked) acc[id] = true;
            return acc;
          },
          {} as Record<string, boolean>,
        ),
        savedAt: Date.now(),
      };
      localStorage.setItem(STORAGE_KEYS.LAYOUT, JSON.stringify(state));
      // Async backup to file (survives localStorage loss, private mode, etc.)
      window.electron?.ipcRenderer?.writeSessions?.({ _layout: state })?.catch?.(() => { });
    }
  }, [tabs, activeTabId, sessions]);

  // Periodic crash-resilience save (every 5s) — safety net for force-quit / kill -9.
  // Uses atomic file writes (write-then-rename) so a crash mid-write never corrupts the file.
  const periodicSaveRef = useRef<{ tabs: Tab[]; activeTabId: string; sessions: Map<string, TerminalSession> }>({ tabs, activeTabId, sessions });
  periodicSaveRef.current = { tabs, activeTabId, sessions };
  useEffect(() => {
    const id = setInterval(() => {
      const { tabs: t, activeTabId: aId, sessions: s } = periodicSaveRef.current;
      if (!t.length) return;
      const state = {
        tabs: t.map((tab) => ({ ...tab })),
        activeTabId: aId,
        sessionCwds: Array.from(s.entries()).reduce((acc, [sid, sess]) => ({ ...acc, [sid]: sess.cwd || "" }), {} as Record<string, string>),
        sessionConfigs: Array.from(s.entries()).reduce((acc, [sid, sess]) => ({ ...acc, [sid]: sess.aiConfig }), {} as Record<string, any>),
        sessionInteractions: Object.fromEntries(Array.from(s.entries()).map(([sid, sess]) => [sid, sess.interactions])),
        sessionSummaries: Array.from(s.entries()).reduce((acc, [sid, sess]) => ({ ...acc, [sid]: { summary: sess.contextSummary, sourceLength: sess.contextSummarySourceLength } }), {} as Record<string, { summary?: string; sourceLength?: number } | undefined>),
        sessionDirtyFlags: Array.from(s.entries()).reduce((acc, [sid, sess]) => ({ ...acc, [sid]: sess.dirty ?? false }), {} as Record<string, boolean>),
        sessionSSHProfileIds: Array.from(s.entries()).reduce((acc, [sid, sess]) => { if (sess.sshProfileId) acc[sid] = sess.sshProfileId; return acc; }, {} as Record<string, string>),
        sessionRemoteUrls: Array.from(s.entries()).reduce((acc, [sid, sess]) => { if (sess.remoteUrl) acc[sid] = sess.remoteUrl; return acc; }, {} as Record<string, string>),
        sessionTitles: Array.from(s.entries()).reduce((acc, [sid, sess]) => ({ ...acc, [sid]: sess.title }), {} as Record<string, string>),
        sessionTitleLocked: Array.from(s.entries()).reduce((acc, [sid, sess]) => { if (sess.titleLocked) acc[sid] = true; return acc; }, {} as Record<string, boolean>),
        savedAt: Date.now(),
      };
      window.electron?.ipcRenderer?.writeSessions?.({ _layout: state })?.catch?.(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Hydration / Initialization
  useEffect(() => {
    if (initCalledRef.current) return;
    initCalledRef.current = true;

    /** Create the default connect-tab placeholder for SSH-only mode. */
    const createConnectTab = () => {
      const tabId = uuid();
      setTabs([{
        id: tabId,
        title: "Terminal",
        root: { type: "leaf", sessionId: "ssh-connect", contentType: "ssh-connect" },
        activeSessionId: null,
      }]);
      setActiveTabId(tabId);
    };

    const init = async () => {
      // Check file-based discard flag (written by "Exit Without Saving")
      // This is reliable because fs.writeFileSync guarantees it's on disk
      try {
        const sessionsData = await window.electron?.ipcRenderer?.readSessions?.();
        if (sessionsData && (sessionsData as any)._discardLayout) {
          // Clear stale localStorage and reset sessions file
          localStorage.removeItem(STORAGE_KEYS.LAYOUT);
          window.electron?.ipcRenderer?.writeSessions?.({ _discardLayout: false, _layout: null })?.catch?.(() => { });
          // Fall through to create fresh tab
          if (isSshOnly()) { createConnectTab(); } else { createTab(); }
          return;
        }
        // File-backed layout is a FALLBACK only — localStorage is the primary
        // source because it's written synchronously and survives app crashes.
        // Only use the file when localStorage is empty (private mode, storage
        // cleared, first launch after migration, etc.).
        if (!localStorage.getItem(STORAGE_KEYS.LAYOUT) && sessionsData && (sessionsData as any)._layout) {
          localStorage.setItem(STORAGE_KEYS.LAYOUT, JSON.stringify((sessionsData as any)._layout));
        }
      } catch { /* ignore — continue with normal hydration */ }

      const saved = localStorage.getItem(STORAGE_KEYS.LAYOUT);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          const savedTabs: Tab[] = parsed.tabs;
          const savedCwds: Record<string, string> = parsed.sessionCwds || {};

          console.log("Hydrating layout...", savedTabs);

          if (savedTabs.length === 0) {
            if (isSshOnly()) { createConnectTab(); } else { createTab(); }
            return;
          }

          const newSessions = new Map<string, TerminalSession>();

          // Recursively regenerate sessions for a layout node
          const regenerateNode = async (
            node: LayoutNode,
          ): Promise<LayoutNode | null> => {
            if (node.type === "leaf") {
              // Non-PTY content types — restore as-is (no terminal session needed)
              if (node.contentType === "settings" || node.contentType === "browser" || node.contentType === "editor") {
                return node;
              }

              const oldId = node.sessionId;
              const cwd = savedCwds[oldId];
              const aiConfig = (parsed.sessionConfigs || {})[oldId];
              const interactions = (parsed.sessionInteractions || {})[oldId];
              const summaryConstant = (parsed.sessionSummaries || {})[oldId];
              const sshProfileId = (parsed.sessionSSHProfileIds || {})[oldId];
              const remoteUrl = (parsed.sessionRemoteUrls || {})[oldId];
              const titleLocked = (parsed.sessionTitleLocked || {})[oldId] ?? false;

              let newId: string;
              const savedTitle = (parsed.sessionTitles || {})[oldId];
              let sessionTitle = savedTitle || "Terminal";

              if (remoteUrl) {
                // Remote session — reconnect to remote Tron server
                try {
                  const connectionId = await connectRemote(remoteUrl);
                  const result = await createRemotePTY(connectionId, 80, 30, cwd, oldId);
                  newId = result.sessionId;
                  if (result.reconnected) livePtyReconnectsRef.current.add(newId);
                  sessionTitle = new URL(remoteUrl).host || "Remote";
                  console.log(`Reconnected remote session: ${oldId} → ${newId} (${remoteUrl})`);
                } catch (err: any) {
                  console.warn(`Failed to reconnect remote session ${oldId}:`, err.message);
                  return null; // Drop this leaf — remote reconnect failed
                }
              } else if (sshProfileId) {
                // SSH session — reconnect via profile
                try {
                  const ipc = window.electron?.ipcRenderer;
                  const readFn = (ipc as any)?.readSSHProfiles || (() => ipc?.invoke("ssh.profiles.read"));
                  const profiles = await readFn() || [];
                  const profile = profiles.find((p: any) => p.id === sshProfileId);
                  if (!profile) throw new Error("Profile not found");

                  const connectFn = (ipc as any)?.connectSSH || ((c: any) => ipc?.invoke("ssh.connect", c));
                  const result = await connectFn({
                    ...profile,
                    password: profile.savedPassword,
                    passphrase: profile.savedPassphrase,
                    cols: 80,
                    rows: 30,
                  });
                  newId = result.sessionId;
                  sessionTitle = profile.name || `${profile.username}@${profile.host}`;
                  console.log(`Reconnected SSH session: ${oldId} → ${newId}`);
                } catch (err: any) {
                  console.warn(`Failed to reconnect SSH session ${oldId}:`, err.message);
                  return null; // Drop this leaf — SSH reconnect failed
                }
              } else if (isSshOnly()) {
                // Non-SSH session in SSH-only mode — cannot reconnect
                return null;
              } else {
                // Local PTY — try to reconnect to existing PTY, else create new
                newId = await createPTY(cwd, oldId);
                if (newId === oldId) {
                  console.log(`Reconnected to PTY session: ${oldId}`);
                }
              }

              const config = aiConfig || aiService.getConfig();
              newSessions.set(newId, {
                id: newId,
                title: sessionTitle,
                titleLocked,
                cwd,
                aiConfig: config,
                interactions: interactions || [],
                contextSummary: summaryConstant?.summary,
                contextSummarySourceLength: summaryConstant?.sourceLength,
                dirty: false, // Reset on reconnect — user hasn't interacted yet
                sshProfileId,
                remoteUrl,
                // Mark as reconnected only if we reattached to a live PTY
                // (server confirmed the PTY was still alive). This avoids false
                // positives when a fresh PTY is created with the same session ID
                // after the grace period expired (e.g. mobile OS killed the page).
                reconnected: !sshProfileId && livePtyReconnectsRef.current.has(newId),
              });
              return { ...node, sessionId: newId };
            } else {
              const newChildren = (await Promise.all(
                node.children.map((c) => regenerateNode(c)),
              )).filter((c): c is LayoutNode => c !== null);
              if (newChildren.length === 0) return null;
              return { ...node, children: newChildren };
            }
          };

          const findFirstSession = (n: LayoutNode): string => {
            if (n.type === "leaf") return n.sessionId;
            return findFirstSession(n.children[0]);
          };

          // Regenerate all tabs in parallel for faster hydration
          const tabResults = await Promise.all(
            savedTabs.map(async (tab): Promise<Tab | null> => {
              const newRoot = await regenerateNode(tab.root);
              if (!newRoot) return null;
              // Back-compat: if saved state predates tab.titleLocked, infer
              // the lock from any session-level titleLocked under this tab.
              let titleLocked = tab.titleLocked === true;
              if (!titleLocked) {
                const walk = (n: LayoutNode) => {
                  if (titleLocked) return;
                  if (n.type === "leaf") {
                    if ((parsed.sessionTitleLocked || {})[n.sessionId]) titleLocked = true;
                  } else n.children.forEach(walk);
                };
                walk(tab.root);
              }
              return {
                ...tab,
                titleLocked,
                root: newRoot,
                activeSessionId: findFirstSession(newRoot),
              } as Tab;
            }),
          );
          const regeneratedTabs = tabResults.filter((t): t is Tab => t !== null);

          if (regeneratedTabs.length > 0) {
            setSessions(newSessions);
            setTabs(regeneratedTabs);
            setActiveTabId(parsed.activeTabId || regeneratedTabs[0].id);
            return;
          }
          // All tabs failed to reconnect — try offline restore (keep tab structure without PTYs)
          if (regeneratedTabs.length === 0) {
            const offlineTabs = restoreTabsOffline(savedTabs, savedCwds, parsed);
            if (offlineTabs) {
              setSessions(offlineTabs.sessions);
              setTabs(offlineTabs.tabs);
              setActiveTabId(parsed.activeTabId || offlineTabs.tabs[0].id);
              setServerDisconnected(true);
              return;
            }
          }
        } catch (e: any) {
          console.error("Failed to hydrate state:", e);
          // If the error is a server connection issue, restore tabs offline
          if (e?.message?.includes("unreachable") || e?.message?.includes("timeout") || e?.message?.includes("WebSocket")) {
            const saved2 = localStorage.getItem(STORAGE_KEYS.LAYOUT);
            if (saved2) {
              try {
                const parsed2 = JSON.parse(saved2);
                const offlineTabs = restoreTabsOffline(parsed2.tabs || [], parsed2.sessionCwds || {}, parsed2);
                if (offlineTabs) {
                  setSessions(offlineTabs.sessions);
                  setTabs(offlineTabs.tabs);
                  setActiveTabId(parsed2.activeTabId || offlineTabs.tabs[0].id);
                  setServerDisconnected(true);
                  return;
                }
              } catch { /* fall through */ }
            }
          }
          localStorage.removeItem(STORAGE_KEYS.LAYOUT);
        }
      }

      // Fallback if no save or error
      if (isSshOnly()) { createConnectTab(); } else { createTab(); }
    };

    // Run once — mark init done so save effect can start persisting
    init().finally(() => { initDoneRef.current = true; setIsHydrated(true); });
  }, []);

  const [isHydrated, setIsHydrated] = useState(false);

  // Re-attach terminal sessions when the server reconnects after a restart.
  // xterm instances keep their rendered content; we just need new PTYs behind them.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const serverDisconnectedRef = useRef(serverDisconnected);
  serverDisconnectedRef.current = serverDisconnected;
  useEffect(() => {
    onServerReconnect(async () => {
      const currentSessions = sessionsRef.current;
      const wasDisconnected = serverDisconnectedRef.current;
      for (const [sessionId, session] of currentSessions) {
        if (sessionId === "settings" || sessionId.startsWith("ssh-connect")) continue;
        // Skip remote sessions when reconnecting to local server
        if (session.remoteUrl) continue;

        if (session.sshProfileId) {
          // SSH sessions need full reconnect via profile — skip for now
          // (SSH reconnect is handled separately and may need credentials)
          continue;
        }

        try {
          const newId = await createPTY(session.cwd, sessionId);
          if (newId === sessionId) {
            console.log(`[Layout] Re-attached session after server restart: ${sessionId.slice(0, 8)}…`);
          }
        } catch (err) {
          console.warn(`[Layout] Failed to re-attach session ${sessionId.slice(0, 8)}…:`, err);
        }
      }
      // Clear disconnected state — terminal panes will hide retry overlay
      if (wasDisconnected) setServerDisconnected(false);
    });
  }, []);

  /** Insert a new tab right after the currently active tab. */
  const insertTabAfterActive = (newTab: Tab) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeTabIdRef.current);
      if (idx === -1) return [...prev, newTab]; // fallback: append
      const next = [...prev];
      next.splice(idx + 1, 0, newTab);
      return next;
    });
    setActiveTabId(newTab.id);
  };

  const createTab = async () => {
    // In SSH-only mode, create a connect tab instead of a local PTY
    if (isSshOnly()) {
      const tabId = uuid();
      const newTab: Tab = {
        id: tabId,
        title: "Terminal",
        root: { type: "leaf", sessionId: "ssh-connect-" + tabId, contentType: "ssh-connect" },
        activeSessionId: null,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
      return;
    }

    const sessionId = await createPTY();
    const newTabId = uuid();

    // Register session with default AI config
    const defaultConfig = aiService.getConfig();
    setSessions((prev) =>
      new Map(prev).set(sessionId, {
        id: sessionId,
        title: "Terminal",
        aiConfig: defaultConfig,
      }),
    );

    const newTab: Tab = {
      id: newTabId,
      title: "New Tab",
      root: { type: "leaf", sessionId },
      activeSessionId: sessionId,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
  };

  const createSSHTab = async (config: SSHConnectionConfig) => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;

    const connectFn = (ipc as any).connectSSH || ((c: any) => ipc.invoke("ssh.connect", c));
    const result = await connectFn({
      ...config,
      cols: 80,
      rows: 30,
    });
    const sessionId = result.sessionId;
    const newTabId = uuid();

    const defaultConfig = aiService.getConfig();
    const tabTitle = config.name || `${config.username}@${config.host}`;

    setSessions((prev) =>
      new Map(prev).set(sessionId, {
        id: sessionId,
        title: tabTitle,
        aiConfig: defaultConfig,
        sshProfileId: config.id,
      }),
    );

    const newTab: Tab = {
      id: newTabId,
      title: tabTitle,
      root: { type: "leaf", sessionId },
      activeSessionId: sessionId,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
  };

  const [pendingSettingsSection, setPendingSettingsSection] = useState<string | null>(null);
  const clearPendingSettingsSection = () => setPendingSettingsSection(null);

  const pendingSettingsTabIdRef = useRef<string | null>(null);

  const openSettingsTab = (section?: string) => {
    // Check if settings tab already exists in current state
    const existing = tabs.find(
      (t) => t.root.type === "leaf" && t.root.contentType === "settings",
    );
    if (existing) {
      // Only navigate to a specific section if explicitly requested
      if (section) setPendingSettingsSection(section);
      setActiveTabId(existing.id);
      return;
    }

    // Guard against double-click: ref is set synchronously so the second
    // click sees it even before React re-renders with the updated tabs.
    if (pendingSettingsTabIdRef.current) {
      if (section) setPendingSettingsSection(section);
      setActiveTabId(pendingSettingsTabIdRef.current);
      return;
    }

    // New settings tab — default to "ai" section unless another was requested
    setPendingSettingsSection(section || "ai");

    const newTabId = uuid();
    pendingSettingsTabIdRef.current = newTabId;
    const newTab: Tab = {
      id: newTabId,
      title: "Settings",
      root: { type: "leaf", sessionId: "settings", contentType: "settings" },
      activeSessionId: "settings",
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
  };

  const openEditorTab = (filePath: string, sourceSessionId?: string) => {
    // If an editor tab for this path is already open, focus it
    const existing = tabsRef.current.find((t) => {
      if (t.root.type !== "leaf") return false;
      return t.root.contentType === "editor" && t.root.editorPath === filePath;
    });
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const newTabId = uuid();
    const sessionId = `editor-${newTabId}`;
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const newTab: Tab = {
      id: newTabId,
      title: fileName,
      root: { type: "leaf", sessionId, contentType: "editor", editorPath: filePath, sourceSessionId },
      activeSessionId: sessionId,
    };
    insertTabAfterActive(newTab);
  };

  const openBrowserTab = (url: string, title?: string) => {
    const newTabId = uuid();
    const sessionId = `browser-${newTabId}`;
    const label = title || new URL(url).hostname || "Browser";
    const newTab: Tab = {
      id: newTabId,
      title: label,
      root: { type: "leaf", sessionId, contentType: "browser", url },
      activeSessionId: sessionId,
    };
    insertTabAfterActive(newTab);
  };

  const createRemoteTab = async (url: string) => {
    // Connect to the remote Tron server via WebSocket
    const connectionId = await connectRemote(url);

    // Create a PTY session on the remote server
    const { sessionId } = await createRemotePTY(connectionId, 80, 30);

    let label = "Remote";
    try { label = new URL(url).host || "Remote"; } catch { /* use default */ }

    const defaultConfig = aiService.getConfig();
    setSessions((prev) =>
      new Map(prev).set(sessionId, {
        id: sessionId,
        title: label,
        aiConfig: defaultConfig,
        remoteUrl: url,
      }),
    );

    const newTabId = uuid();
    const newTab: Tab = {
      id: newTabId,
      title: label,
      root: { type: "leaf", sessionId },
      activeSessionId: sessionId,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
  };

  const creatingTabRef = useRef(false); // Guard against double-create in StrictMode
  const closeTab = (tabId: string) => {
    // Find tab to close
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (tab) {
      // Clear settings tab guard if closing a settings tab
      if (tab.root.type === "leaf" && tab.root.contentType === "settings") {
        pendingSettingsTabIdRef.current = null;
      }
      // Clean up all sessions in this tab
      const closeNodeSessions = (node: LayoutNode) => {
        if (node.type === "leaf") {
          closeSession(node.sessionId);
        } else {
          node.children.forEach(closeNodeSessions);
        }
      };
      closeNodeSessions(tab.root);
    }

    // Synchronously update tabsRef so checkAllTabs doesn't see ghost tabs
    tabsRef.current = tabsRef.current.filter(t => t.id !== tabId);

    // Determine next tab BEFORE updating state, using refs for latest values
    const currentTabs = tabsRef.current;
    const remainingTabs = currentTabs.filter(t => t.id !== tabId);
    const isClosingActive = tabId === activeTabIdRef.current;

    if (isClosingActive && remainingTabs.length > 0) {
      // Walk back through visit history to find the most recently visited tab
      const remaining = new Set(remainingTabs.map(t => t.id));
      const h = tabHistoryRef.current;
      let nextTab = "";
      while (h.length > 0) {
        const candidate = h.pop()!;
        if (remaining.has(candidate)) {
          nextTab = candidate;
          break;
        }
      }
      if (!nextTab) nextTab = remainingTabs[remainingTabs.length - 1].id;
      setActiveTabId(nextTab);
    }

    // Clean closed tab from history
    tabHistoryRef.current = tabHistoryRef.current.filter(id => id !== tabId);

    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (newTabs.length === 0) {
        if (isSshOnly()) {
          if (!creatingTabRef.current) {
            creatingTabRef.current = true;
            setTimeout(() => {
              createTab().finally(() => { creatingTabRef.current = false; });
            }, 0);
          }
          return newTabs;
        }
        if (!creatingTabRef.current) {
          creatingTabRef.current = true;
          setTimeout(() => {
            createTab().finally(() => { creatingTabRef.current = false; });
          }, 0);
        }
        return newTabs;
      }
      return newTabs;
    });
  };

  const selectTab = (tabId: string) => {
    setActiveTabId((prev) => {
      if (prev && prev !== tabId) {
        // Push previous tab to history stack (dedup: remove if already present)
        const h = tabHistoryRef.current;
        const idx = h.indexOf(prev);
        if (idx !== -1) h.splice(idx, 1);
        h.push(prev);
        // Cap history length
        if (h.length > 50) h.shift();
      }
      return tabId;
    });
  };

  const reorderTabs = (fromIndex: number, toIndex: number) => {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const getActiveTab = () => tabs.find((t) => t.id === activeTabId);

  // Split Logic
  const splitUserAction = async (direction: SplitDirection) => {
    const tab = getActiveTab();
    if (!tab || !tab.activeSessionId) return;

    // Prevent split if settings active
    if (tab.activeSessionId === "settings") return;

    const currentSession = sessions.get(tab.activeSessionId);
    const sessionConfig = currentSession?.aiConfig || aiService.getConfig();

    // Current session CWD — fetch fresh from server to avoid stale/truncated paths
    let cwd = currentSession?.cwd;
    try {
      const freshCwd = await window.electron?.ipcRenderer?.getCwd(tab.activeSessionId);
      if (freshCwd) cwd = freshCwd;
    } catch { /* fall back to cached cwd */ }

    let newSessionId: string;
    let newTitle = "Terminal";

    if (currentSession?.remoteUrl) {
      // Remote server session — create a new PTY on the same remote server
      const connId = getRemoteConnectionId(tab.activeSessionId);
      if (!connId) return; // Connection lost
      const remoteResult = await createRemotePTY(connId, 80, 30, cwd);
      newSessionId = remoteResult.sessionId;
      newTitle = currentSession.title || "Remote";
    } else if (currentSession?.sshProfileId) {
      // SSH session — create a new SSH connection to the same host
      const ipc = window.electron?.ipcRenderer;
      if (!ipc) return;
      const readFn = (ipc as any)?.readSSHProfiles || (() => ipc.invoke("ssh.profiles.read"));
      const profiles: SSHConnectionConfig[] = await readFn() || [];
      const profile = profiles.find((p) => p.id === currentSession.sshProfileId);
      if (!profile) return; // Profile deleted
      const connectFn = (ipc as any).connectSSH || ((c: any) => ipc.invoke("ssh.connect", c));
      const result = await connectFn({ ...profile, cols: 80, rows: 30 });
      newSessionId = result.sessionId;
      newTitle = profile.name || `${profile.username}@${profile.host}`;
    } else {
      // Local session
      if (isSshOnly()) return; // Gateway mode: no local PTY
      newSessionId = await createPTY(cwd);
    }

    setSessions((prev) =>
      new Map(prev).set(newSessionId, {
        id: newSessionId,
        title: newTitle,
        cwd,
        aiConfig: sessionConfig,
        ...(currentSession?.remoteUrl ? { remoteUrl: currentSession.remoteUrl } : {}),
        ...(currentSession?.sshProfileId ? { sshProfileId: currentSession.sshProfileId } : {}),
      }),
    );

    // Recursive function to find and split the active leaf
    const splitNode = (node: LayoutNode, targetId: string): LayoutNode => {
      if (node.type === "leaf") {
        if (node.sessionId === targetId) {
          return {
            type: "split",
            direction,
            children: [
              node, // Existing
              { type: "leaf", sessionId: newSessionId }, // New
            ],
            sizes: [50, 50],
          };
        }
        return node;
      } else {
        return {
          ...node,
          children: node.children.map((child) => splitNode(child, targetId)),
        };
      }
    };

    setTabs((prev) =>
      prev.map((t) => {
        if (t.id === activeTabId) {
          return {
            ...t,
            root: splitNode(t.root, t.activeSessionId!),
            activeSessionId: newSessionId, // focus new split
          };
        }
        return t;
      }),
    );
  };

  // Close Active Pane Logic
  const closeActivePane = () => {
    const tab = getActiveTab();
    if (!tab || !tab.activeSessionId) return;

    const targetId = tab.activeSessionId;

    // Recursive removal
    // Returns null if node should be removed
    const removeNode = (node: LayoutNode): LayoutNode | null => {
      if (node.type === "leaf") {
        return node.sessionId === targetId ? null : node;
      }
      // Split
      const newChildren = node.children
        .map(removeNode)
        .filter((c): c is LayoutNode => c !== null);

      if (newChildren.length === 0) return null;
      if (newChildren.length === 1) return newChildren[0]; // Collapse split

      // Recalculate sizes (simple equal distribution for now)
      return {
        ...node,
        children: newChildren,
        sizes: newChildren.map(() => 100 / newChildren.length),
      };
    };

    const newRoot = removeNode(tab.root);

    // Kill the session process
    closeSession(targetId);

    if (!newRoot) {
      // Tab is empty, close it
      closeTab(tab.id);
    } else {
      // Find new active session (first available leaf)
      const findFirstSession = (n: LayoutNode): string => {
        if (n.type === "leaf") return n.sessionId;
        return findFirstSession(n.children[0]);
      };
      const newActiveId = findFirstSession(newRoot);

      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id
            ? { ...t, root: newRoot, activeSessionId: newActiveId }
            : t,
        ),
      );
    }
  };

  /** Remove a specific pane (by sessionId) from the layout tree and kill its PTY. */
  const closePane = (targetId: string) => {
    // Find the tab containing this session
    const tab = tabs.find((t) => {
      const findSession = (n: LayoutNode): boolean => {
        if (n.type === "leaf") return n.sessionId === targetId;
        return n.children.some(findSession);
      };
      return findSession(t.root);
    });
    if (!tab) return;

    const removeNode = (node: LayoutNode): LayoutNode | null => {
      if (node.type === "leaf") return node.sessionId === targetId ? null : node;
      const newChildren = node.children.map(removeNode).filter((c): c is LayoutNode => c !== null);
      if (newChildren.length === 0) return null;
      if (newChildren.length === 1) return newChildren[0];
      return { ...node, children: newChildren, sizes: newChildren.map(() => 100 / newChildren.length) };
    };

    const newRoot = removeNode(tab.root);
    closeSession(targetId);

    if (!newRoot) {
      closeTab(tab.id);
    } else {
      const findFirstSession = (n: LayoutNode): string => {
        if (n.type === "leaf") return n.sessionId;
        return findFirstSession(n.children[0]);
      };
      const newActiveId = findFirstSession(newRoot);
      setTabs((prev) =>
        prev.map((t) => (t.id === tab.id ? { ...t, root: newRoot, activeSessionId: newActiveId } : t)),
      );
    }
  };

  const closeSession = (sessionId: string) => {
    if (sessionId === "settings" || sessionId.startsWith("ssh-connect") || sessionId.startsWith("browser-") || sessionId.startsWith("editor-") || sessionId.startsWith("pixel-agents")) return; // pseudo-sessions

    // Close the terminal on local or remote server (routing handled by remote-bridge)
    if (window.electron) {
      window.electron.ipcRenderer.send(IPC.TERMINAL_CLOSE, sessionId);
    }
    // Clean up remote session routing if applicable
    unregisterRemoteSession(sessionId);

    setSessions((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  };

  // Update a session's CWD
  const updateSessionCwd = (sessionId: string, cwd: string) => {
    setSessions((prev) => {
      const next = new Map(prev);
      const session = next.get(sessionId);
      if (session) {
        next.set(sessionId, { ...session, cwd });
      }
      return next;
    });
  };

  const updateSessionConfig = (
    sessionId: string,
    config: Partial<AIConfig>,
  ) => {
    setSessions((prev) => {
      const next = new Map(prev);
      const session = next.get(sessionId);
      if (session) {
        next.set(sessionId, {
          ...session,
          aiConfig: { ...session.aiConfig!, ...config },
        });
      }
      return next;
    });
  };

  const updateSession = (
    sessionId: string,
    updates: Partial<TerminalSession>,
  ) => {
    setSessions((prev) => {
      const next = new Map(prev);
      const session = next.get(sessionId);
      if (session) {
        next.set(sessionId, { ...session, ...updates });
      }
      return next;
    });
  };

  const addInteraction = (
    sessionId: string,
    interaction: { role: "user" | "agent"; content: string; timestamp: number },
  ) => {
    setSessions((prev) => {
      const next = new Map(prev);
      const session = next.get(sessionId);
      if (session) {
        const existing = session.interactions || [];
        next.set(sessionId, {
          ...session,
          interactions: [...existing, interaction],
        });
      }
      return next;
    });
  };

  const clearInteractions = (sessionId: string) => {
    setSessions((prev) => {
      const session = prev.get(sessionId);
      if (!session) return prev;
      const next = new Map(prev);
      next.set(sessionId, {
        ...session,
        interactions: [],
        contextSummary: undefined,
        contextSummarySourceLength: undefined,
      });
      return next;
    });
  };

  const markSessionDirty = (sessionId: string) => {
    setSessions((prev) => {
      const session = prev.get(sessionId);
      if (!session || session.dirty) return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...session, dirty: true });
      return next;
    });
  };

  const updateSplitSizes = (path: number[], newSizes: number[]) => {
    const updateAtPath = (node: LayoutNode, p: number[]): LayoutNode => {
      if (p.length === 0) {
        if (node.type === "split") return { ...node, sizes: newSizes };
        return node;
      }
      if (node.type === "split") {
        return {
          ...node,
          children: node.children.map((child, i) =>
            i === p[0] ? updateAtPath(child, p.slice(1)) : child,
          ),
        };
      }
      return node;
    };

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId ? { ...t, root: updateAtPath(t.root, path) } : t,
      ),
    );
  };

  const focusSession = (sessionId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId ? { ...t, activeSessionId: sessionId } : t,
      ),
    );
  };

  /** Update tab title for the tab containing a given session */
  const renameTab = (sessionId: string, title: string, opts: { force?: boolean } = {}) => {
    // Defense-in-depth: if the tab title has been locked (user manually
    // renamed OR agent has generated an AI title for it), silently refuse
    // any non-forced rename. This catches auto-rename paths that forgot to
    // pre-check isTabTitleLocked — so a locked title stays locked across
    // splits, reconnects, and app restarts.
    if (!opts.force) {
      const locked = findTabBySession(sessionId)?.titleLocked === true;
      if (locked) return;
    }
    setTabs((prev) =>
      prev.map((t) =>
        t.activeSessionId === sessionId
          ? { ...t, title, ...(opts.force ? { titleLocked: true } : {}) }
          : t,
      ),
    );
    // Keep session title (and lock flag) in sync so it survives refresh
    setSessions((prev) => {
      const s = prev.get(sessionId);
      if (!s) return prev;
      const nextLocked = opts.force ? true : s.titleLocked;
      if (s.title === title && s.titleLocked === nextLocked) return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...s, title, titleLocked: nextLocked });
      return next;
    });
  };

  /** Find the tab whose layout tree contains the given sessionId. */
  const findTabBySession = (sessionId: string): Tab | undefined => {
    const contains = (node: LayoutNode, sid: string): boolean => {
      if (node.type === "leaf") return node.sessionId === sid;
      return node.children.some((c) => contains(c, sid));
    };
    return tabsRef.current.find((t) => contains(t.root, sessionId));
  };

  /** Check whether the tab containing sessionId has its title locked. */
  const isTabTitleLocked = (sessionId: string): boolean => {
    const tab = findTabBySession(sessionId);
    return tab?.titleLocked === true;
  };

  /** Lock the tab title for the tab containing sessionId. */
  const lockTabTitle = (sessionId: string): void => {
    const tab = findTabBySession(sessionId);
    if (!tab) return;
    if (!tab.titleLocked) {
      setTabs((prev) =>
        prev.map((t) => (t.id === tab.id ? { ...t, titleLocked: true } : t)),
      );
    }
    // Also mark every session in this tab as locked so the flag survives
    // session-id churn (SSH replace, reconnect with new PTY, split panes).
    const sessionIds: string[] = [];
    const collect = (node: LayoutNode) => {
      if (node.type === "leaf") {
        if (node.sessionId) sessionIds.push(node.sessionId);
      } else {
        node.children.forEach(collect);
      }
    };
    collect(tab.root);
    setSessions((prev) => {
      let mutated = false;
      const next = new Map(prev);
      for (const sid of sessionIds) {
        const s = next.get(sid);
        if (s && !s.titleLocked) {
          next.set(sid, { ...s, titleLocked: true });
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
  };

  /** Update the color flag for a tab */
  const updateTabColor = (tabId: string, color?: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, color } : t)),
    );
  };

  /** Duplicate an existing tab (copies configs + tab name, not history) */
  const duplicateTab = async (tabId: string) => {
    const tabToDuplicate = tabs.find((t) => t.id === tabId);
    if (!tabToDuplicate) return;

    // Helper: Clone a node tree, creating new sessions for leaf nodes
    const cloneNode = async (node: LayoutNode): Promise<LayoutNode> => {
      if (node.type === "leaf") {
        if (node.contentType === "settings") {
          return { ...node }; // Just duplicate the settings pointer
        }

        const oldSessionId = node.sessionId;
        const oldSession = sessions.get(oldSessionId);

        // Fetch fresh cwd from server to avoid stale/truncated paths
        let cwd = oldSession?.cwd;
        try {
          const freshCwd = await window.electron?.ipcRenderer?.getCwd(oldSessionId);
          if (freshCwd) cwd = freshCwd;
        } catch { /* fall back to cached cwd */ }

        let newSessionId: string;
        let newTitle = oldSession?.title || "Terminal";

        if (oldSession?.remoteUrl) {
          // Remote server session — create PTY on the same remote server
          const connId = getRemoteConnectionId(oldSessionId);
          if (!connId) return node; // Connection lost — keep original
          const remoteResult = await createRemotePTY(connId, 80, 30, cwd);
          newSessionId = remoteResult.sessionId;
        } else if (oldSession?.sshProfileId) {
          // SSH session — create a new SSH connection to the same host
          const ipc = window.electron?.ipcRenderer;
          if (!ipc) return node;
          const readFn = (ipc as any)?.readSSHProfiles || (() => ipc.invoke("ssh.profiles.read"));
          const profiles: SSHConnectionConfig[] = await readFn() || [];
          const profile = profiles.find((p) => p.id === oldSession.sshProfileId);
          if (!profile) return node; // Profile deleted
          const connectFn = (ipc as any).connectSSH || ((c: any) => ipc.invoke("ssh.connect", c));
          const result = await connectFn({ ...profile, cols: 80, rows: 30 });
          newSessionId = result.sessionId;
          newTitle = profile.name || `${profile.username}@${profile.host}`;
        } else {
          newSessionId = await createPTY(cwd);
        }

        // Copy configs only — not terminal/agent history
        setSessions((prev) =>
          new Map(prev).set(newSessionId, {
            id: newSessionId,
            title: newTitle,
            cwd,
            aiConfig: oldSession?.aiConfig || aiService.getConfig(),
            ...(oldSession?.remoteUrl ? { remoteUrl: oldSession.remoteUrl } : {}),
            ...(oldSession?.sshProfileId ? { sshProfileId: oldSession.sshProfileId } : {}),
          }),
        );
        return { ...node, sessionId: newSessionId };
      } else {
        const newChildren = await Promise.all(node.children.map(cloneNode));
        return { ...node, children: newChildren };
      }
    };

    const newRoot = await cloneNode(tabToDuplicate.root);

    // Find first active session for the duplicated tab
    const findFirstSession = (n: LayoutNode): string => {
      if (n.type === "leaf") return n.sessionId;
      return findFirstSession(n.children[0]);
    };

    let activeSessionId = "settings";
    try {
      activeSessionId = findFirstSession(newRoot);
    } catch { }

    const newTabId = uuid();
    const newTab: Tab = {
      id: newTabId,
      title: `${tabToDuplicate.title} (Copy)`,
      color: tabToDuplicate.color,
      titleLocked: tabToDuplicate.titleLocked,
      root: newRoot,
      activeSessionId,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId); // Focus the duplicated tab immediately
  };

  /** Save a tab's complete state to remote storage (one-shot, no sync tracking). */
  const saveTab = async (
    tabId: string,
    getAgentState: (sessionId: string) => { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string; thinkingEnabled?: boolean; scrollPosition?: number } | null,
  ) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;

    // Collect all sessionIds from the layout tree
    const collectSessionIds = (node: LayoutNode): string[] => {
      if (node.type === "leaf") return [node.sessionId];
      return node.children.flatMap(collectSessionIds);
    };
    const sessionIds = collectSessionIds(tab.root);

    const sessionData: SyncTab["sessions"] = {};
    const agentData: SyncTab["agentState"] = {};

    const ipc = window.electron?.ipcRenderer;
    const readFn = (ipc as any)?.readSyncTabs || (() => ipc?.invoke("savedTabs.read"));
    const writeFn = (ipc as any)?.writeSyncTabs || ((d: any) => ipc?.invoke("savedTabs.write", d));

    for (const sid of sessionIds) {
      const session = sessions.get(sid);
      if (session) {
        let terminalHistory: string | undefined;
        try {
          terminalHistory = await ipc?.getHistory?.(sid) || undefined;
        } catch { /* best effort */ }

        sessionData[sid] = {
          title: session.title,
          cwd: session.cwd,
          aiConfig: session.aiConfig,
          interactions: session.interactions,
          contextSummary: session.contextSummary,
          contextSummarySourceLength: session.contextSummarySourceLength,
          sshProfileId: session.sshProfileId,
          terminalHistory,
        };
      }
      const agent = getAgentState(sid);
      if (agent) agentData[sid] = agent;
    }

    const existing: SyncTab[] = (await readFn()) || [];

    // Deduplicate name: if a saved tab with the same name exists, append (1), (2), etc.
    let saveName = tab.title;
    const existingNames = new Set(existing.map(e => e.name));
    if (existingNames.has(saveName)) {
      let idx = 1;
      while (existingNames.has(`${tab.title} (${idx})`)) idx++;
      saveName = `${tab.title} (${idx})`;
    }

    const newId = uuid();
    const entry: SyncTab = {
      id: newId,
      name: saveName,
      savedAt: Date.now(),
      tab: { title: tab.title, color: tab.color, root: tab.root },
      sessions: sessionData,
      agentState: agentData,
    };
    await writeFn([...existing, entry]);
  };

  /** Load a saved tab snapshot, creating fresh PTY sessions with restored state. */
  const loadSavedTab = async (
    saved: SyncTab,
    restoreAgent: (sessionId: string, data: { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string; thinkingEnabled?: boolean; scrollPosition?: number }) => void,
  ) => {
    const recreateNode = async (node: LayoutNode): Promise<LayoutNode | null> => {
      if (node.type === "leaf") {
        if (node.contentType === "settings") return node;

        const oldId = node.sessionId;
        const sessionInfo = saved.sessions[oldId];
        const cwd = sessionInfo?.cwd;
        let newId: string;

        if (sessionInfo?.sshProfileId) {
          try {
            const ipc = window.electron?.ipcRenderer;
            const readFn = (ipc as any)?.readSSHProfiles || (() => ipc?.invoke("ssh.profiles.read"));
            const profiles = await readFn() || [];
            const profile = profiles.find((p: any) => p.id === sessionInfo.sshProfileId);
            if (!profile) return null;
            const connectFn = (ipc as any)?.connectSSH || ((c: any) => ipc?.invoke("ssh.connect", c));
            const result = await connectFn({
              ...profile,
              password: profile.savedPassword,
              passphrase: profile.savedPassphrase,
              cols: 80, rows: 30,
            });
            newId = result.sessionId;
          } catch { return null; }
        } else if (isSshOnly()) {
          return null;
        } else {
          newId = await createPTY(cwd);
        }

        // Inject history into the server-side buffer for agent read_terminal
        if (sessionInfo?.terminalHistory) {
          try {
            const ipc = window.electron?.ipcRenderer;
            await ipc?.invoke?.("terminal.setHistory", { sessionId: newId, history: sessionInfo.terminalHistory });
          } catch { /* best effort */ }
        }

        const config = sessionInfo?.aiConfig || aiService.getConfig();
        setSessions(prev => new Map(prev).set(newId, {
          id: newId,
          title: sessionInfo?.title || "Terminal",
          cwd,
          aiConfig: config,
          interactions: sessionInfo?.interactions || [],
          contextSummary: sessionInfo?.contextSummary,
          contextSummarySourceLength: sessionInfo?.contextSummarySourceLength,
          sshProfileId: sessionInfo?.sshProfileId,
          pendingHistory: sessionInfo?.terminalHistory,
        }));

        const agentSnapshot = saved.agentState[oldId];
        if (agentSnapshot) restoreAgent(newId, agentSnapshot);

        return { ...node, sessionId: newId };
      } else {
        const newChildren = (await Promise.all(
          node.children.map(c => recreateNode(c)),
        )).filter((c): c is LayoutNode => c !== null);
        if (newChildren.length === 0) return null;
        return { ...node, children: newChildren };
      }
    };

    const newRoot = await recreateNode(saved.tab.root);
    if (!newRoot) return;

    const findFirstSession = (n: LayoutNode): string => {
      if (n.type === "leaf") return n.sessionId;
      return findFirstSession(n.children[0]);
    };

    const newTabId = uuid();
    const newTab: Tab = {
      id: newTabId,
      title: saved.tab.title,
      color: saved.tab.color,
      root: newRoot,
      activeSessionId: findFirstSession(newRoot),
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTabId);
  };

  /** Delete a saved tab snapshot from persistent storage. */
  const deleteSavedTab = async (savedTabId: string) => {
    const ipc = window.electron?.ipcRenderer;
    const readFn = (ipc as any)?.readSyncTabs || (() => ipc?.invoke("savedTabs.read"));
    const writeFn = (ipc as any)?.writeSyncTabs || ((d: any) => ipc?.invoke("savedTabs.write", d));
    try {
      const existing: SyncTab[] = (await readFn()) || [];
      const updated = existing.filter(t => t.id !== savedTabId);
      await writeFn(updated);
    } catch { /* best effort */ }
  };

  const activeSessionId = getActiveTab()?.activeSessionId || null;
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // Poll CWD for the active session every 3 seconds (with in-flight guard)
  const cwdInFlightRef = useRef(false);

  const refreshCwd = useCallback(async (sessionId?: string) => {
    const sid = sessionId || activeSessionId;
    if (!sid || sid === "settings" || !window.electron) return;
    if (cwdInFlightRef.current) return;
    cwdInFlightRef.current = true;
    try {
      const cwd = await window.electron.ipcRenderer.getCwd(sid);
      if (cwd) {
        updateSessionCwd(sid, cwd);
      }
    } catch (e) {
      console.warn("Error polling CWD:", e);
    } finally {
      cwdInFlightRef.current = false;
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId || activeSessionId === "settings" || !window.electron)
      return;

    refreshCwd();
    const interval = setInterval(refreshCwd, 3000);
    return () => clearInterval(interval);
  }, [activeSessionId, refreshCwd]);

  // Styled confirm handler — App.tsx registers a modal-based one via setConfirmHandler
  const confirmHandlerRef = useRef<((message: string) => Promise<boolean>) | null>(null);
  const setConfirmHandler = useCallback((handler: (message: string) => Promise<boolean>) => {
    confirmHandlerRef.current = handler;
  }, []);

  // Close pane with confirmation — skips confirm for settings or new (non-dirty) sessions
  const closeActivePaneWithConfirm = async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (tab.root.type === "leaf" && tab.root.contentType === "settings") {
      closeActivePane();
      return;
    }
    const session = sessions.get(tab.activeSessionId || "");
    if (!session?.dirty) {
      closeActivePane();
      return;
    }
    const confirmed = confirmHandlerRef.current
      ? await confirmHandlerRef.current("Close this terminal session?")
      : window.confirm("Close this terminal session?");
    if (confirmed) {
      closeActivePane();
    }
  };

  /** Reconnect a disconnected SSH session using its stored profile. */
  const reconnectSSH = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current.get(sessionId);
    if (!session?.sshProfileId) return;
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;
    try {
      const readFn = (ipc as any)?.readSSHProfiles || (() => ipc.invoke("ssh.profiles.read"));
      const profiles: SSHConnectionConfig[] = await readFn() || [];
      const profile = profiles.find((p) => p.id === session.sshProfileId);
      if (!profile) throw new Error("SSH profile not found");
      const connectFn = (ipc as any)?.connectSSH || ((c: any) => ipc.invoke("ssh.connect", c));
      const result = await connectFn({
        ...profile,
        password: (profile as any).savedPassword,
        passphrase: (profile as any).savedPassphrase,
        cols: 80,
        rows: 30,
      });
      const newId = result.sessionId;
      const newTitle = profile.name || `${(profile as any).username}@${(profile as any).host}`;
      // Replace the old session with the new one, preserving config
      setSessions((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        next.set(newId, {
          id: newId,
          title: session.title || newTitle,
          titleLocked: session.titleLocked,
          cwd: session.cwd,
          aiConfig: session.aiConfig || aiService.getConfig(),
          sshProfileId: session.sshProfileId,
        });
        return next;
      });
      // Update the layout tree to use the new session ID
      setTabs((prev) =>
        prev.map((tab) => {
          const replaceNode = (node: LayoutNode): LayoutNode => {
            if (node.type === "leaf") {
              return node.sessionId === sessionId ? { ...node, sessionId: newId } : node;
            }
            return { ...node, children: node.children.map(replaceNode) };
          };
          const newRoot = replaceNode(tab.root);
          const newActiveId = tab.activeSessionId === sessionId ? newId : tab.activeSessionId;
          return newRoot !== tab.root || newActiveId !== tab.activeSessionId
            ? { ...tab, root: newRoot, activeSessionId: newActiveId }
            : tab;
        }),
      );
    } catch (err: any) {
      console.warn(`Failed to reconnect SSH session ${sessionId}:`, err.message);
    }
  }, []);

  const responsiveCheckInFlightRef = useRef(new Set<string>());
  const responsiveCheckLastAtRef = useRef(new Map<string, number>());

  const ensureActiveSessionResponsive = useCallback(async (sessionId?: string | null) => {
    const sid = sessionId || activeSessionIdRef.current;
    if (!sid || sid === "settings" || sid.startsWith("ssh-connect") || sid.startsWith("browser-") || sid.startsWith("editor-") || sid.startsWith("pixel-agents")) return;
    const session = sessionsRef.current.get(sid);
    if (!session) return;
    if (!session.remoteUrl && !session.sshProfileId) return;

    const now = Date.now();
    const last = responsiveCheckLastAtRef.current.get(sid) ?? 0;
    if (now - last < 5000 || responsiveCheckInFlightRef.current.has(sid)) return;
    responsiveCheckLastAtRef.current.set(sid, now);
    responsiveCheckInFlightRef.current.add(sid);

    try {
      if (session.remoteUrl) {
        await reviveRemoteSession(sid, session.cwd);
        return;
      }

      if (session.sshProfileId) {
        const ipc = window.electron?.ipcRenderer;
        if (!ipc) return;
        const exists = await withTimeout(
          ipc.invoke(IPC.TERMINAL_SESSION_EXISTS, sid),
          2500,
          "SSH session check",
        ).catch(() => false);
        if (!exists) {
          await reconnectSSH(sid);
          return;
        }

        const ping = await withTimeout(
          ipc.invoke(IPC.TERMINAL_EXEC, {
            sessionId: sid,
            command: "printf __TRON_PING__",
          }),
          6000,
          "SSH ping",
        ).catch(() => null);
        if (!ping || ping.exitCode !== 0 || !String(ping.stdout || "").includes("__TRON_PING__")) {
          await reconnectSSH(sid);
        }
      }
    } finally {
      responsiveCheckInFlightRef.current.delete(sid);
    }
  }, [reconnectSSH]);

  useEffect(() => {
    ensureActiveSessionResponsive(activeSessionId);
  }, [activeSessionId, ensureActiveSessionResponsive]);

  useEffect(() => {
    const check = () => ensureActiveSessionResponsive(activeTabIdRef.current ? activeSessionIdRef.current : null);
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ensureActiveSessionResponsive]);

  // Keyboard Shortcuts (customizable via hotkey system)
  // In web mode, Cmd+W/Cmd+D/Cmd+Shift+D conflict with browser shortcuts
  // (close tab, bookmark, etc.) so we only register them in Electron.
  const { hotkeys } = useConfig();
  const isElectron = isElectronApp();
  useEffect(() => {
    // Tab-switch hotkeys (Cmd/Ctrl+1..9, 0) must yield to text inputs — when
    // SmartInput is focused the same combos bind to mode switches.
    const isTextInputFocused = (): boolean => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesHotkey(e, hotkeys.newTab || "meta+t")) {
        e.preventDefault();
        createTab();
        return;
      }
      if (isElectron && matchesHotkey(e, hotkeys.closeTab || "meta+w")) {
        e.preventDefault();
        closeActivePaneWithConfirm();
        return;
      }
      if (isElectron && matchesHotkey(e, hotkeys.splitHorizontal || "meta+d")) {
        e.preventDefault();
        splitUserAction("horizontal");
        return;
      }
      if (isElectron && matchesHotkey(e, hotkeys.splitVertical || "meta+shift+d")) {
        e.preventDefault();
        splitUserAction("vertical");
        return;
      }

      // Tab-index switch (Cmd+1..9, Cmd+0 → last). Skip when a text input
      // is focused so SmartInput's mode hotkeys keep working.
      if (!isTextInputFocused()) {
        const indexBindings: Array<[string, number]> = [
          [hotkeys.switchTab1, 1],
          [hotkeys.switchTab2, 2],
          [hotkeys.switchTab3, 3],
          [hotkeys.switchTab4, 4],
          [hotkeys.switchTab5, 5],
          [hotkeys.switchTab6, 6],
          [hotkeys.switchTab7, 7],
          [hotkeys.switchTab8, 8],
          [hotkeys.switchTab9, 9],
          [hotkeys.switchTabLast, 0],
        ];
        for (const [combo, digit] of indexBindings) {
          if (combo && matchesHotkey(e, combo)) {
            const target = selectTabByIndex(tabsRef.current, digit);
            if (target) {
              e.preventDefault();
              setActiveTabId(target.id);
            }
            return;
          }
        }
      }

      // Tab search palette (Cmd+Shift+P by default) — dispatched globally
      // so any mounted listener (App.tsx) can open the palette overlay.
      if (hotkeys.tabSearch && matchesHotkey(e, hotkeys.tabSearch)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("tron:openTabSearch"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    // Handle Menu IPC (Electron menu accelerators — always fire regardless of hotkey config)
    if (window.electron) {
      const removeCloseListener = window.electron.ipcRenderer.on(
        IPC.MENU_CLOSE_TAB,
        () => {
          closeActivePaneWithConfirm();
        },
      );
      const removeCreateListener = window.electron.ipcRenderer.on(
        IPC.MENU_CREATE_TAB,
        () => {
          createTab();
        },
      );

      return () => {
        removeCloseListener();
        removeCreateListener();
        window.removeEventListener("keydown", handleKeyDown);
      };
    }

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tabs, activeTabId, sessions, closeActivePane, createTab, hotkeys]);

  return (
    <LayoutContext.Provider
      value={{
        tabs,
        activeTabId,
        sessions,
        activeSessionId,
        createTab,
        closeTab,
        selectTab,
        splitUserAction,
        closeSession,
        closePane,
        updateSessionConfig,
        updateSession,
        markSessionDirty,
        updateSplitSizes,
        openSettingsTab,
        openBrowserTab,
        openEditorTab,
        createRemoteTab,
        pendingSettingsSection,
        clearPendingSettingsSection,
        reorderTabs,
        focusSession,
        renameTab,
        isTabTitleLocked,
        lockTabTitle,
        updateTabColor,
        duplicateTab,
        createSSHTab,
        addInteraction,
        clearInteractions,
        discardPersistedLayout,
        saveTab,
        loadSavedTab,
        deleteSavedTab,
        isHydrated,
        serverDisconnected,
        setConfirmHandler,
        refreshCwd,
        reconnectSSH,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
};
