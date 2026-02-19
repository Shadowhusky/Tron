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
];
const ALLOWED_SEND_CHANNELS = [
    "terminal.write",
    "terminal.resize",
    "terminal.close",
    "window.closeConfirmed",
    "window.closeCancelled",
];
const ALLOWED_RECEIVE_CHANNELS = [
    "terminal.incomingData",
    "terminal.exit",
    "menu.createTab",
    "menu.closeTab",
    "window.confirmClose",
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
        scanCommands: () => electron_1.ipcRenderer.invoke("terminal.scanCommands"),
        exec: (sessionId, command) => electron_1.ipcRenderer.invoke("terminal.exec", { sessionId, command }),
        execInTerminal: (sessionId, command) => electron_1.ipcRenderer.invoke("terminal.execInTerminal", { sessionId, command }),
        // Config
        readConfig: () => electron_1.ipcRenderer.invoke("config.read"),
        writeConfig: (data) => electron_1.ipcRenderer.invoke("config.write", data),
        // Sessions (agent state)
        readSessions: () => electron_1.ipcRenderer.invoke("sessions.read"),
        writeSessions: (data) => electron_1.ipcRenderer.invoke("sessions.write", data),
        getSystemPaths: () => electron_1.ipcRenderer.invoke("config.getSystemPaths"),
        // System
        testAIConnection: (config) => electron_1.ipcRenderer.invoke("ai.testConnection", config),
        selectFolder: (defaultPath) => electron_1.ipcRenderer.invoke("system.selectFolder", defaultPath),
        openExternal: (url) => electron_1.ipcRenderer.invoke("shell.openExternal", url),
        openPath: (filePath) => electron_1.ipcRenderer.invoke("shell.openPath", filePath),
        showItemInFolder: (filePath) => electron_1.ipcRenderer.invoke("shell.showItemInFolder", filePath),
        flushStorage: () => electron_1.ipcRenderer.invoke("system.flushStorage"),
        saveSessionLog: (data) => electron_1.ipcRenderer.invoke("log.saveSessionLog", data),
    },
});
//# sourceMappingURL=preload.js.map