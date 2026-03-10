/**
 * Remote Bridge — manages WebSocket connections to remote Tron servers.
 *
 * When a remote terminal session is created, all IPC calls for that session
 * are routed through the remote server's WebSocket instead of the local one.
 * The Terminal component works unchanged — routing is transparent.
 */

type Listener = (...args: any[]) => void;

interface PendingInvoke {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RemoteConnection {
  private ws: WebSocket | null = null;
  private connected = false;
  private pendingInvokes = new Map<string, PendingInvoke>();
  private eventListeners = new Map<string, Set<Listener>>();
  private messageQueue: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsProto = this.url.startsWith("https") ? "wss:" : "ws:";
      let host: string;
      try {
        host = new URL(this.url).host;
      } catch {
        reject(new Error(`Invalid URL: ${this.url}`));
        return;
      }

      // Generate a unique client token for this remote connection
      const token = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
      const wsUrl = `${wsProto}//${host}/ws?token=${token}`;

      this.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout: ${this.url}`));
        this.ws?.close();
      }, 10000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        // Flush queued messages
        while (this.messageQueue.length > 0) {
          this.ws!.send(this.messageQueue.shift()!);
        }
        // Don't resolve yet — wait for the mode message from server
      };

      this.ws.onmessage = (event) => {
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === "mode") {
          // Server confirmed connection — resolve the connect promise
          resolve();
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
        this.connected = false;
        // Reject all pending invokes
        for (const [id, pending] of this.pendingInvokes) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Remote connection closed: ${this.url}`));
          this.pendingInvokes.delete(id);
        }
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        if (!this.connected) {
          reject(new Error(`Failed to connect to remote server: ${this.url}`));
        }
      };
    });
  }

  invoke(channel: string, data?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(id);
        reject(new Error(`Remote IPC invoke timeout: ${channel}`));
      }, 120000);

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
  }

  isConnected(): boolean {
    return this.connected;
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

// --- IPC Channel Routing ---

/** Channels where the sessionId is passed as the direct data argument (string). */
const SESSION_AS_DATA_CHANNELS = new Set([
  "terminal.getHistory",
  "terminal.getCwd",
  "terminal.clearHistory",
  "terminal.getSystemInfo",
  "terminal.close",
]);

/** Channels where data is an object with a sessionId field. */
const SESSION_IN_OBJECT_CHANNELS = new Set([
  "terminal.create",
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
): Promise<string> {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error("Remote connection not found");

  const result = await conn.invoke("terminal.create", { cols, rows, cwd });
  // Server returns { sessionId, reconnected } or plain string
  const sessionId = typeof result === "object" && result?.sessionId
    ? result.sessionId
    : result as string;
  registerRemoteSession(sessionId, connectionId);

  return sessionId;
}
