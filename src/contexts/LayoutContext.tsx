import React, { createContext, useContext, useState, useEffect } from "react";
import type {
  LayoutNode,
  Tab,
  TerminalSession,
  SplitDirection,
  AIConfig,
} from "../types";
import { aiService } from "../services/ai";
import { STORAGE_KEYS } from "../constants/storage";
import { IPC } from "../constants/ipc";

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
  markSessionDirty: (sessionId: string) => void;
  updateSplitSizes: (path: number[], sizes: number[]) => void;
  openSettingsTab: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  focusSession: (sessionId: string) => void;
  isHydrated: boolean;
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

  // Helper: Create a new PTY and return its ID
  const createPTY = async (
    cwd?: string,
    reconnectId?: string,
  ): Promise<string> => {
    if (window.electron) {
      return await window.electron.ipcRenderer.invoke(IPC.TERMINAL_CREATE, {
        cols: 80,
        rows: 30,
        cwd,
        reconnectId,
      });
    } else {
      console.warn("Mocking PTY creation");
      return `mock-${uuid()}`;
    }
  };

  // Persistence Logic
  useEffect(() => {
    if (tabs.length > 0) {
      const state = {
        tabs,
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
      };
      localStorage.setItem(STORAGE_KEYS.LAYOUT, JSON.stringify(state));
    }
  }, [tabs, activeTabId, sessions]);

  // Hydration / Initialization
  useEffect(() => {
    const init = async () => {
      const saved = localStorage.getItem(STORAGE_KEYS.LAYOUT);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          const savedTabs: Tab[] = parsed.tabs;
          const savedCwds: Record<string, string> = parsed.sessionCwds || {};

          console.log("Hydrating layout...", savedTabs);

          if (savedTabs.length === 0) {
            createTab();
            return;
          }

          const newSessions = new Map<string, TerminalSession>();
          const regeneratedTabs: Tab[] = [];

          for (const tab of savedTabs) {
            // Recursively regenerate sessions for this tab
            const regenerateNode = async (
              node: LayoutNode,
            ): Promise<LayoutNode> => {
              if (node.type === "leaf") {
                // If settings node, just restore
                if (node.contentType === "settings") {
                  return node;
                }

                // Found a session — try to reconnect to existing PTY, else create new
                const oldId = node.sessionId;
                const cwd = savedCwds[oldId];
                const aiConfig = (parsed.sessionConfigs || {})[oldId];
                const interactions = (parsed.sessionInteractions || {})[oldId];
                const summaryConstant = (parsed.sessionSummaries || {})[oldId];

                const newId = await createPTY(cwd, oldId);
                const reconnected = newId === oldId;
                if (reconnected) {
                  console.log(`Reconnected to PTY session: ${oldId}`);
                }
                const config = aiConfig || aiService.getConfig();
                newSessions.set(newId, {
                  id: newId,
                  title: "Terminal",
                  cwd,
                  aiConfig: config,
                  interactions: interactions || [],
                  contextSummary: summaryConstant?.summary,
                  contextSummarySourceLength: summaryConstant?.sourceLength,
                });
                return { ...node, sessionId: newId };
              } else {
                const newChildren = await Promise.all(
                  node.children.map((c) => regenerateNode(c)),
                );
                return { ...node, children: newChildren };
              }
            };

            const newRoot = await regenerateNode(tab.root);

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

          setSessions(newSessions);
          setTabs(regeneratedTabs);
          setActiveTabId(parsed.activeTabId || regeneratedTabs[0].id);
          return;
        } catch (e) {
          console.error("Failed to hydrate state:", e);
          localStorage.removeItem(STORAGE_KEYS.LAYOUT);
        }
      }

      // Fallback if no save or error
      createTab();
    };

    // Run once
    init().finally(() => setIsHydrated(true));
  }, []);

  const [isHydrated, setIsHydrated] = useState(false);

  const createTab = async () => {
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

  const openSettingsTab = () => {
    // Check if open
    const existing = tabs.find(
      (t) => t.root.type === "leaf" && t.root.contentType === "settings",
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const newTabId = uuid();
    const newTab: Tab = {
      id: newTabId,
      title: "Settings",
      root: { type: "leaf", sessionId: "settings", contentType: "settings" },
      activeSessionId: "settings",
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
  };

  const closeTab = (tabId: string) => {
    // Find tab to close
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
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
      if (tabId === activeTabId && newTabs.length > 0) {
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
    if (sessionId === "settings") return; // settings is pseudo-session

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

  const activeSessionId = getActiveTab()?.activeSessionId || null;

  // Poll CWD for the active session every 1 second
  useEffect(() => {
    if (!activeSessionId || activeSessionId === "settings" || !window.electron)
      return;

    const pollCwd = async () => {
      try {
        const cwd = await window.electron.ipcRenderer.getCwd(activeSessionId);
        // console.log('Parsed CWD:', cwd); // Debug logging
        if (cwd) {
          updateSessionCwd(activeSessionId, cwd);
        }
      } catch (e) {
        console.warn("Error polling CWD:", e);
      }
    };

    // Poll immediately, then on interval
    pollCwd();
    const interval = setInterval(pollCwd, 1000);
    return () => clearInterval(interval);
  }, [activeSessionId]);

  // Close pane with confirmation — skips confirm for settings or new (non-dirty) sessions
  const closeActivePaneWithConfirm = () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (tab.root.type === "leaf" && tab.root.contentType === "settings") {
      closeActivePane();
      return;
    }
    const session = sessions.get(tab.activeSessionId || "");
    if (!session?.dirty || window.confirm("Close this terminal session?")) {
      closeActivePane();
    }
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      // Cmd/Ctrl + T: New Tab
      if ((e.metaKey || e.ctrlKey) && key === "t") {
        e.preventDefault();
        createTab();
      }
      // Cmd/Ctrl + W: Close Pane (with confirmation for dirty sessions)
      if ((e.metaKey || e.ctrlKey) && key === "w") {
        e.preventDefault();
        closeActivePaneWithConfirm();
      }
      // Cmd/Ctrl + D: Split Horizontal (Side-by-side)
      if ((e.metaKey || e.ctrlKey) && key === "d" && !e.shiftKey) {
        e.preventDefault();
        splitUserAction("horizontal");
      }
      // Cmd/Ctrl + Shift + D: Split Vertical (Stacked)
      if ((e.metaKey || e.ctrlKey) && key === "d" && e.shiftKey) {
        e.preventDefault();
        splitUserAction("vertical");
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    // Handle Menu IPC
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
  }, [tabs, activeTabId, sessions, closeActivePane, createTab]);

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
        reorderTabs,
        focusSession,
        addInteraction,
        isHydrated,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
};
