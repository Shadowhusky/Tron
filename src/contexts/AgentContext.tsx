import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  useMemo,
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
  /** Which element had focus last: "input" (SmartInput) or "terminal" (xterm). */
  focusTarget?: "input" | "terminal";
  /** Persisted scroll position (scrollTop px) for the agent panel. */
  scrollPosition?: number;
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

export interface CrossTabNotification {
  id: number;
  sessionId: string;
  message: string;
  timestamp: number;
}

class AgentStore {
  private states = new Map<string, AgentState>();
  private listeners = new Set<(sessionId: string | null) => void>();
  private abortControllers = new Map<string, AbortController>();
  public notifications: CrossTabNotification[] = [];
  private notifId = 0;
  private prevRunning = new Map<string, boolean>();
  public activeSessionIdForNotifs: string | null = null;
  private notificationListeners = new Set<() => void>();

  getSnapshot = () => this.states;

  getSessionSnapshot = (sessionId: string) => {
    return this.states.get(sessionId) || defaultState;
  }

  subscribeToSession = (sessionId: string) => (listener: () => void) => {
    const matchAll = sessionId === "";
    const wrapped = (changedId: string | null) => {
      if (matchAll || changedId === null || changedId === sessionId) {
        listener();
      }
    };
    this.listeners.add(wrapped);
    return () => { this.listeners.delete(wrapped); };
  }

  subscribeToNotifications = (listener: () => void) => {
    this.notificationListeners.add(listener);
    return () => { this.notificationListeners.delete(listener); };
  }

  private notify(sessionId: string | null) {
    for (const listener of this.listeners) {
      listener(sessionId);
    }
  }

  private notifyNotifications() {
    for (const listener of this.notificationListeners) {
      listener();
    }
  }

  setInitialStates(states: Map<string, AgentState>) {
    this.states = states;
    for (const [id, state] of states.entries()) {
      this.prevRunning.set(id, state.isAgentRunning);
    }
    this.notify(null);
  }

  updateState = (sessionId: string, updates: Partial<AgentState> | ((prev: AgentState) => Partial<AgentState>)) => {
    const current = this.states.get(sessionId) || defaultState;
    const changes = typeof updates === "function" ? updates(current) : updates;

    const keys = Object.keys(changes) as (keyof AgentState)[];
    if (keys.every((k) => current[k] === changes[k])) return;

    const next = { ...current, ...changes };
    const nextStates = new Map(this.states);
    nextStates.set(sessionId, next);
    this.states = nextStates;

    // Notification logic
    const wasRunning = this.prevRunning.get(sessionId) ?? false;
    const isRunning = next.isAgentRunning;
    if (wasRunning && !isRunning && sessionId !== this.activeSessionIdForNotifs) {
      const lastStep = next.agentThread[next.agentThread.length - 1];
      const msg = lastStep
        ? lastStep.step === "done" || lastStep.step === "success"
          ? `Agent completed: ${lastStep.output.slice(0, 80)}`
          : lastStep.step === "stopped"
            ? "Agent stopped"
            : lastStep.step === "error"
              ? `Agent error: ${lastStep.output.slice(0, 80)}`
              : "Agent finished"
        : "Agent finished";

      const id = ++this.notifId;
      this.notifications = [...this.notifications, { id, sessionId, message: msg, timestamp: Date.now() }];
      this.notifyNotifications();

      setTimeout(() => {
        this.dismissNotification(id);
      }, 8000);
    }
    this.prevRunning.set(sessionId, isRunning);

    this.notify(sessionId);
  }

  setAgentThread = (sessionId: string, threadOrUpdater: AgentStep[] | ((prev: AgentStep[]) => AgentStep[])) => {
    const current = this.states.get(sessionId) || defaultState;
    const newThread = typeof threadOrUpdater === "function" ? threadOrUpdater(current.agentThread) : threadOrUpdater;
    this.updateState(sessionId, { agentThread: newThread });
  }

  registerAbortController = (sessionId: string, controller: AbortController) => {
    const existing = this.abortControllers.get(sessionId);
    if (existing) {
      existing.abort();
    }
    this.abortControllers.set(sessionId, controller);
  }

  stopAgent = (sessionId: string) => {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }

    const current = this.states.get(sessionId) || defaultState;
    if (current.permissionResolve) {
      current.permissionResolve(false);
    }

    this.updateState(sessionId, {
      isAgentRunning: false,
      isThinking: false,
      pendingCommand: null,
      permissionResolve: null,
      isOverlayVisible: true,
      agentThread: (() => {
        const hadInflight = current.agentThread.some(
          (s) => s.step === "executing" || s.step === "streaming"
        );
        const cleaned = current.agentThread.map((s) =>
          s.step === "executing" || s.step === "streaming"
            ? { ...s, step: "stopped" as const }
            : s
        );
        return hadInflight
          ? cleaned
          : [...cleaned, { step: "stopped", output: "Stopped" }];
      })(),
    });
  }

  stopAllAgents = () => {
    for (const [sessionId, state] of this.states) {
      if (state.isAgentRunning) {
        this.stopAgent(sessionId);
      }
    }
  }

  resetSession = (sessionId: string) => {
    const nextStates = new Map(this.states);
    nextStates.delete(sessionId);
    this.states = nextStates;

    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
    this.notify(sessionId);
  }

  duplicateSession = (fromSessionId: string, toSessionId: string) => {
    const current = this.states.get(fromSessionId);
    if (!current) return;
    const nextStates = new Map(this.states);
    nextStates.set(toSessionId, {
      ...current,
      isAgentRunning: false,
      isThinking: false,
      pendingCommand: null,
      permissionResolve: null,
    });
    this.states = nextStates;
    this.notify(toSessionId);
  }

  dismissNotification = (id: number) => {
    this.notifications = this.notifications.filter((n) => n.id !== id);
    this.notifyNotifications();
  }
}

const AgentContext = createContext<AgentStore | null>(null);

type PersistedSession = { agentThread: AgentStep[]; overlayHeight?: number; draftInput?: string; thinkingEnabled?: boolean; scrollPosition?: number };

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
        thinkingEnabled: data.thinkingEnabled ?? defaultState.thinkingEnabled,
        scrollPosition: data.scrollPosition,
      });
    }
  }
  return map;
}

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
  const [store] = useState(() => new AgentStore());
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    loadPersistedAgentState().then((loaded) => {
      if (loaded.size > 0) {
        store.setInitialStates(loaded);
      }
      hasLoadedRef.current = true;
    });
  }, [store]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shared save function — serializes current state to file via IPC
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const serializable: Record<string, PersistedSession> = {};
    for (const [id, state] of store.getSnapshot()) {
      const hasThread = state.agentThread.length > 0;
      const hasDraft = !!state.draftInput;
      const hasHeight = typeof state.overlayHeight === "number";

      if (hasThread || hasDraft || hasHeight) {
        const persistableThread = state.agentThread.filter(
          (s) => s.step !== "thinking",
        );
        serializable[id] = {
          agentThread: persistableThread,
          ...(hasHeight ? { overlayHeight: state.overlayHeight } : {}),
          ...(hasDraft ? { draftInput: state.draftInput } : {}),
          thinkingEnabled: state.thinkingEnabled,
          ...(typeof state.scrollPosition === "number" ? { scrollPosition: state.scrollPosition } : {}),
        };
      }
    }
    window.electron?.ipcRenderer?.writeSessions(serializable).catch((e: unknown) => {
      console.warn("Failed to persist agent sessions:", e);
    });
  }, [store]);

  // Subscribe to ALL state changes (empty sessionId = wildcard) and debounce-save
  useEffect(() => {
    return store.subscribeToSession("")(() => {
      if (!hasLoadedRef.current) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushSave, 500);
    });
  }, [store, flushSave]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      store.stopAllAgents();
      // Flush save immediately — the IPC message is sent synchronously,
      // only the response is async, so it reaches the main process before unload.
      flushSave();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    let cleanupIpc: (() => void) | undefined;
    if (window.electron?.ipcRenderer?.on) {
      cleanupIpc = window.electron.ipcRenderer.on(
        IPC.WINDOW_CONFIRM_CLOSE,
        () => {
          store.stopAllAgents();
          flushSave();
        },
      );
    }

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      cleanupIpc?.();
    };
  }, [store, flushSave]);

  return (
    <AgentContext.Provider value={store}>
      {children}
    </AgentContext.Provider>
  );
};

export { AgentContext };

export const useAgentContext = () => {
  const store = useContext(AgentContext);
  if (!store) throw new Error("useAgentContext must be used within an AgentProvider");

  const notifications = useSyncExternalStore(
    store.subscribeToNotifications,
    () => store.notifications
  );

  // We memoize stable callbacks
  const dismissNotification = useCallback((id: number) => {
    store.dismissNotification(id);
  }, [store]);

  const setActiveSessionForNotifications = useCallback((sessionId: string | null) => {
    store.activeSessionIdForNotifs = sessionId;
  }, [store]);

  return {
    crossTabNotifications: notifications,
    dismissNotification,
    setActiveSessionForNotifications,
    duplicateAgentSession: store.duplicateSession,
  };
};

export const useAgent = (sessionId: string) => {
  const store = useContext(AgentContext);
  if (!store) {
    throw new Error("useAgent must be used within an AgentProvider");
  }

  const subscribe = useCallback((onStoreChange: () => void) => {
    return store.subscribeToSession(sessionId)(onStoreChange);
  }, [store, sessionId]);

  const state = useSyncExternalStore(
    subscribe,
    () => store.getSessionSnapshot(sessionId)
  );

  return useMemo(() => ({
    ...state,
    setAgentThread: (thread: AgentStep[] | ((prev: AgentStep[]) => AgentStep[])) => store.setAgentThread(sessionId, thread),
    setIsAgentRunning: (isRunning: boolean) => store.updateState(sessionId, { isAgentRunning: isRunning }),
    setIsThinking: (isThinking: boolean) => store.updateState(sessionId, { isThinking }),
    setPendingCommand: (cmd: string | null) => store.updateState(sessionId, { pendingCommand: cmd }),
    setPermissionResolve: (resolve: ((allowed: boolean) => void) | null) => store.updateState(sessionId, { permissionResolve: resolve }),
    setAlwaysAllowSession: (allow: boolean) => store.updateState(sessionId, { alwaysAllowSession: allow }),
    isOverlayVisible: state.isOverlayVisible,
    setIsOverlayVisible: (visible: boolean) => store.updateState(sessionId, { isOverlayVisible: visible }),
    overlayHeight: state.overlayHeight,
    setOverlayHeight: (height: number | undefined) => store.updateState(sessionId, { overlayHeight: height }),
    draftInput: state.draftInput,
    setDraftInput: (text: string | undefined) => store.updateState(sessionId, { draftInput: text }),
    thinkingEnabled: state.thinkingEnabled,
    setThinkingEnabled: (enabled: boolean) => store.updateState(sessionId, { thinkingEnabled: enabled }),
    focusTarget: state.focusTarget,
    setFocusTarget: (target: "input" | "terminal") => store.updateState(sessionId, { focusTarget: target }),
    scrollPosition: state.scrollPosition,
    setScrollPosition: (pos: number | undefined) => store.updateState(sessionId, { scrollPosition: pos }),
    registerAbortController: (controller: AbortController) => store.registerAbortController(sessionId, controller),
    stopAgent: () => store.stopAgent(sessionId),
    resetSession: () => store.resetSession(sessionId),
  }), [state, store, sessionId]);
};
