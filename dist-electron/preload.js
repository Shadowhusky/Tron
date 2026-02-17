"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
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
    "system.fixPermissions",
    "system.checkPermissions",
    "system.openPrivacySettings",
    "ai.testConnection",
];
const ALLOWED_SEND_CHANNELS = [
    "terminal.write",
    "terminal.resize",
    "terminal.close",
];
const ALLOWED_RECEIVE_CHANNELS = [
    "terminal.incomingData",
    "terminal.exit",
    "menu.createTab",
    "menu.closeTab",
];
const invokeSet = new Set(ALLOWED_INVOKE_CHANNELS);
const sendSet = new Set(ALLOWED_SEND_CHANNELS);
const receiveSet = new Set(ALLOWED_RECEIVE_CHANNELS);
electron_1.contextBridge.exposeInMainWorld("electron", {
    ipcRenderer: {
        invoke: (channel, data) => {
            if (!invokeSet.has(channel)) {
                throw new Error(`IPC invoke not allowed: ${channel}`);
            }
            return electron_1.ipcRenderer.invoke(channel, data);
        },
        send: (channel, data) => {
            if (!sendSet.has(channel)) {
                throw new Error(`IPC send not allowed: ${channel}`);
            }
            electron_1.ipcRenderer.send(channel, data);
        },
        on: (channel, func) => {
            // Allow both static receive channels and dynamic terminal.echo:* channels
            if (!receiveSet.has(channel) && !channel.startsWith("terminal.echo:")) {
                throw new Error(`IPC on not allowed: ${channel}`);
            }
            const subscription = (_event, ...args) => func(...args);
            electron_1.ipcRenderer.on(channel, subscription);
            return () => electron_1.ipcRenderer.removeListener(channel, subscription);
        },
        once: (channel, func) => {
            if (!receiveSet.has(channel) && !channel.startsWith("terminal.echo:")) {
                throw new Error(`IPC once not allowed: ${channel}`);
            }
            electron_1.ipcRenderer.once(channel, (_event, ...args) => func(...args));
        },
        removeListener: (channel, func) => {
            electron_1.ipcRenderer.removeListener(channel, func);
        },
        // Typed helpers for specific IPC calls
        checkCommand: (command) => electron_1.ipcRenderer.invoke("terminal.checkCommand", command),
        getCwd: (sessionId) => electron_1.ipcRenderer.invoke("terminal.getCwd", sessionId),
        getCompletions: (prefix, cwd, sessionId) => electron_1.ipcRenderer.invoke("terminal.getCompletions", { prefix, cwd, sessionId }),
        getHistory: (sessionId) => electron_1.ipcRenderer.invoke("terminal.getHistory", sessionId),
        exec: (sessionId, command) => electron_1.ipcRenderer.invoke("terminal.exec", { sessionId, command }),
        execInTerminal: (sessionId, command) => electron_1.ipcRenderer.invoke("terminal.execInTerminal", { sessionId, command }),
        // System
        fixPermissions: () => electron_1.ipcRenderer.invoke("system.fixPermissions"),
        checkPermissions: () => electron_1.ipcRenderer.invoke("system.checkPermissions"),
        openPrivacySettings: () => electron_1.ipcRenderer.invoke("system.openPrivacySettings"),
        testAIConnection: (config) => electron_1.ipcRenderer.invoke("ai.testConnection", config),
    },
});
//# sourceMappingURL=preload.js.map