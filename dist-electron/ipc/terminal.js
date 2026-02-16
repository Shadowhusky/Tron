"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSessions = getSessions;
exports.getSessionHistory = getSessionHistory;
exports.registerTerminalHandlers = registerTerminalHandlers;
const electron_1 = require("electron");
const pty = __importStar(require("node-pty"));
const os_1 = __importDefault(require("os"));
const crypto_1 = require("crypto");
const sessions = new Map();
const sessionHistory = new Map();
function getSessions() {
    return sessions;
}
function getSessionHistory() {
    return sessionHistory;
}
function registerTerminalHandlers(getMainWindow) {
    // Check if a PTY session is still alive (for reconnection after renderer refresh)
    electron_1.ipcMain.handle("terminal.sessionExists", (_event, sessionId) => {
        return sessions.has(sessionId);
    });
    // Create Session (or reconnect to existing one)
    electron_1.ipcMain.handle("terminal.create", (_event, { cols, rows, cwd, reconnectId }) => {
        // If reconnectId is provided and a PTY with that ID exists, reuse it
        if (reconnectId && sessions.has(reconnectId)) {
            const existing = sessions.get(reconnectId);
            try {
                existing.resize(cols || 80, rows || 30);
            }
            catch { }
            return reconnectId;
        }
        const isWin = os_1.default.platform() === "win32";
        const shell = isWin ? "powershell.exe" : "/bin/zsh";
        const shellArgs = isWin ? [] : ["+o", "PROMPT_SP"];
        const sessionId = (0, crypto_1.randomUUID)();
        try {
            const ptyProcess = pty.spawn(shell, shellArgs, {
                name: "xterm-256color",
                cols: cols || 80,
                rows: rows || 30,
                cwd: cwd || process.env.HOME,
                env: { ...process.env, PROMPT_EOL_MARK: "" },
            });
            sessionHistory.set(sessionId, "");
            ptyProcess.onData((data) => {
                const currentHistory = sessionHistory.get(sessionId) || "";
                if (currentHistory.length < 100000) {
                    sessionHistory.set(sessionId, currentHistory + data);
                }
                else {
                    sessionHistory.set(sessionId, currentHistory.slice(-80000) + data);
                }
                const mainWindow = getMainWindow();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("terminal.incomingData", {
                        id: sessionId,
                        data,
                    });
                }
            });
            ptyProcess.onExit(({ exitCode }) => {
                const mainWindow = getMainWindow();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("terminal.exit", {
                        id: sessionId,
                        exitCode,
                    });
                }
                sessions.delete(sessionId);
                sessionHistory.delete(sessionId);
            });
            sessions.set(sessionId, ptyProcess);
            return sessionId;
        }
        catch (e) {
            console.error("Failed to create PTY session:", e);
            throw e;
        }
    });
    // Terminal Input/Output/Resize
    electron_1.ipcMain.on("terminal.write", (_event, { id, data }) => {
        const session = sessions.get(id);
        if (session)
            session.write(data);
    });
    electron_1.ipcMain.on("terminal.resize", (_event, { id, cols, rows }) => {
        const session = sessions.get(id);
        if (session)
            session.resize(cols, rows);
    });
    electron_1.ipcMain.on("terminal.close", (_event, id) => {
        const session = sessions.get(id);
        if (session) {
            session.kill();
            sessions.delete(id);
            sessionHistory.delete(id);
        }
    });
    electron_1.ipcMain.handle("terminal.checkCommand", async (_event, command) => {
        const { exec } = await Promise.resolve().then(() => __importStar(require("child_process")));
        const { promisify } = await Promise.resolve().then(() => __importStar(require("util")));
        const execAsync = promisify(exec);
        try {
            const checkCmd = os_1.default.platform() === "win32" ? `where ${command}` : `which ${command}`;
            await execAsync(checkCmd);
            return true;
        }
        catch {
            return false;
        }
    });
    // Agent Execution
    electron_1.ipcMain.handle("terminal.exec", async (_event, { sessionId, command }) => {
        const session = sessions.get(sessionId);
        const { exec } = await Promise.resolve().then(() => __importStar(require("child_process")));
        const { promisify } = await Promise.resolve().then(() => __importStar(require("util")));
        const execAsync = promisify(exec);
        let cwd = process.env.HOME || "/";
        if (session) {
            try {
                const pid = session.pid;
                if (os_1.default.platform() === "darwin") {
                    const { stdout } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $9}'`);
                    if (stdout.trim())
                        cwd = stdout.trim();
                }
                else if (os_1.default.platform() === "linux") {
                    const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
                    if (stdout.trim())
                        cwd = stdout.trim();
                }
            }
            catch (e) {
                console.error("Error fetching CWD:", e);
            }
        }
        try {
            const { stdout, stderr } = await execAsync(command, { cwd });
            return { stdout, stderr, exitCode: 0 };
        }
        catch (e) {
            return { stdout: "", stderr: e.message, exitCode: e.code || 1 };
        }
    });
    // Get CWD
    electron_1.ipcMain.handle("terminal.getCwd", async (_event, sessionId) => {
        const session = sessions.get(sessionId);
        if (!session)
            return null;
        const pid = session.pid;
        const { exec } = await Promise.resolve().then(() => __importStar(require("child_process")));
        const { promisify } = await Promise.resolve().then(() => __importStar(require("util")));
        const execAsync = promisify(exec);
        try {
            if (os_1.default.platform() === "darwin") {
                const { stdout: lsofOut } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $NF}' `);
                return lsofOut.trim() || null;
            }
            else if (os_1.default.platform() === "linux") {
                const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
                return stdout.trim() || null;
            }
            return null;
        }
        catch {
            return null;
        }
    });
    electron_1.ipcMain.handle("terminal.getCompletions", async (_event, { prefix, cwd, sessionId, }) => {
        const { exec } = await Promise.resolve().then(() => __importStar(require("child_process")));
        const { promisify } = await Promise.resolve().then(() => __importStar(require("util")));
        const execAsync = promisify(exec);
        // Resolve CWD from session if available
        let workDir = cwd || process.env.HOME || "/";
        if (!cwd && sessionId) {
            const session = sessions.get(sessionId);
            if (session) {
                try {
                    const pid = session.pid;
                    if (os_1.default.platform() === "darwin") {
                        const { stdout } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $NF}'`);
                        if (stdout.trim())
                            workDir = stdout.trim();
                    }
                }
                catch { /* ignore */ }
            }
        }
        try {
            const parts = prefix.trim().split(/\s+/);
            if (parts.length <= 1) {
                const word = parts[0] || "";
                const { stdout } = await execAsync(`bash -c 'compgen -abck "${word}" 2>/dev/null | sort -u | head -30'`, { cwd: workDir });
                const results = stdout.trim().split("\n").filter(Boolean);
                return [...new Set(results)]
                    .sort((a, b) => a.length - b.length)
                    .slice(0, 15);
            }
            const lastWord = parts[parts.length - 1];
            const { stdout } = await execAsync(`bash -c 'compgen -df "${lastWord}" 2>/dev/null | head -30'`, { cwd: workDir });
            const results = stdout.trim().split("\n").filter(Boolean);
            return [...new Set(results)]
                .sort((a, b) => a.length - b.length)
                .slice(0, 15);
        }
        catch {
            return [];
        }
    });
    electron_1.ipcMain.handle("terminal.getHistory", (_event, sessionId) => {
        return sessionHistory.get(sessionId) || "";
    });
}
//# sourceMappingURL=terminal.js.map