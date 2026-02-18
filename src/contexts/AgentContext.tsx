import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { AgentStep } from "../types";
import { STORAGE_KEYS } from "../constants/storage";
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
}

const AgentContext = createContext<AgentContextType | null>(null);

/** Load persisted agent threads from localStorage */
function loadPersistedAgentState(): Map<string, AgentState> {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.AGENT_STATE);
    if (saved) {
      const parsed: Record<string, { agentThread: AgentStep[] }> =
        JSON.parse(saved);
      const map = new Map<string, AgentState>();
      for (const [id, data] of Object.entries(parsed)) {
        if (data.agentThread?.length > 0) {
          // Clean up in-progress steps that indicate the agent was interrupted
          // (e.g. by a page refresh while running)
          const transientSteps = new Set([
            "thinking",
            "streaming",
            "executing",
          ]);
          let wasInterrupted = false;
          const cleanedThread = data.agentThread.filter((s) => {
            if (transientSteps.has(s.step)) {
              wasInterrupted = true;
              return false;
            }
            return true;
          });

          // If the agent was mid-run when interrupted, add an aborted marker
          if (wasInterrupted && cleanedThread.length > 0) {
            cleanedThread.push({
              step: "stopped",
              output: "Aborted (page was refreshed)",
            });
          }

          if (cleanedThread.length > 0) {
            map.set(id, {
              ...defaultState,
              agentThread: cleanedThread,
              isOverlayVisible: true,
            });
          }
        }
      }
      return map;
    }
  } catch (e) {
    console.warn("Failed to load persisted agent state:", e);
  }
  return new Map();
}

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [agentStates, setAgentStates] = useState<Map<string, AgentState>>(() =>
    loadPersistedAgentState(),
  );

  // Store abort controllers in ref since they aren't needed for rendering
  // and we want exact instance control
  const abortControllers = React.useRef<Map<string, AbortController>>(
    new Map(),
  );

  // Persist agent threads to localStorage (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const serializable: Record<string, { agentThread: AgentStep[] }> = {};
      for (const [id, state] of agentStates) {
        if (state.agentThread.length > 0) {
          // Only persist completed steps, not transient ones like "thinking"
          const persistableThread = state.agentThread.filter(
            (s) => s.step !== "thinking",
          );
          if (persistableThread.length > 0) {
            serializable[id] = { agentThread: persistableThread };
          }
        }
      }
      localStorage.setItem(
        STORAGE_KEYS.AGENT_STATE,
        JSON.stringify(serializable),
      );
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
        const next = new Map(prev);
        const current = next.get(sessionId) || defaultState;
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
        const next = new Map(prev);
        const current = next.get(sessionId) || defaultState;
        const newThread =
          typeof threadOrUpdater === "function"
            ? threadOrUpdater(current.agentThread)
            : threadOrUpdater;
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
        agentThread: [
          ...current.agentThread,
          { step: "stopped", output: "Stopped" },
        ],
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
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}; // End AgentProvider

// Export Context for LayoutProvider usage
export { AgentContext };

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
