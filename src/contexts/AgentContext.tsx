import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { AgentStep } from "../types";
import { IPC } from "../constants/ipc";

interface AgentState {
  agentThread: AgentStep[];
  isAgentRunning: boolean;
  isThinking: boolean;
  pendingCommand: string | null;
  permissionResolve: ((allowed: boolean) => void) | null;
  alwaysAllowSession: boolean;
  isOverlayVisible: boolean;
  thinkingEnabled: boolean;
  /** Custom overlay height (px) set by drag resize. undefined = default (50vh). */
  overlayHeight?: number;
  /** Draft input text preserved across tab switches. */
  draftInput?: string;
}

const defaultState: AgentState = {
  agentThread: [],
  isAgentRunning: false,
  isThinking: false,
  pendingCommand: null,
  permissionResolve: null,
  alwaysAllowSession: false,
  isOverlayVisible: false,
  thinkingEnabled: true,
};

interface AgentContextType {
  getAgentState: (sessionId: string) => AgentState;
  updateAgentState: (sessionId: string, updates: Partial<AgentState>) => void;
  // Helpers
  setAgentThread: (
    sessionId: string,
    thread: AgentStep[] | ((prev: AgentStep[]) => AgentStep[]),
  ) => void;
  setIsAgentRunning: (sessionId: string, isRunning: boolean) => void;
  setIsThinking: (sessionId: string, isThinking: boolean) => void;
  setPendingCommand: (sessionId: string, cmd: string | null) => void;
  setPermissionResolve: (
    sessionId: string,
    resolve: ((allowed: boolean) => void) | null,
  ) => void;
  setAlwaysAllowSession: (sessionId: string, allow: boolean) => void;
  setIsOverlayVisible: (sessionId: string, visible: boolean) => void;
  setThinkingEnabled: (sessionId: string, enabled: boolean) => void;
  // Abort Control
  registerAbortController: (
    sessionId: string,
    controller: AbortController,
  ) => void;
  stopAgent: (sessionId: string) => void;
  resetSession: (sessionId: string) => void;
  // Cross-tab notifications
  crossTabNotifications: CrossTabNotification[];
  dismissNotification: (id: number) => void;
  setActiveSessionForNotifications: (sessionId: string | null) => void;
}

export interface CrossTabNotification {
  id: number;
  sessionId: string;
  message: string;
  timestamp: number;
}

const AgentContext = createContext<AgentContextType | null>(null);

type PersistedSession = { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string };

/** Parse raw persisted data into an AgentState Map */
function parsePersistedData(parsed: Record<string, PersistedSession>): Map<string, AgentState> {
  const map = new Map<string, AgentState>();
  const transientSteps = new Set(["thinking", "streaming", "executing"]);

  for (const [id, data] of Object.entries(parsed)) {
    const hasThread = data.agentThread?.length > 0;
    const hasDraft = !!data.draftInput;
    const hasHeight = typeof data.overlayHeight === "number";

    if (hasThread || hasDraft || hasHeight) {
      let wasInterrupted = false;
      const cleanedThread = (data.agentThread || []).filter((s) => {
        if (transientSteps.has(s.step)) {
          wasInterrupted = true;
          return false;
        }
        return true;
      });

      if (wasInterrupted && cleanedThread.length > 0) {
        cleanedThread.push({
          step: "stopped",
          output: "Aborted (page was refreshed)",
        });
      }

      map.set(id, {
        ...defaultState,
        agentThread: cleanedThread,
        isOverlayVisible: cleanedThread.length > 0,
        overlayHeight: data.overlayHeight,
        draftInput: data.draftInput,
      });
    }
  }
  return map;
}

/** Load persisted agent sessions from file via IPC */
async function loadPersistedAgentState(): Promise<Map<string, AgentState>> {
  try {
    const saved = await window.electron?.ipcRenderer?.readSessions();
    if (saved) return parsePersistedData(saved as Record<string, PersistedSession>);
  } catch (e) {
    console.warn("Failed to load persisted agent state from file:", e);
  }
  return new Map();
}

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [agentStates, setAgentStates] = useState<Map<string, AgentState>>(
    () => new Map(),
  );

  // Store abort controllers in ref since they aren't needed for rendering
  // and we want exact instance control
  const abortControllers = React.useRef<Map<string, AbortController>>(
    new Map(),
  );

  // Track whether initial load from file has completed (skip saving until loaded)
  const hasLoadedRef = useRef(false);

  // Load persisted state from file on mount
  useEffect(() => {
    loadPersistedAgentState().then((loaded) => {
      if (loaded.size > 0) {
        setAgentStates(loaded);
      }
      hasLoadedRef.current = true;
    });
  }, []);

  // Persist agent state to file via IPC (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Don't save until initial load completes (would overwrite file with empty data)
    if (!hasLoadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const serializable: Record<string, PersistedSession> = {};
      for (const [id, state] of agentStates) {
        const hasThread = state.agentThread.length > 0;
        const hasDraft = !!state.draftInput;
        const hasHeight = typeof state.overlayHeight === "number";

        if (hasThread || hasDraft || hasHeight) {
          // Only persist completed steps, not transient ones like "thinking"
          const persistableThread = state.agentThread.filter(
            (s) => s.step !== "thinking",
          );
          serializable[id] = {
            agentThread: persistableThread,
            ...(hasHeight ? { overlayHeight: state.overlayHeight } : {}),
            ...(hasDraft ? { draftInput: state.draftInput } : {}),
          };
        }
      }
      window.electron?.ipcRenderer?.writeSessions(serializable).catch((e: unknown) => {
        console.warn("Failed to persist agent sessions:", e);
      });
    }, 500); // 500ms debounce to avoid thrashing during streaming
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [agentStates]);

  const getAgentState = useCallback(
    (sessionId: string) => {
      return agentStates.get(sessionId) || defaultState;
    },
    [agentStates],
  );

  const updateAgentState = useCallback(
    (sessionId: string, updates: Partial<AgentState>) => {
      setAgentStates((prev) => {
        const current = prev.get(sessionId) || defaultState;
        // Bail early if no values actually changed — React skips re-render
        const keys = Object.keys(updates) as (keyof AgentState)[];
        if (keys.every((k) => current[k] === updates[k])) return prev;
        const next = new Map(prev);
        next.set(sessionId, { ...current, ...updates });
        return next;
      });
    },
    [],
  );

  // Helper wrappers
  const setAgentThread = useCallback(
    (
      sessionId: string,
      threadOrUpdater: AgentStep[] | ((prev: AgentStep[]) => AgentStep[]),
    ) => {
      setAgentStates((prev) => {
        const current = prev.get(sessionId) || defaultState;
        const newThread =
          typeof threadOrUpdater === "function"
            ? threadOrUpdater(current.agentThread)
            : threadOrUpdater;
        // Bail early if updater returned same reference — React skips re-render
        if (newThread === current.agentThread) return prev;
        const next = new Map(prev);
        next.set(sessionId, { ...current, agentThread: newThread });
        return next;
      });
    },
    [],
  );

  const setIsAgentRunning = useCallback(
    (sessionId: string, isRunning: boolean) => {
      updateAgentState(sessionId, { isAgentRunning: isRunning });
    },
    [updateAgentState],
  );

  const setIsThinking = useCallback(
    (sessionId: string, isThinking: boolean) => {
      updateAgentState(sessionId, { isThinking });
    },
    [updateAgentState],
  );

  const setPendingCommand = useCallback(
    (sessionId: string, cmd: string | null) => {
      updateAgentState(sessionId, { pendingCommand: cmd });
    },
    [updateAgentState],
  );

  const setPermissionResolve = useCallback(
    (sessionId: string, resolve: ((allowed: boolean) => void) | null) => {
      updateAgentState(sessionId, { permissionResolve: resolve });
    },
    [updateAgentState],
  );

  const setAlwaysAllowSession = useCallback(
    (sessionId: string, allow: boolean) => {
      updateAgentState(sessionId, { alwaysAllowSession: allow });
    },
    [updateAgentState],
  );

  const setIsOverlayVisible = useCallback(
    (sessionId: string, visible: boolean) => {
      updateAgentState(sessionId, { isOverlayVisible: visible });
    },
    [updateAgentState],
  );

  const setThinkingEnabled = useCallback(
    (sessionId: string, enabled: boolean) => {
      updateAgentState(sessionId, { thinkingEnabled: enabled });
    },
    [updateAgentState],
  );

  const registerAbortController = useCallback(
    (sessionId: string, controller: AbortController) => {
      const existing = abortControllers.current.get(sessionId);
      if (existing) {
        existing.abort(); // Ensure old one is dead
      }
      abortControllers.current.set(sessionId, controller);
    },
    [],
  );

  const stopAgent = useCallback((sessionId: string) => {
    const controller = abortControllers.current.get(sessionId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(sessionId);
    }
    // Resolve any pending permission promise so the agent loop unblocks
    setAgentStates((prev) => {
      const current = prev.get(sessionId) || defaultState;
      if (current.permissionResolve) {
        current.permissionResolve(false);
      }
      const next = new Map(prev);
      next.set(sessionId, {
        ...current,
        isAgentRunning: false,
        isThinking: false,
        pendingCommand: null,
        permissionResolve: null,
        isOverlayVisible: true, // Keep panel visible so user can see abort result
        agentThread: (() => {
          const hadInflight = current.agentThread.some(
            (s) => s.step === "executing" || s.step === "streaming"
          );
          const cleaned = current.agentThread.map((s) =>
            s.step === "executing" || s.step === "streaming"
              ? { ...s, step: "stopped" as const }
              : s
          );
          // Only append explicit "Stopped" if no in-flight steps were converted
          return hadInflight
            ? cleaned
            : [...cleaned, { step: "stopped", output: "Stopped" }];
        })(),
      });
      return next;
    });
  }, []);

  // Stop ALL running agents (used on refresh / window close)
  const stopAllAgents = useCallback(() => {
    for (const [sessionId, state] of agentStates) {
      if (state.isAgentRunning) {
        stopAgent(sessionId);
      }
    }
  }, [agentStates, stopAgent]);

  // Abort running agents on page refresh or Electron window close
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Synchronously abort all controllers — stopAgent uses setState
      // which won't commit during unload, but aborting the controllers
      // is the critical part to cancel in-flight requests.
      for (const [, controller] of abortControllers.current) {
        controller.abort();
      }
      abortControllers.current.clear();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    // Also stop agents when the Electron close confirmation fires
    let cleanupIpc: (() => void) | undefined;
    if (window.electron?.ipcRenderer?.on) {
      cleanupIpc = window.electron.ipcRenderer.on(
        IPC.WINDOW_CONFIRM_CLOSE,
        () => {
          stopAllAgents();
        },
      );
    }

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      cleanupIpc?.();
    };
  }, [stopAllAgents]);

  const resetSession = useCallback((sessionId: string) => {
    setAgentStates((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
    // Also clear abort controller
    const controller = abortControllers.current.get(sessionId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(sessionId);
    }
  }, []);

  // --- Cross-tab notifications ---
  const [crossTabNotifications, setCrossTabNotifications] = useState<CrossTabNotification[]>([]);
  const notifIdRef = useRef(0);
  // Track previous isAgentRunning for each session to detect transitions
  const prevRunningRef = useRef<Map<string, boolean>>(new Map());

  // Inject activeSessionId from LayoutContext via a prop or by reading it directly
  // We'll use a ref that App.tsx can update
  const activeSessionIdRef = useRef<string | null>(null);

  // Watch for agent completion on non-active sessions
  useEffect(() => {
    for (const [sessionId, state] of agentStates) {
      const wasRunning = prevRunningRef.current.get(sessionId) ?? false;
      const isRunning = state.isAgentRunning;

      // Detect transition: was running → now stopped
      if (wasRunning && !isRunning && sessionId !== activeSessionIdRef.current) {
        // Find the last "done"/"error"/"stopped" step for the message
        const lastStep = state.agentThread[state.agentThread.length - 1];
        const msg = lastStep
          ? lastStep.step === "done" || lastStep.step === "success"
            ? `Agent completed: ${lastStep.output.slice(0, 80)}`
            : lastStep.step === "stopped"
              ? "Agent stopped"
              : lastStep.step === "error"
                ? `Agent error: ${lastStep.output.slice(0, 80)}`
                : "Agent finished"
          : "Agent finished";

        const id = ++notifIdRef.current;
        setCrossTabNotifications((prev) => [...prev, { id, sessionId, message: msg, timestamp: Date.now() }]);

        // Auto-dismiss after 8 seconds
        setTimeout(() => {
          setCrossTabNotifications((prev) => prev.filter((n) => n.id !== id));
        }, 8000);
      }

      prevRunningRef.current.set(sessionId, isRunning);
    }
  }, [agentStates]);

  const dismissNotification = useCallback((id: number) => {
    setCrossTabNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // Expose activeSessionId setter for App.tsx to call
  const setActiveSessionForNotifications = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  return (
    <AgentContext.Provider
      value={{
        getAgentState,
        updateAgentState,
        setAgentThread,
        setIsAgentRunning,
        setIsThinking,
        setPendingCommand,
        setPermissionResolve,
        setAlwaysAllowSession,
        setIsOverlayVisible,
        setThinkingEnabled,
        registerAbortController,
        stopAgent,
        resetSession,
        crossTabNotifications,
        dismissNotification,
        setActiveSessionForNotifications,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}; // End AgentProvider

// Export Context for LayoutProvider usage
export { AgentContext };

/** Access global agent context (cross-tab notifications, etc.) */
export const useAgentContext = () => {
  const context = useContext(AgentContext);
  if (!context) throw new Error("useAgentContext must be used within an AgentProvider");
  return context;
};

export const useAgent = (sessionId: string) => {
  const context = useContext(AgentContext);
  if (!context) {
    throw new Error("useAgent must be used within an AgentProvider");
  }

  const state = context.getAgentState(sessionId);

  return {
    ...state,
    setAgentThread: (
      thread: AgentStep[] | ((prev: AgentStep[]) => AgentStep[]),
    ) => context.setAgentThread(sessionId, thread),
    setIsAgentRunning: (isRunning: boolean) =>
      context.setIsAgentRunning(sessionId, isRunning),
    setIsThinking: (isThinking: boolean) =>
      context.setIsThinking(sessionId, isThinking),
    setPendingCommand: (cmd: string | null) =>
      context.setPendingCommand(sessionId, cmd),
    setPermissionResolve: (resolve: ((allowed: boolean) => void) | null) =>
      context.setPermissionResolve(sessionId, resolve),
    setAlwaysAllowSession: (allow: boolean) =>
      context.setAlwaysAllowSession(sessionId, allow),
    // Overlay Visibility
    isOverlayVisible: state.isOverlayVisible,
    setIsOverlayVisible: (visible: boolean) =>
      context.updateAgentState(sessionId, { isOverlayVisible: visible }),

    // Overlay Height (drag resize)
    overlayHeight: state.overlayHeight,
    setOverlayHeight: (height: number | undefined) =>
      context.updateAgentState(sessionId, { overlayHeight: height }),

    // Draft Input
    draftInput: state.draftInput,
    setDraftInput: (text: string | undefined) =>
      context.updateAgentState(sessionId, { draftInput: text }),

    // Thinking
    thinkingEnabled: state.thinkingEnabled,
    setThinkingEnabled: (enabled: boolean) =>
      context.setThinkingEnabled(sessionId, enabled),

    // Abort
    registerAbortController: (controller: AbortController) =>
      context.registerAbortController(sessionId, controller),
    stopAgent: () => context.stopAgent(sessionId),
    resetSession: () => context.resetSession(sessionId),
  };
};
