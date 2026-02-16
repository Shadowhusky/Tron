import React, { createContext, useContext, useState, useEffect } from "react";
import type {
  LayoutNode,
  Tab,
  TerminalSession,
  SplitDirection,
  AIConfig,
} from "../types";
import { aiService } from "../services/ai";

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
  registerSession: (id: string) => void;
  updateSessionConfig: (sessionId: string, config: Partial<AIConfig>) => void;
  openSettingsTab: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
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
  const createPTY = async (cwd?: string): Promise<string> => {
    if (window.electron) {
      return await window.electron.ipcRenderer.invoke("terminal.create", {
        cols: 80,
        rows: 30,
        cwd,
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
      };
      localStorage.setItem("tron_layout_v1", JSON.stringify(state));
    }
  }, [tabs, activeTabId, sessions]);

  // Hydration / Initialization
  useEffect(() => {
    const init = async () => {
      const saved = localStorage.getItem("tron_layout_v1");
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

                // Found a session, recreate process
                const oldId = node.sessionId;
                const cwd = savedCwds[oldId];
                const aiConfig = (parsed.sessionConfigs || {})[oldId];
                const newId = await createPTY(cwd);
                // Restore config if available, else default
                const config = aiConfig || aiService.getConfig();
                newSessions.set(newId, {
                  id: newId,
                  title: "Terminal",
                  cwd,
                  aiConfig: config,
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
          localStorage.removeItem("tron_layout_v1");
        }
      }

      // Fallback if no save or error
      createTab();
    };

    // Run once
    init();
  }, []);

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
    const defaultConfig = aiService.getConfig();
    setSessions((prev) =>
      new Map(prev).set(newSessionId, {
        id: newSessionId,
        title: "Terminal",
        cwd,
        aiConfig: defaultConfig,
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

  // Called when xterm connects or session is valid
  const registerSession = () => {
    // already handled in create methods for now
  };

  const closeSession = (sessionId: string) => {
    if (sessionId === "settings") return; // settings is pseudo-session

    if (window.electron) {
      window.electron.ipcRenderer.send("terminal.close", sessionId);
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

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + T: New Tab
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        createTab();
      }
      // Cmd/Ctrl + W: Close Pane (with confirmation)
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        const tab = tabs.find((t) => t.id === activeTabId);
        if (
          tab?.root.type === "leaf" &&
          tab.root.contentType === "settings"
        ) {
          closeActivePane();
        } else if (window.confirm("Close this terminal session?")) {
          closeActivePane();
        }
      }
      // Cmd/Ctrl + D: Split Horizontal (Side-by-side)
      if ((e.metaKey || e.ctrlKey) && e.key === "d" && !e.shiftKey) {
        e.preventDefault();
        splitUserAction("horizontal");
      }
      // Cmd/Ctrl + Shift + D: Split Vertical (Stacked)
      if ((e.metaKey || e.ctrlKey) && e.key === "d" && e.shiftKey) {
        e.preventDefault();
        splitUserAction("vertical");
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    // Handle Menu IPC
    if (window.electron) {
      const removeCloseListener = window.electron.ipcRenderer.on(
        "menu.closeTab",
        () => {
          closeActivePane();
        },
      );
      const removeCreateListener = window.electron.ipcRenderer.on(
        "menu.createTab",
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
  }, [tabs, activeTabId, activeSessionId, closeActivePane, createTab]);

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
        registerSession,
        updateSessionConfig,
        openSettingsTab,
        reorderTabs,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
};
