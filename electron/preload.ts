import { contextBridge, ipcRenderer } from "electron";

console.log("Preload script loaded!");

// Channel allowlists — only these channels can be used from the renderer
const ALLOWED_INVOKE_CHANNELS = [
  "terminal.create",
  "terminal.sessionExists",
  "terminal.checkCommand",
  "terminal.exec",
  "terminal.execInTerminal",
  "terminal.getCwd",
  "terminal.getCompletions",
  "terminal.getHistory",
  "terminal.readHistory",
  "terminal.scanCommands",
  "ai.testConnection",
  "system.selectFolder",
  "config.read",
  "config.write",
  "config.getSystemPaths",
  "sessions.read",
  "sessions.write",
  "file.writeFile",
  "file.readFile",
  "file.editFile",
  "shell.openExternal",
  "shell.openPath",
  "shell.showItemInFolder",
  "system.flushStorage",
  "log.saveSessionLog",
] as const;

const ALLOWED_SEND_CHANNELS = [
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  "window.closeConfirmed",
  "window.closeCancelled",
] as const;

const ALLOWED_RECEIVE_CHANNELS = [
  "terminal.incomingData",
  "terminal.exit",
  "menu.createTab",
  "menu.closeTab",
  "window.confirmClose",
] as const;

type InvokeChannel = (typeof ALLOWED_INVOKE_CHANNELS)[number];
type SendChannel = (typeof ALLOWED_SEND_CHANNELS)[number];

const invokeSet = new Set<string>(ALLOWED_INVOKE_CHANNELS);
const sendSet = new Set<string>(ALLOWED_SEND_CHANNELS);
const receiveSet = new Set<string>(ALLOWED_RECEIVE_CHANNELS);

contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    invoke: (channel: InvokeChannel, data?: any) => {
      if (!invokeSet.has(channel)) {
        throw new Error(`IPC invoke not allowed: ${channel}`);
      }
      return ipcRenderer.invoke(channel, data);
    },
    send: (channel: SendChannel, data: any) => {
      if (!sendSet.has(channel)) {
        throw new Error(`IPC send not allowed: ${channel}`);
      }
      ipcRenderer.send(channel, data);
    },
    on: (channel: string, func: (...args: any[]) => void) => {
      // Allow both static receive channels and dynamic terminal.echo:* channels
      if (!receiveSet.has(channel) && !channel.startsWith("terminal.echo:")) {
        throw new Error(`IPC on not allowed: ${channel}`);
      }
      const subscription = (_event: any, ...args: any[]) => func(...args);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    },
    once: (channel: string, func: (...args: any[]) => void) => {
      if (!receiveSet.has(channel) && !channel.startsWith("terminal.echo:")) {
        throw new Error(`IPC once not allowed: ${channel}`);
      }
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
    removeListener: (channel: string, func: (...args: any[]) => void) => {
      ipcRenderer.removeListener(channel, func);
    },
    // Typed helpers for specific IPC calls
    checkCommand: (command: string) =>
      ipcRenderer.invoke("terminal.checkCommand", command),
    getCwd: (sessionId: string) =>
      ipcRenderer.invoke("terminal.getCwd", sessionId),
    getCompletions: (prefix: string, cwd?: string, sessionId?: string) =>
      ipcRenderer.invoke("terminal.getCompletions", { prefix, cwd, sessionId }),
    getHistory: (sessionId: string) =>
      ipcRenderer.invoke("terminal.getHistory", sessionId),
    scanCommands: () =>
      ipcRenderer.invoke("terminal.scanCommands") as Promise<string[]>,
    exec: (sessionId: string, command: string) =>
      ipcRenderer.invoke("terminal.exec", { sessionId, command }),
    execInTerminal: (sessionId: string, command: string) =>
      ipcRenderer.invoke("terminal.execInTerminal", { sessionId, command }),
    // Config
    readConfig: () =>
      ipcRenderer.invoke("config.read") as Promise<Record<string, unknown> | null>,
    writeConfig: (data: Record<string, unknown>) =>
      ipcRenderer.invoke("config.write", data) as Promise<boolean>,
    // Sessions (agent state)
    readSessions: () =>
      ipcRenderer.invoke("sessions.read") as Promise<Record<string, unknown> | null>,
    writeSessions: (data: Record<string, unknown>) =>
      ipcRenderer.invoke("sessions.write", data) as Promise<boolean>,
    getSystemPaths: () =>
      ipcRenderer.invoke("config.getSystemPaths") as Promise<Record<string, string>>,
    // System
    testAIConnection: (config: {
      provider: string;
      model: string;
      apiKey?: string;
      baseUrl?: string;
    }) => ipcRenderer.invoke("ai.testConnection", config),
    selectFolder: (defaultPath?: string) =>
      ipcRenderer.invoke("system.selectFolder", defaultPath) as Promise<string | null>,
    openExternal: (url: string) =>
      ipcRenderer.invoke("shell.openExternal", url) as Promise<void>,
    openPath: (filePath: string) =>
      ipcRenderer.invoke("shell.openPath", filePath) as Promise<string>,
    showItemInFolder: (filePath: string) =>
      ipcRenderer.invoke("shell.showItemInFolder", filePath) as Promise<void>,
    flushStorage: () =>
      ipcRenderer.invoke("system.flushStorage") as Promise<void>,
    saveSessionLog: (data: {
      sessionId: string;
      session: Record<string, unknown>;
      interactions: unknown[];
      agentThread: unknown[];
      contextSummary?: string;
    }) =>
      ipcRenderer.invoke("log.saveSessionLog", data) as Promise<{
        success: boolean;
        logId?: string;
        filePath?: string;
        error?: string;
      }>,
  },
});
