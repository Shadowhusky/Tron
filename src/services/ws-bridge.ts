/**
 * WebSocket bridge that implements the same window.electron.ipcRenderer interface
 * used by the preload script. When running in a browser (no Electron), this shim
 * is installed so all existing React code works unchanged.
 */

import { setMode, setSshOnly } from "./mode";
import type { TronMode } from "./mode";

type Listener = (...args: any[]) => void;

interface PendingInvoke {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let ws: WebSocket | null = null;
let connected = false;
let connectionFailed = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_BEFORE_FAIL = 3;
const pendingInvokes = new Map<string, PendingInvoke>();
const eventListeners = new Map<string, Set<Listener>>();
const messageQueue: string[] = [];

// Server reconnection callback — fires when WS reconnects after server restart
let _onServerReconnect: (() => void) | null = null;
/** Register a callback that fires when the server reconnects after being down. */
export function onServerReconnect(cb: () => void) { _onServerReconnect = cb; }

// Promise that resolves once we know the deployment mode
let _modeResolve: ((mode: TronMode) => void) | null = null;
export const modeReady: Promise<TronMode> = new Promise((resolve) => {
  _modeResolve = resolve;
});
let modeResolved = false;

/** Get or create a persistent client token so the server can identify us across reconnects. */
function getClientToken(): string {
  const key = "tron_client_token";
  let token = localStorage.getItem(key);
  if (!token) {
    token = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem(key, token); } catch { /* private mode */ }
  }
  return token;
}

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = getClientToken();
  return `${proto}//${location.host}/ws?token=${token}`;
}

function uuid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function connect() {
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    connected = true;
    connectionFailed = false;
    reconnectAttempts = 0;
    console.log("[WS Bridge] Connected");
    // Flush queued messages
    while (messageQueue.length > 0) {
      ws!.send(messageQueue.shift()!);
    }
  };

  ws.onmessage = (event) => {
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "mode") {
      // Server tells us its deployment mode and access restrictions
      const mode = msg.mode as TronMode;
      setMode(mode);
      setSshOnly(!!msg.sshOnly);
      if (!modeResolved && _modeResolve) {
        modeResolved = true;
        _modeResolve(mode);
      } else if (modeResolved && _onServerReconnect) {
        // Server reconnected after being down — re-attach sessions
        console.log("[WS Bridge] Server reconnected, triggering session re-attach");
        _onServerReconnect();
      }
      return;
    }

    if (msg.type === "invoke-response") {
      const pending = pendingInvokes.get(msg.id);
      if (pending) {
        pendingInvokes.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.type === "event") {
      const listeners = eventListeners.get(msg.channel);
      if (listeners) {
        for (const fn of listeners) {
          fn(msg.data);
        }
      }
    }
  };

  ws.onclose = () => {
    connected = false;
    reconnectAttempts++;
    if (reconnectAttempts >= MAX_RECONNECT_BEFORE_FAIL && !connectionFailed) {
      connectionFailed = true;
      console.warn("[WS Bridge] Server unreachable after", MAX_RECONNECT_BEFORE_FAIL, "attempts.");
      // Reject all pending invokes so the app doesn't hang
      for (const [id, pending] of pendingInvokes) {
        clearTimeout(pending.timer);
        pending.reject(new Error("WebSocket server unreachable. Start the server with: npm run dev:web"));
        pendingInvokes.delete(id);
      }
      messageQueue.length = 0;
    }
    // Keep trying to reconnect (server may come up later)
    const delay = connectionFailed ? 5000 : 1000;
    console.log(`[WS Bridge] Disconnected, reconnecting in ${delay / 1000}s...`);
    setTimeout(connect, delay);
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function sendRaw(data: string) {
  if (connected && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  } else {
    messageQueue.push(data);
  }
}

function invoke(channel: string, data?: any): Promise<any> {
  if (connectionFailed) {
    return Promise.reject(new Error("WebSocket server unreachable. Start the server with: npm run dev:web"));
  }
  return new Promise((resolve, reject) => {
    const id = uuid();
    const timer = setTimeout(() => {
      pendingInvokes.delete(id);
      reject(new Error(`IPC invoke timeout: ${channel}`));
    }, 30000);

    pendingInvokes.set(id, { resolve, reject, timer });
    sendRaw(JSON.stringify({ type: "invoke", id, channel, data }));
  });
}

function send(channel: string, data: any) {
  sendRaw(JSON.stringify({ type: "send", channel, data }));
}

function on(channel: string, func: Listener): () => void {
  if (!eventListeners.has(channel)) {
    eventListeners.set(channel, new Set());
  }
  eventListeners.get(channel)!.add(func);
  return () => {
    eventListeners.get(channel)?.delete(func);
  };
}

function once(channel: string, func: Listener) {
  const wrapper: Listener = (...args) => {
    eventListeners.get(channel)?.delete(wrapper);
    func(...args);
  };
  on(channel, wrapper);
}

function removeListener(channel: string, func: Listener) {
  eventListeners.get(channel)?.delete(func);
}

/**
 * Call this before createRoot(). If window.electron already exists (Electron mode),
 * this is a no-op. Otherwise, installs the WebSocket shim.
 */
export function initWebSocketBridge() {
  if ((window as any).electron) {
    console.log("[WS Bridge] Electron detected, skipping shim");
    return;
  }

  console.log("[WS Bridge] No Electron detected, installing WebSocket shim");
  connect();

  // bfcache restoration — mobile browsers freeze/unfreeze pages, leaving a dead WS
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      console.log("[WS Bridge] Page restored from bfcache, reconnecting...");
      connected = false;
      connectionFailed = false;
      reconnectAttempts = 0;
      // Null out stale WS handlers to prevent its onclose from scheduling a duplicate reconnect
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try { ws.close(); } catch { /* already dead */ }
      }
      connect();
    }
  });

  // Visibility change — handle tab switch + sleep/wake on mobile.
  // Mobile browsers freeze JS when a tab is backgrounded. The WS dies but
  // readyState still reports OPEN because the close frame was never processed.
  // We track how long the page was hidden and force-reconnect if >2s.
  let hiddenSince = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
      return;
    }
    // visible
    const elapsed = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = 0;

    // Short tab switches (< 2s) with WS still open — likely fine, skip
    if (elapsed < 2000 && ws?.readyState === WebSocket.OPEN) return;

    // Force reconnect — WS may appear open but is dead after mobile freeze
    console.log(`[WS Bridge] Tab visible after ${Math.round(elapsed / 1000)}s, forcing reconnect...`);
    connected = false;
    connectionFailed = false;
    reconnectAttempts = 0;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch { /* already dead */ }
    }
    connect();
  });

  (window as any).electron = {
    ipcRenderer: {
      invoke,
      send,
      on,
      once,
      removeListener,
      // Typed helpers matching preload.ts
      checkCommand: (command: string) => invoke("terminal.checkCommand", command),
      getCwd: (sessionId: string) => invoke("terminal.getCwd", sessionId),
      getCompletions: (prefix: string, cwd?: string, sessionId?: string) =>
        invoke("terminal.getCompletions", { prefix, cwd, sessionId }),
      getHistory: (sessionId: string) => invoke("terminal.getHistory", sessionId),
      scanCommands: () => invoke("terminal.scanCommands") as Promise<string[]>,
      getShellHistory: () => invoke("terminal.getShellHistory") as Promise<string[]>,
      exec: (sessionId: string, command: string) =>
        invoke("terminal.exec", { sessionId, command }),
      testAIConnection: (config: { provider: string; model: string; apiKey?: string; baseUrl?: string }) =>
        invoke("ai.testConnection", config),
      fetchModels: (config: { provider: string; baseUrl?: string; apiKey?: string }) =>
        invoke("ai.getModels", config) as Promise<any[]>,
      fetchModelCapabilities: (config: { provider: string; modelName: string; baseUrl?: string; apiKey?: string }) =>
        invoke("ai.getModelCapabilities", config) as Promise<string[]>,
      getSystemInfo: (sessionId?: string) =>
        invoke("terminal.getSystemInfo", sessionId) as Promise<{ platform: string; arch: string; shell: string; release: string }>,
      execInTerminal: (sessionId: string, command: string) =>
        invoke("terminal.execInTerminal", { sessionId, command }),
      // Config
      readConfig: () =>
        invoke("config.read") as Promise<Record<string, unknown> | null>,
      writeConfig: (data: Record<string, unknown>) =>
        invoke("config.write", data) as Promise<boolean>,
      // Session persistence
      readSessions: () =>
        invoke("sessions.read") as Promise<Record<string, unknown> | null>,
      writeSessions: (data: Record<string, unknown>) =>
        invoke("sessions.write", data) as Promise<boolean>,
      getSystemPaths: () =>
        invoke("config.getSystemPaths") as Promise<Record<string, string>>,
      // Clipboard (server-side — bypasses browser secure context requirement)
      clipboardReadText: () => invoke("clipboard.readText") as Promise<string>,
      clipboardWriteText: (text: string) => invoke("clipboard.writeText", text) as Promise<boolean>,
      // System
      selectFolder: (_defaultPath?: string) =>
        Promise.resolve(null) as Promise<string | null>,
      openExternal: (url: string) =>
        window.open(url, "_blank") as unknown as Promise<void>,
      openPath: (_filePath: string) =>
        Promise.resolve("") as Promise<string>,
      showItemInFolder: (_filePath: string) =>
        Promise.resolve() as Promise<void>,
      flushStorage: () =>
        Promise.resolve() as Promise<void>,
      listDir: (dirPath: string) =>
        invoke("file.listDir", { dirPath }) as Promise<{
          success: boolean;
          contents?: { name: string; isDirectory: boolean }[];
          error?: string;
        }>,
      searchDir: (dirPath: string, query: string) =>
        invoke("file.searchDir", { dirPath, query }) as Promise<{
          success: boolean;
          results?: { file: string; line: number; content: string }[];
          error?: string;
        }>,
      saveSessionLog: (data: {
        sessionId: string;
        session: Record<string, unknown>;
        interactions: unknown[];
        agentThread: unknown[];
        contextSummary?: string;
      }) =>
        invoke("log.saveSessionLog", data) as Promise<{
          success: boolean;
          logId?: string;
          filePath?: string;
          error?: string;
        }>,
      // SSH
      connectSSH: (config: any) =>
        invoke("ssh.connect", config) as Promise<{ sessionId: string }>,
      testSSHConnection: (config: any) =>
        invoke("ssh.testConnection", config) as Promise<{ success: boolean; error?: string }>,
      disconnectSSH: (sessionId: string) =>
        invoke("ssh.disconnect", sessionId) as Promise<boolean>,
      readSSHProfiles: () =>
        invoke("ssh.profiles.read") as Promise<any[]>,
      writeSSHProfiles: (profiles: any[]) =>
        invoke("ssh.profiles.write", profiles) as Promise<boolean>,
      // Terminal history stats
      getPersistedHistoryStats: () =>
        invoke("terminal.history.getStats") as Promise<{ fileCount: number; totalBytes: number }>,
      clearAllPersistedHistory: () =>
        invoke("terminal.history.clearAll") as Promise<{ deletedCount: number }>,
      // Sync Tabs
      readSyncTabs: () =>
        invoke("savedTabs.read") as Promise<any[]>,
      writeSyncTabs: (tabs: any[]) =>
        invoke("savedTabs.write", tabs) as Promise<boolean>,
    },
  };
}
