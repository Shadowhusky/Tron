/**
 * Remote Bridge — manages WebSocket connections to remote Tron servers.
 *
 * When a remote terminal session is created, all IPC calls for that session
 * are routed through the remote server's WebSocket instead of the local one.
 * The Terminal component works unchanged — routing is transparent.
 *
 * Includes heartbeat (ping/pong) for zombie detection and auto-reconnect
 * with exponential backoff when the connection drops.
 */

type Listener = (...args: any[]) => void;

interface PendingInvoke {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type RemoteConnectionState = "connected" | "reconnecting" | "disconnected";

interface HealthCheckWaiter {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RemoteConnection {
  private ws: WebSocket | null = null;
  private connected = false;
  private wasEverConnected = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastMessageTime = 0;
  private pendingInvokes = new Map<string, PendingInvoke>();
  private eventListeners = new Map<string, Set<Listener>>();
  private messageQueue: string[] = [];
  private _stateListeners = new Set<(state: RemoteConnectionState) => void>();
  private healthCheckWaiters = new Set<HealthCheckWaiter>();
  readonly url: string;
  /** Persistent token reused across reconnections so the server maps the new WS to the same client. */
  private readonly clientToken: string;

  private static AGGRESSIVE_ATTEMPTS = 8;
  private static PATIENT_INTERVAL_MS = 30_000;
  private static HEARTBEAT_MS = 30_000;
  private static HEARTBEAT_TIMEOUT_MS = 10_000;

  constructor(url: string) {
    this.url = url;
    this.clientToken = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ---- WebSocket URL ----

  private buildWsUrl(): string {
    const wsProto = this.url.startsWith("https") ? "wss:" : "ws:";
    const host = new URL(this.url).host;
    return `${wsProto}//${host}/ws?token=${this.clientToken}`;
  }

  // ---- Connect ----

  connect(): Promise<void> {
    this.intentionalClose = false;
    return new Promise((resolve, reject) => {
      this.createWs(resolve, reject);
    });
  }

  /**
   * Creates a new WebSocket and wires up all event handlers.
   * Used for both initial connection and reconnection.
   *
   * @param onReady  Called once when the server sends the "mode" message (initial connect resolves here).
   * @param onFail   Called if the WS fails before connecting (initial connect rejects here).
   */
  private createWs(onReady?: () => void, onFail?: (err: Error) => void): void {
    let wsUrl: string;
    try {
      wsUrl = this.buildWsUrl();
    } catch {
      onFail?.(new Error(`Invalid URL: ${this.url}`));
      return;
    }

    this.ws = new WebSocket(wsUrl);

    // Connection timeout (only for initial connect — reconnect has its own backoff)
    const connectTimeout = onFail
      ? setTimeout(() => {
          onFail(new Error(`Connection timeout: ${this.url}`));
          this.ws?.close();
        }, 10_000)
      : null;

    this.ws.onopen = () => {
      if (connectTimeout) clearTimeout(connectTimeout);
      this.connected = true;
      this.wasEverConnected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      // Flush queued messages
      while (this.messageQueue.length > 0) {
        this.ws!.send(this.messageQueue.shift()!);
      }
      // Don't resolve yet — wait for the mode message from server
    };

    let modeReceived = false;
    this.ws.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }

      // Track last message time for backward-compatible heartbeat
      this.lastMessageTime = Date.now();
      this.resolveHealthChecks(true);

      if (msg.type === "mode") {
        if (!modeReceived) {
          modeReceived = true;
          if (onReady) {
            onReady();
          } else {
            // Reconnection — notify listeners
            console.log("[Remote] Reconnected to", this.url);
            this.notifyState("connected");
          }
        }
        return;
      }

      if (msg.type === "pong") {
        // Heartbeat response — connection is alive
        if (this.heartbeatTimeout) {
          clearTimeout(this.heartbeatTimeout);
          this.heartbeatTimeout = null;
        }
        return;
      }

      if (msg.type === "invoke-response") {
        const pending = this.pendingInvokes.get(msg.id);
        if (pending) {
          this.pendingInvokes.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.type === "event") {
        const listeners = this.eventListeners.get(msg.channel);
        if (listeners) {
          for (const fn of listeners) {
            fn(msg.data);
          }
        }
      }
    };

    this.ws.onclose = () => {
      if (connectTimeout) clearTimeout(connectTimeout);
      this.connected = false;
      this.stopHeartbeat();
      // Reject all pending invokes so callers don't hang
      for (const [id, pending] of this.pendingInvokes) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Remote connection closed: ${this.url}`));
        this.pendingInvokes.delete(id);
      }
      // Clear stale queued messages (their corresponding invokes are rejected)
      this.messageQueue.length = 0;

      if (!this.intentionalClose && this.wasEverConnected) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      if (connectTimeout) clearTimeout(connectTimeout);
      if (!this.connected && onFail) {
        onFail(new Error(`Failed to connect to remote server: ${this.url}`));
      }
    };
  }

  // ---- Heartbeat ----

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const pingTime = Date.now();
      try { this.ws.send(JSON.stringify({ type: "ping" })); } catch { return; }
      this.heartbeatTimeout = setTimeout(() => {
        this.heartbeatTimeout = null;
        // Backward-compatible: if ANY message was received since the ping
        // (invoke-response, event, pong), the connection is alive — even if
        // the server doesn't support pong (older version).
        if (this.lastMessageTime >= pingTime) return;
        // No messages at all since ping — connection is dead
        console.warn("[Remote] Heartbeat timeout for", this.url);
        this.forceReconnect();
      }, RemoteConnection.HEARTBEAT_TIMEOUT_MS);
    }, RemoteConnection.HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = null; }
  }

  // ---- Reconnect ----

  /**
   * Force-close the current WS and trigger reconnection.
   * Used by heartbeat timeout and visibility-change health check.
   */
  forceReconnect(): void {
    if (this.intentionalClose) return;
    this.stopHeartbeat();
    this.resolveHealthChecks(false);
    if (this.ws) {
      // Null handlers to prevent double onclose handling
      this.ws.onclose = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* already dead */ }
    }
    this.connected = false;
    // Reject all pending invokes
    for (const [id, pending] of this.pendingInvokes) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Remote connection lost: ${this.url}`));
      this.pendingInvokes.delete(id);
    }
    this.messageQueue.length = 0;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    this.reconnectAttempts++;

    this.notifyState("reconnecting");
    // Phase 1: aggressive exponential backoff (1s→16s, ~8 attempts)
    // Phase 2: patient retries every 30s indefinitely
    const aggressive = this.reconnectAttempts <= RemoteConnection.AGGRESSIVE_ATTEMPTS;
    const delay = aggressive
      ? Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 16_000)
      : RemoteConnection.PATIENT_INTERVAL_MS;
    console.log(`[Remote] Reconnecting to ${this.url} in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;
      this.createWs(); // best-effort — no onReady/onFail callbacks
    }, delay);
  }

  /**
   * Send an immediate ping to check connection health.
   * If no pong within timeout, forces reconnect.
   */
  checkHealth(timeoutMs = 3000): Promise<boolean> {
    if (this.intentionalClose) return Promise.resolve(false);
    // Reset to aggressive mode so visibility-change retries are fast
    this.reconnectAttempts = 0;
    if (!this.connected) {
      // Not connected — cancel any patient-phase timer and retry aggressively
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.scheduleReconnect();
      return Promise.resolve(false);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.forceReconnect();
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const waiter: HealthCheckWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.healthCheckWaiters.delete(waiter);
          console.warn("[Remote] Health check failed for", this.url);
          this.forceReconnect();
          resolve(false);
        }, timeoutMs),
      };
      this.healthCheckWaiters.add(waiter);
      try {
        this.ws!.send(JSON.stringify({ type: "ping" }));
      } catch {
        clearTimeout(waiter.timer);
        this.healthCheckWaiters.delete(waiter);
        this.forceReconnect();
        resolve(false);
      }
    });
  }

  // ---- IPC ----

  invoke(channel: string, data?: any): Promise<any> {
    // Fast-fail when disconnected and not actively reconnecting
    if (!this.connected && !this.reconnectTimer) {
      return Promise.reject(new Error(`Remote server unreachable: ${this.url}`));
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(id);
        reject(new Error(`Remote IPC invoke timeout: ${channel}`));
      }, 120_000);

      this.pendingInvokes.set(id, { resolve, reject, timer });
      this.sendRaw(JSON.stringify({ type: "invoke", id, channel, data }));
    });
  }

  send(channel: string, data: any): void {
    this.sendRaw(JSON.stringify({ type: "send", channel, data }));
  }

  on(channel: string, func: Listener): () => void {
    if (!this.eventListeners.has(channel)) {
      this.eventListeners.set(channel, new Set());
    }
    this.eventListeners.get(channel)!.add(func);
    return () => {
      this.eventListeners.get(channel)?.delete(func);
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    this.resolveHealthChecks(false);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    for (const [, pending] of this.pendingInvokes) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Remote connection disconnected"));
    }
    this.pendingInvokes.clear();
    this.messageQueue.length = 0;
    this.notifyState("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ---- State observability ----

  onStateChange(cb: (state: RemoteConnectionState) => void): () => void {
    this._stateListeners.add(cb);
    return () => { this._stateListeners.delete(cb); };
  }

  private notifyState(state: RemoteConnectionState): void {
    for (const cb of this._stateListeners) cb(state);
  }

  waitUntilConnected(timeoutMs = 8000): Promise<boolean> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve(true);
    }
    if (!this.reconnectTimer && !this.intentionalClose) {
      this.scheduleReconnect();
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const cleanup = this.onStateChange((state) => {
        if (state !== "connected") return;
        clearTimeout(timeout);
        cleanup();
        resolve(true);
      });
    });
  }

  // ---- Internal ----

  private resolveHealthChecks(ok: boolean): void {
    if (this.healthCheckWaiters.size === 0) return;
    const waiters = [...this.healthCheckWaiters];
    this.healthCheckWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(ok);
    }
  }

  private sendRaw(data: string): void {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.messageQueue.push(data);
    }
  }
}

// --- Singleton Manager ---

/** Map of connectionId → RemoteConnection */
const connections = new Map<string, RemoteConnection>();

/** Map of sessionId → connectionId (routes IPC to the right remote server) */
const sessionRoutes = new Map<string, string>();

/** Connect to a remote Tron server. Returns a connection ID. */
export async function connectRemote(serverUrl: string): Promise<string> {
  const connectionId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const conn = new RemoteConnection(serverUrl);
  await conn.connect();
  connections.set(connectionId, conn);
  return connectionId;
}

/** Register a session ID as belonging to a remote connection. */
export function registerRemoteSession(sessionId: string, connectionId: string): void {
  sessionRoutes.set(sessionId, connectionId);
}

/** Check if a session ID belongs to a remote server. */
export function isRemoteSession(sessionId: string): boolean {
  return sessionRoutes.has(sessionId);
}

/** Get the RemoteConnection for a session, or null if local. */
export function getRemoteConnection(sessionId: string): RemoteConnection | null {
  const connId = sessionRoutes.get(sessionId);
  if (!connId) return null;
  return connections.get(connId) ?? null;
}

/** Get the remote server URL for a session. */
export function getRemoteUrl(sessionId: string): string | null {
  const conn = getRemoteConnection(sessionId);
  return conn?.url ?? null;
}

/** Get the connection ID for a remote session (for creating sibling PTYs). */
export function getRemoteConnectionId(sessionId: string): string | null {
  return sessionRoutes.get(sessionId) ?? null;
}

/** Unregister a remote session (on close). */
export function unregisterRemoteSession(sessionId: string): void {
  sessionRoutes.delete(sessionId);
}

/** Disconnect a remote connection and clean up all its sessions. */
export function disconnectRemote(connectionId: string): void {
  const conn = connections.get(connectionId);
  if (conn) {
    conn.disconnect();
    connections.delete(connectionId);
  }
  // Clean up session routes for this connection
  for (const [sessId, connId] of sessionRoutes) {
    if (connId === connectionId) {
      sessionRoutes.delete(sessId);
    }
  }
}

/** Subscribe to state changes on the connection that owns a session. */
export function onRemoteStateChange(
  sessionId: string,
  cb: (state: RemoteConnectionState) => void,
): (() => void) | null {
  const conn = getRemoteConnection(sessionId);
  if (!conn) return null;
  return conn.onStateChange(cb);
}

/** Proactively check the remote connection that owns a session. */
export function checkRemoteConnection(sessionId: string): Promise<boolean> {
  const conn = getRemoteConnection(sessionId);
  if (!conn) return Promise.resolve(false);
  return conn.checkHealth();
}

/**
 * Ensure a remote session still has a backend PTY. If the WebSocket silently
 * died, reconnect first; if the PTY disappeared on the remote server, recreate
 * it with the same session id so the mounted terminal pane keeps working.
 */
export async function reviveRemoteSession(
  sessionId: string,
  cwd?: string,
  cols = 80,
  rows = 30,
): Promise<{ ok: boolean; reconnected?: boolean }> {
  const connId = sessionRoutes.get(sessionId);
  if (!connId) return { ok: false };
  const conn = connections.get(connId);
  if (!conn) return { ok: false };

  const healthy = await conn.checkHealth();
  if (!healthy) {
    const connected = await conn.waitUntilConnected();
    if (!connected) return { ok: false };
  }

  let exists = false;
  try {
    exists = !!(await conn.invoke("terminal.sessionExists", sessionId));
  } catch {
    const connected = await conn.waitUntilConnected();
    if (!connected) return { ok: false };
    try {
      exists = !!(await conn.invoke("terminal.sessionExists", sessionId));
    } catch {
      return { ok: false };
    }
  }

  if (exists) return { ok: true, reconnected: true };

  try {
    const result = await createRemotePTY(connId, cols, rows, cwd, sessionId);
    return { ok: result.sessionId === sessionId, reconnected: result.reconnected };
  } catch {
    return { ok: false };
  }
}

// --- Visibility Change Handler ---
// When the tab is hidden for >2s (mobile sleep, tab switch), the remote WS
// may have silently died. On resume, send an immediate health-check ping
// to all remote connections so zombie sockets are detected quickly instead
// of waiting up to 30s for the next scheduled heartbeat.

let _visibilityHandlerInstalled = false;

function installVisibilityHandler(): void {
  if (_visibilityHandlerInstalled || typeof document === "undefined") return;
  _visibilityHandlerInstalled = true;

  let hiddenSince = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
      return;
    }
    const elapsed = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = 0;
    if (elapsed < 2000) return; // short tab switch — skip

    console.log(`[Remote] Tab visible after ${Math.round(elapsed / 1000)}s, checking remote connections...`);
    for (const conn of connections.values()) {
      conn.checkHealth();
    }
  });
}

// --- IPC Channel Routing ---

/** Channels where the sessionId is passed as the direct data argument (string). */
const SESSION_AS_DATA_CHANNELS = new Set([
  "terminal.sessionExists",
  "terminal.getHistory",
  "terminal.getCwd",
  "terminal.clearHistory",
  "terminal.getSystemInfo",
  "terminal.close",
]);

/** Channels where data is an object with a sessionId field. */
const SESSION_IN_OBJECT_CHANNELS = new Set([
  "terminal.create",
  "terminal.checkCommand",
  "terminal.exec",
  "terminal.execInTerminal",
  "terminal.getCompletions",
  "terminal.readHistory",
  "terminal.setHistory",
]);

/** Channels where data is an object with an id field (send channels). */
const ID_IN_OBJECT_CHANNELS = new Set([
  "terminal.write",
  "terminal.resize",
]);

/** Extract sessionId from a channel + data combination. */
export function extractSessionId(channel: string, data: any): string | null {
  // Dynamic echo channel: terminal.echo:{sessionId}
  if (channel.startsWith("terminal.echo:")) {
    return channel.slice("terminal.echo:".length);
  }

  if (SESSION_AS_DATA_CHANNELS.has(channel) && typeof data === "string") {
    return data;
  }

  if (SESSION_IN_OBJECT_CHANNELS.has(channel) && data && typeof data === "object") {
    return data.sessionId ?? null;
  }

  if (ID_IN_OBJECT_CHANNELS.has(channel) && data && typeof data === "object") {
    return data.id ?? null;
  }

  // File operations may include sessionId
  if (channel.startsWith("file.") && data && typeof data === "object" && data.sessionId) {
    return data.sessionId;
  }

  return null;
}

/**
 * Install IPC routing on window.electron.ipcRenderer.
 * Wraps invoke/send/on to transparently route remote session calls
 * through the correct RemoteConnection WebSocket.
 *
 * Call this once after the WS bridge or Electron preload is set up.
 */
export function installRemoteRouting(): void {
  if (!window.electron?.ipcRenderer) return;

  // Also install the visibility handler for remote health checks
  installVisibilityHandler();

  const ipc = window.electron.ipcRenderer;

  // The Electron context bridge freezes ipcRenderer — properties are read-only.
  // Create a mutable wrapper that delegates to the original, then replace the
  // reference on window.electron so all consumers get routed transparently.
  const original = {
    invoke: ipc.invoke.bind(ipc),
    send: ipc.send.bind(ipc),
    on: ipc.on.bind(ipc),
    getHistory: ipc.getHistory?.bind(ipc),
    getCwd: ipc.getCwd?.bind(ipc),
    exec: ipc.exec?.bind(ipc),
    execInTerminal: ipc.execInTerminal?.bind(ipc),
    getCompletions: ipc.getCompletions?.bind(ipc),
    getSystemInfo: ipc.getSystemInfo?.bind(ipc),
  };

  // Build the wrapped ipcRenderer with remote routing
  const wrapped: any = {};

  // Copy all existing properties from the original (checkCommand, etc.)
  for (const key of Object.keys(ipc)) {
    const val = (ipc as any)[key];
    wrapped[key] = typeof val === "function" ? val.bind(ipc) : val;
  }

  // Wrap invoke — route to remote if session is remote
  wrapped.invoke = (channel: string, data?: any): Promise<any> => {
    const sessionId = extractSessionId(channel, data);
    if (sessionId) {
      const conn = getRemoteConnection(sessionId);
      if (conn) return conn.invoke(channel, data);
    }
    return original.invoke(channel, data);
  };

  // Wrap send — route to remote if session is remote
  wrapped.send = (channel: string, data: any): void => {
    const sessionId = extractSessionId(channel, data);
    if (sessionId) {
      const conn = getRemoteConnection(sessionId);
      if (conn) { conn.send(channel, data); return; }
    }
    original.send(channel, data);
  };

  // Wrap on — listen on both local and all remote connections
  wrapped.on = (channel: string, func: Listener): (() => void) => {
    const localCleanup = original.on(channel, func);
    const remoteCleanups: (() => void)[] = [];
    for (const conn of connections.values()) {
      remoteCleanups.push(conn.on(channel, func));
    }
    return () => { localCleanup(); remoteCleanups.forEach(c => c()); };
  };

  // Wrap typed helpers that bypass invoke
  if (original.getHistory) {
    wrapped.getHistory = (sessionId: string) => {
      const conn = getRemoteConnection(sessionId);
      if (conn) return conn.invoke("terminal.getHistory", sessionId);
      return original.getHistory!(sessionId);
    };
  }
  if (original.getCwd) {
    wrapped.getCwd = (sessionId: string) => {
      const conn = getRemoteConnection(sessionId);
      if (conn) return conn.invoke("terminal.getCwd", sessionId);
      return original.getCwd!(sessionId);
    };
  }
  if (original.exec) {
    wrapped.exec = (sessionId: string, command: string) => {
      const conn = getRemoteConnection(sessionId);
      if (conn) return conn.invoke("terminal.exec", { sessionId, command });
      return original.exec!(sessionId, command);
    };
  }
  if (original.execInTerminal) {
    wrapped.execInTerminal = (sessionId: string, command: string) => {
      const conn = getRemoteConnection(sessionId);
      if (conn) return conn.invoke("terminal.execInTerminal", { sessionId, command });
      return original.execInTerminal!(sessionId, command);
    };
  }
  if (original.getCompletions) {
    wrapped.getCompletions = (prefix: string, cwd?: string, sessionId?: string) => {
      if (sessionId) {
        const conn = getRemoteConnection(sessionId);
        if (conn) return conn.invoke("terminal.getCompletions", { prefix, cwd, sessionId });
      }
      return original.getCompletions!(prefix, cwd, sessionId);
    };
  }
  if (original.getSystemInfo) {
    wrapped.getSystemInfo = (sessionId?: string) => {
      if (sessionId) {
        const conn = getRemoteConnection(sessionId);
        if (conn) return conn.invoke("terminal.getSystemInfo", sessionId);
      }
      return original.getSystemInfo!(sessionId);
    };
  }

  // Replace window.electron with a shallow copy containing our wrapped ipcRenderer.
  // window.electron is a regular writable property in both modes:
  // - Web mode: set by ws-bridge.ts
  // - Electron mode: copied from frozen _electronBridge to writable window.electron in main.tsx
  try {
    const electronCopy: any = {};
    for (const key of Object.keys(window.electron)) {
      electronCopy[key] = (window.electron as any)[key];
    }
    electronCopy.ipcRenderer = wrapped;
    (window as any).electron = electronCopy;
  } catch {
    // Should not happen — window.electron is writable in both modes
  }
}

/**
 * Create a PTY session on a remote server.
 * Returns the remote sessionId.
 */
export async function createRemotePTY(
  connectionId: string,
  cols: number,
  rows: number,
  cwd?: string,
  reconnectId?: string,
): Promise<{ sessionId: string; reconnected: boolean }> {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error("Remote connection not found");

  const result = await conn.invoke("terminal.create", { cols, rows, cwd, reconnectId });
  // Server returns { sessionId, reconnected } or plain string
  const sessionId = typeof result === "object" && result?.sessionId
    ? result.sessionId
    : result as string;
  const reconnected = typeof result === "object" && !!result?.reconnected;
  registerRemoteSession(sessionId, connectionId);

  return { sessionId, reconnected };
}
