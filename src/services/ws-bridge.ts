/**
 * WebSocket bridge that implements the same window.electron.ipcRenderer interface
 * used by the preload script. When running in a browser (no Electron), this shim
 * is installed so all existing React code works unchanged.
 */

type Listener = (...args: any[]) => void;

interface PendingInvoke {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let ws: WebSocket | null = null;
let connected = false;
const pendingInvokes = new Map<string, PendingInvoke>();
const eventListeners = new Map<string, Set<Listener>>();
const messageQueue: string[] = [];

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function uuid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function connect() {
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    connected = true;
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
    console.log("[WS Bridge] Disconnected, reconnecting in 1s...");
    setTimeout(connect, 1000);
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
      exec: (sessionId: string, command: string) =>
        invoke("terminal.exec", { sessionId, command }),
      testAIConnection: (config: { provider: string; model: string; apiKey?: string; baseUrl?: string }) =>
        invoke("ai.testConnection", config),
      getSystemInfo: (sessionId?: string) =>
        invoke("terminal.getSystemInfo", sessionId) as Promise<{ platform: string; arch: string; shell: string; release: string }>,
      // Session persistence
      readSessions: () =>
        invoke("sessions.read") as Promise<Record<string, unknown> | null>,
      writeSessions: (data: Record<string, unknown>) =>
        invoke("sessions.write", data) as Promise<boolean>,
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
    },
  };
}
