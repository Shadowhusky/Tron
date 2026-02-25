import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import type {
  LayoutNode,
  Tab,
  TerminalSession,
  SplitDirection,
  AIConfig,
  SSHConnectionConfig,
  SavedTab,
  AgentStep,
} from "../types";
import { aiService } from "../services/ai";
import { STORAGE_KEYS } from "../constants/storage";
import { IPC } from "../constants/ipc";
import { isSshOnly } from "../services/mode";
import { onServerReconnect } from "../services/ws-bridge";
import { matchesHotkey } from "../hooks/useHotkey";
import { useConfig } from "./ConfigContext";

// --- Mock UUID if crypto not avail in browser (though we use electron) ---
function uuid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2);
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
  /** Which settings section to show when settings tab opens. */
  pendingSettingsSection: string | null;
  clearPendingSettingsSection: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  focusSession: (sessionId: string) => void;
  renameTab: (sessionId: string, title: string) => void;
  updateTabColor: (tabId: string, color?: string) => void;
  duplicateTab: (tabId: string, onNewSession?: (oldId: string, newId: string) => void) => Promise<void>;
  createSSHTab: (config: SSHConnectionConfig) => Promise<void>;
  /** Stop auto-saving layout and clear persisted data. Call before window close without saving. */
  discardPersistedLayout: () => void;
  saveTab: (tabId: string, getAgentState: (sessionId: string) => { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string; thinkingEnabled?: boolean; scrollPosition?: number } | null) => Promise<void>;
  loadSavedTab: (saved: SavedTab, restoreAgent: (sessionId: string, data: { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string; thinkingEnabled?: boolean; scrollPosition?: number }) => void) => Promise<void>;
  /** Delete a saved tab snapshot from persistent storage. */
  deleteSavedTab: (savedTabId: string) => Promise<void>;
  isHydrated: boolean;
  /** Register a styled confirm dialog (replaces window.confirm for tab close). */
  setConfirmHandler: (handler: (message: string) => Promise<boolean>) => void;
  /** Trigger an immediate CWD refresh for a session (or the active session). */
  refreshCwd: (sessionId?: string) => Promise<void>;
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
      };
      localStorage.setItem(STORAGE_KEYS.LAYOUT, JSON.stringify(state));
      // Also back up layout to server (survives localStorage loss, private mode, etc.)
      window.electron?.ipcRenderer?.writeSessions?.({ _layout: state })?.catch?.(() => { });
    }
  }, [tabs, activeTabId, sessions]);

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
        // Try server-backed layout (survives localStorage loss / private mode)
        if (sessionsData && (sessionsData as any)._layout) {
          const serverLayout = (sessionsData as any)._layout;
          // Sync to localStorage so downstream code can use it
          localStorage.setItem(STORAGE_KEYS.LAYOUT, JSON.stringify(serverLayout));
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
          const regeneratedTabs: Tab[] = [];

          for (const tab of savedTabs) {
            // Recursively regenerate sessions for this tab
            const regenerateNode = async (
              node: LayoutNode,
            ): Promise<LayoutNode | null> => {
              if (node.type === "leaf") {
                // If settings node, just restore
                if (node.contentType === "settings") {
                  return node;
                }

                const oldId = node.sessionId;
                const cwd = savedCwds[oldId];
                const aiConfig = (parsed.sessionConfigs || {})[oldId];
                const interactions = (parsed.sessionInteractions || {})[oldId];
                const summaryConstant = (parsed.sessionSummaries || {})[oldId];
                const wasDirty =
                  (parsed.sessionDirtyFlags || {})[oldId] ?? false;
                const sshProfileId = (parsed.sessionSSHProfileIds || {})[oldId];

                let newId: string;
                let sessionTitle = "Terminal";

                if (sshProfileId) {
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
                  cwd,
                  aiConfig: config,
                  interactions: interactions || [],
                  contextSummary: summaryConstant?.summary,
                  contextSummarySourceLength: summaryConstant?.sourceLength,
                  dirty: wasDirty,
                  sshProfileId,
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

            const newRoot = await regenerateNode(tab.root);

            // Skip tabs where all sessions failed to reconnect
            if (!newRoot) continue;

            // Fix activeSessionId if it pointed to an old session
            const findFirstSession = (n: LayoutNode): string => {
              if (n.type === "leaf") return n.sessionId;
              return findFirstSession(n.children[0]);
            };

            regeneratedTabs.push({
              ...tab,
              root: newRoot,
              activeSessionId: findFirstSession(newRoot),
            });
          }

          if (regeneratedTabs.length > 0) {
            setSessions(newSessions);
            setTabs(regeneratedTabs);
            setActiveTabId(parsed.activeTabId || regeneratedTabs[0].id);
            return;
          }
          // All tabs failed to reconnect — fall through to create fresh tab
        } catch (e) {
          console.error("Failed to hydrate state:", e);
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
  useEffect(() => {
    onServerReconnect(async () => {
      const currentSessions = sessionsRef.current;
      for (const [sessionId, session] of currentSessions) {
        if (sessionId === "settings" || sessionId.startsWith("ssh-connect")) continue;

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
    });
  }, []);

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

  const creatingTabRef = useRef(false); // Guard against double-create in StrictMode
  const closeTab = (tabId: string) => {
    // Find tab to close
    const tab = tabs.find((t) => t.id === tabId);
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

    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (newTabs.length === 0) {
        // In SSH-only mode, create a new connect tab
        if (isSshOnly()) {
          if (!creatingTabRef.current) {
            creatingTabRef.current = true;
            setTimeout(() => {
              createTab().finally(() => { creatingTabRef.current = false; });
            }, 0);
          }
          return newTabs;
        }
        // Always keep at least one tab open — create outside the updater to avoid StrictMode double-call
        if (!creatingTabRef.current) {
          creatingTabRef.current = true;
          // Use setTimeout to escape the setState updater — createTab is async and calls setTabs itself
          setTimeout(() => {
            createTab().finally(() => { creatingTabRef.current = false; });
          }, 0);
        }
        return newTabs;
      }
      if (tabId === activeTabId) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }
      return newTabs;
    });
  };

  const selectTab = (tabId: string) => setActiveTabId(tabId);

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

    // Gateway mode: no local PTY to split into
    if (isSshOnly()) return;

    // Current session CWD
    const currentSession = sessions.get(tab.activeSessionId);
    const cwd = currentSession?.cwd;

    const newSessionId = await createPTY(cwd);
    const sessionConfig = currentSession?.aiConfig || aiService.getConfig();
    setSessions((prev) =>
      new Map(prev).set(newSessionId, {
        id: newSessionId,
        title: "Terminal",
        cwd,
        aiConfig: sessionConfig,
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

  const closeSession = (sessionId: string) => {
    if (sessionId === "settings" || sessionId.startsWith("ssh-connect")) return; // pseudo-sessions

    if (window.electron) {
      window.electron.ipcRenderer.send(IPC.TERMINAL_CLOSE, sessionId);
    }
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
  const renameTab = (sessionId: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.activeSessionId === sessionId ? { ...t, title } : t)),
    );
  };

  /** Update the color flag for a tab */
  const updateTabColor = (tabId: string, color?: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, color } : t)),
    );
  };

  /** Duplicate an existing tab */
  const duplicateTab = async (tabId: string, onNewSession?: (oldId: string, newId: string) => void) => {
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

        // Let's create a new completely disconnected PTY running in the same CWD
        const cwd = oldSession?.cwd;
        const newSessionId = await createPTY(cwd);

        // Copy the configs and contexts over
        setSessions((prev) =>
          new Map(prev).set(newSessionId, {
            id: newSessionId,
            title: oldSession?.title || "Terminal",
            cwd,
            aiConfig: oldSession?.aiConfig || aiService.getConfig(),
            interactions: oldSession?.interactions ? [...oldSession.interactions] : [],
            contextSummary: oldSession?.contextSummary,
            contextSummarySourceLength: oldSession?.contextSummarySourceLength,
            dirty: oldSession?.dirty,
          }),
        );
        if (onNewSession) {
          onNewSession(oldSessionId, newSessionId);
        }
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
      root: newRoot,
      activeSessionId,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId); // Focus the duplicated tab immediately
  };

  /** Save a tab's complete state (sessions + agent thread) for cross-device restore. */
  const saveTab = async (
    tabId: string,
    getAgentState: (sessionId: string) => { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string; thinkingEnabled?: boolean; scrollPosition?: number } | null,
  ) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Collect all sessionIds from the layout tree
    const collectSessionIds = (node: LayoutNode): string[] => {
      if (node.type === "leaf") return [node.sessionId];
      return node.children.flatMap(collectSessionIds);
    };
    const sessionIds = collectSessionIds(tab.root);

    const sessionData: SavedTab["sessions"] = {};
    const agentData: SavedTab["agentState"] = {};

    for (const sid of sessionIds) {
      const session = sessions.get(sid);
      if (session) {
        sessionData[sid] = {
          title: session.title,
          cwd: session.cwd,
          aiConfig: session.aiConfig,
          interactions: session.interactions,
          contextSummary: session.contextSummary,
          contextSummarySourceLength: session.contextSummarySourceLength,
          sshProfileId: session.sshProfileId,
        };
      }
      const agent = getAgentState(sid);
      if (agent) agentData[sid] = agent;
    }

    const savedTab: SavedTab = {
      id: uuid(),
      name: tab.title,
      savedAt: Date.now(),
      tab: { title: tab.title, color: tab.color, root: tab.root },
      sessions: sessionData,
      agentState: agentData,
    };

    const ipc = window.electron?.ipcRenderer;
    const existing: SavedTab[] = (await ipc?.readSavedTabs?.()) || [];
    await ipc?.writeSavedTabs?.([...existing, savedTab]);
  };

  /** Load a saved tab snapshot, creating fresh PTY sessions with restored conversation state. */
  const loadSavedTab = async (
    saved: SavedTab,
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
    setTabs(prev => [...prev, {
      id: newTabId,
      title: saved.tab.title,
      color: saved.tab.color,
      root: newRoot,
      activeSessionId: findFirstSession(newRoot),
      savedTabId: saved.id,
    }]);
    setActiveTabId(newTabId);
  };

  /** Delete a saved tab snapshot from persistent storage. */
  const deleteSavedTab = async (savedTabId: string) => {
    const ipc = window.electron?.ipcRenderer;
    const readFn = (ipc as any)?.readSavedTabs || (() => ipc?.invoke("savedTabs.read"));
    const writeFn = (ipc as any)?.writeSavedTabs || ((d: any) => ipc?.invoke("savedTabs.write", d));
    try {
      const existing: SavedTab[] = (await readFn()) || [];
      const updated = existing.filter(t => t.id !== savedTabId);
      await writeFn(updated);
    } catch { /* best effort */ }
  };

  const activeSessionId = getActiveTab()?.activeSessionId || null;

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

  // Keyboard Shortcuts (customizable via hotkey system)
  const { hotkeys } = useConfig();
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesHotkey(e, hotkeys.newTab || "meta+t")) {
        e.preventDefault();
        createTab();
      }
      if (matchesHotkey(e, hotkeys.closeTab || "meta+w")) {
        e.preventDefault();
        closeActivePaneWithConfirm();
      }
      if (matchesHotkey(e, hotkeys.splitHorizontal || "meta+d")) {
        e.preventDefault();
        splitUserAction("horizontal");
      }
      if (matchesHotkey(e, hotkeys.splitVertical || "meta+shift+d")) {
        e.preventDefault();
        splitUserAction("vertical");
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
        updateSessionConfig,
        updateSession,
        markSessionDirty,
        updateSplitSizes,
        openSettingsTab,
        pendingSettingsSection,
        clearPendingSettingsSection,
        reorderTabs,
        focusSession,
        renameTab,
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
        setConfirmHandler,
        refreshCwd,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
};
