"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
console.log("Preload script loaded!");
electron_1.contextBridge.exposeInMainWorld("electron", {
    ipcRenderer: {
        invoke: (channel, data) => electron_1.ipcRenderer.invoke(channel, data),
        send: (channel, data) => electron_1.ipcRenderer.send(channel, data),
        on: (channel, func) => {
            const subscription = (_event, ...args) => func(...args);
            electron_1.ipcRenderer.on(channel, subscription);
            return () => electron_1.ipcRenderer.removeListener(channel, subscription);
        },
        once: (channel, func) => {
            electron_1.ipcRenderer.once(channel, (_event, ...args) => func(...args));
        },
        removeListener: (channel, func) => {
            electron_1.ipcRenderer.removeListener(channel, func);
        },
        // Typed helpers for specific IPC calls
        checkCommand: (command) => electron_1.ipcRenderer.invoke("terminal.checkCommand", command),
        getCwd: (sessionId) => electron_1.ipcRenderer.invoke("terminal.getCwd", sessionId),
        getCompletions: (prefix, cwd) => electron_1.ipcRenderer.invoke("terminal.getCompletions", { prefix, cwd }),
        getHistory: (sessionId) => electron_1.ipcRenderer.invoke("terminal.getHistory", sessionId),
        exec: (sessionId, command) => electron_1.ipcRenderer.invoke("terminal.exec", { sessionId, command }),
        // System
        fixPermissions: () => electron_1.ipcRenderer.invoke("system.fixPermissions"),
        checkPermissions: () => electron_1.ipcRenderer.invoke("system.checkPermissions"),
        openPrivacySettings: () => electron_1.ipcRenderer.invoke("system.openPrivacySettings"),
        testAIConnection: (config) => electron_1.ipcRenderer.invoke("ai.testConnection", config),
    },
});
//# sourceMappingURL=preload.js.map