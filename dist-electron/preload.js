"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
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
    "terminal.clearHistory",
    "terminal.setHistory",
    "terminal.scanCommands",
    "terminal.getSystemInfo",
    "ai.testConnection",
    "system.selectFolder",
    "config.read",
    "config.write",
    "config.getSystemPaths",
    "sessions.read",
    "sessions.write",
    "file.saveTempImage",
    "file.writeFile",
    "file.readFile",
    "file.editFile",
    "file.listDir",
    "file.searchDir",
    "shell.openExternal",
    "shell.openPath",
    "shell.showItemInFolder",
    "system.flushStorage",
    "log.saveSessionLog",
    "ssh.connect",
    "ssh.testConnection",
    "ssh.disconnect",
    "ssh.profiles.read",
    "ssh.profiles.write",
    "savedTabs.read",
    "savedTabs.write",
    "terminal.history.getStats",
    "terminal.history.clearAll",
    "webServer.start",
    "webServer.stop",
    "webServer.status",
    "webServer.checkPort",
    "updater.checkForUpdates",
    "updater.downloadUpdate",
    "updater.quitAndInstall",
    "updater.getStatus",
    "updater.getVersion",
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
    "ssh.statusChange",
    "updater.status",
    "updater.downloadProgress",
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
        getSystemInfo: (sessionId) => electron_1.ipcRenderer.invoke("terminal.getSystemInfo", sessionId),
        // System
        testAIConnection: (config) => electron_1.ipcRenderer.invoke("ai.testConnection", config),
        selectFolder: (defaultPath) => electron_1.ipcRenderer.invoke("system.selectFolder", defaultPath),
        openExternal: (url) => electron_1.ipcRenderer.invoke("shell.openExternal", url),
        listDir: (dirPath) => electron_1.ipcRenderer.invoke("file.listDir", { dirPath }),
        searchDir: (dirPath, query) => electron_1.ipcRenderer.invoke("file.searchDir", { dirPath, query }),
        openPath: (filePath) => electron_1.ipcRenderer.invoke("shell.openPath", filePath),
        showItemInFolder: (filePath) => electron_1.ipcRenderer.invoke("shell.showItemInFolder", filePath),
        flushStorage: () => electron_1.ipcRenderer.invoke("system.flushStorage"),
        saveSessionLog: (data) => electron_1.ipcRenderer.invoke("log.saveSessionLog", data),
        // SSH
        connectSSH: (config) => electron_1.ipcRenderer.invoke("ssh.connect", config),
        testSSHConnection: (config) => electron_1.ipcRenderer.invoke("ssh.testConnection", config),
        disconnectSSH: (sessionId) => electron_1.ipcRenderer.invoke("ssh.disconnect", sessionId),
        readSSHProfiles: () => electron_1.ipcRenderer.invoke("ssh.profiles.read"),
        writeSSHProfiles: (profiles) => electron_1.ipcRenderer.invoke("ssh.profiles.write", profiles),
        // Sync Tabs
        readSyncTabs: () => electron_1.ipcRenderer.invoke("savedTabs.read"),
        writeSyncTabs: (tabs) => electron_1.ipcRenderer.invoke("savedTabs.write", tabs),
        // Terminal history stats (web mode only — Electron stubs return empty)
        getPersistedHistoryStats: () => electron_1.ipcRenderer.invoke("terminal.history.getStats"),
        clearAllPersistedHistory: () => electron_1.ipcRenderer.invoke("terminal.history.clearAll"),
        // Web Server
        startWebServer: (port) => electron_1.ipcRenderer.invoke("webServer.start", port),
        stopWebServer: () => electron_1.ipcRenderer.invoke("webServer.stop"),
        getWebServerStatus: () => electron_1.ipcRenderer.invoke("webServer.status"),
        checkPort: (port) => electron_1.ipcRenderer.invoke("webServer.checkPort", port),
        // Updater
        checkForUpdates: () => electron_1.ipcRenderer.invoke("updater.checkForUpdates"),
        downloadUpdate: () => electron_1.ipcRenderer.invoke("updater.downloadUpdate"),
        quitAndInstall: () => electron_1.ipcRenderer.invoke("updater.quitAndInstall"),
        getUpdateStatus: () => electron_1.ipcRenderer.invoke("updater.getStatus"),
        getAppVersion: () => electron_1.ipcRenderer.invoke("updater.getVersion"),
    },
});
//# sourceMappingURL=preload.js.map