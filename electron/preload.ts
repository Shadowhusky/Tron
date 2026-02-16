import { contextBridge, ipcRenderer } from "electron";

console.log("Preload script loaded!");

contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    invoke: (channel: string, data?: any) => ipcRenderer.invoke(channel, data),
    send: (channel: string, data: any) => ipcRenderer.send(channel, data),
    on: (channel: string, func: (...args: any[]) => void) => {
      const subscription = (_event: any, ...args: any[]) => func(...args);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    },
    once: (channel: string, func: (...args: any[]) => void) => {
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
    exec: (sessionId: string, command: string) =>
      ipcRenderer.invoke("terminal.exec", { sessionId, command }),
    // System
    fixPermissions: () => ipcRenderer.invoke("system.fixPermissions"),
    checkPermissions: () => ipcRenderer.invoke("system.checkPermissions"),
    openPrivacySettings: () => ipcRenderer.invoke("system.openPrivacySettings"),
    testAIConnection: (config: {
      provider: string;
      model: string;
      apiKey?: string;
    }) => ipcRenderer.invoke("ai.testConnection", config),
  },
});
