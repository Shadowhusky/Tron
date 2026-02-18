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
exports.cleanupAllSessions = cleanupAllSessions;
exports.registerTerminalHandlers = registerTerminalHandlers;
const electron_1 = require("electron");
const pty = __importStar(require("node-pty"));
const os_1 = __importDefault(require("os"));
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const sessions = new Map();
const sessionHistory = new Map();
const activeChildProcesses = new Set();
/** Spawn a child process and track it for cleanup. */
function trackedExec(command, options) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.exec)(command, options, (error, stdout, stderr) => {
            activeChildProcesses.delete(child);
            if (error)
                reject(error);
            else
                resolve({ stdout: stdout, stderr: stderr });
        });
        activeChildProcesses.add(child);
    });
}
/** Get CWD for a PID. Uses trackedExec for proper cleanup. */
async function getCwdForPid(pid) {
    try {
        if (os_1.default.platform() === "darwin") {
            const { stdout } = await trackedExec(`lsof -p ${pid} 2>/dev/null | grep ' cwd ' | awk '{print $NF}'`);
            return stdout.trim() || null;
        }
        else if (os_1.default.platform() === "linux") {
            const { stdout } = await trackedExec(`readlink /proc/${pid}/cwd`);
            return stdout.trim() || null;
        }
        else if (os_1.default.platform() === "win32") {
            const { stdout } = await trackedExec(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).Path"`);
            return stdout.trim() || null;
        }
        return null;
    }
    catch {
        return null;
    }
}
function getSessions() {
    return sessions;
}
function getSessionHistory() {
    return sessionHistory;
}
/** Kill all tracked child processes and PTY sessions. */
function cleanupAllSessions() {
    for (const child of activeChildProcesses) {
        try {
            child.kill();
        }
        catch { }
    }
    activeChildProcesses.clear();
    for (const [, session] of sessions) {
        try {
            session.kill();
        }
        catch { }
    }
    sessions.clear();
    sessionHistory.clear();
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
                cwd: cwd || os_1.default.homedir(),
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
        try {
            const checkCmd = os_1.default.platform() === "win32" ? `where ${command}` : `which ${command}`;
            await trackedExec(checkCmd);
            return true;
        }
        catch {
            return false;
        }
    });
    // Agent Execution
    electron_1.ipcMain.handle("terminal.exec", async (_event, { sessionId, command }) => {
        const session = sessions.get(sessionId);
        let cwd = os_1.default.homedir() || "/";
        if (session) {
            const resolved = await getCwdForPid(session.pid);
            if (resolved)
                cwd = resolved;
        }
        try {
            const { stdout, stderr } = await trackedExec(command, { cwd });
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
        return getCwdForPid(session.pid);
    });
    electron_1.ipcMain.handle("terminal.getCompletions", async (_event, { prefix, cwd, sessionId, }) => {
        // Resolve CWD from session if available
        let workDir = cwd || os_1.default.homedir() || "/";
        if (!cwd && sessionId) {
            const session = sessions.get(sessionId);
            if (session) {
                const resolved = await getCwdForPid(session.pid);
                if (resolved)
                    workDir = resolved;
            }
        }
        try {
            const isWin = os_1.default.platform() === "win32";
            const parts = prefix.trim().split(/\s+/);
            if (parts.length <= 1) {
                const word = parts[0] || "";
                const cmd = isWin
                    ? `powershell -NoProfile -Command "Get-Command '${word}*' -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty Name"`
                    : `bash -c 'compgen -abck "${word}" 2>/dev/null | sort -u | head -30'`;
                const { stdout } = await trackedExec(cmd, { cwd: workDir });
                const results = stdout.trim().split("\n").filter(Boolean);
                return [...new Set(results)]
                    .sort((a, b) => a.length - b.length)
                    .slice(0, 15);
            }
            const lastWord = parts[parts.length - 1];
            const cmd = isWin
                ? `powershell -NoProfile -Command "Get-ChildItem '${lastWord}*' -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty Name"`
                : `bash -c 'compgen -df "${lastWord}" 2>/dev/null | head -30'`;
            const { stdout } = await trackedExec(cmd, { cwd: workDir });
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
    // Scan all available commands on the system (for auto-mode classification)
    electron_1.ipcMain.handle("terminal.scanCommands", async () => {
        const isWin = os_1.default.platform() === "win32";
        try {
            const cmd = isWin
                ? `powershell -NoProfile -Command "Get-Command -CommandType Application,Cmdlet | Select-Object -ExpandProperty Name -First 500"`
                : `bash -c 'compgen -abck 2>/dev/null | sort -u | head -500'`;
            const { stdout } = await trackedExec(cmd, { timeout: 10000 });
            return stdout.trim().split("\n").filter(Boolean);
        }
        catch {
            return [];
        }
    });
    // Execute a command visibly in the PTY and capture output via sentinel marker.
    // The command runs in the user's terminal so they see it, but we also capture
    // the output to feed back to the agent.
    electron_1.ipcMain.handle("terminal.execInTerminal", async (_event, { sessionId, command }) => {
        const session = sessions.get(sessionId);
        if (!session) {
            return { stdout: "", exitCode: 1, error: "No PTY session found" };
        }
        // Use a unique sentinel so concurrent calls don't collide
        const nonce = Math.random().toString(36).slice(2, 8);
        const sentinel = `__TRON_DONE_${nonce}__`;
        // Wrap: run command, then emit sentinel with exit code.
        const isWin = os_1.default.platform() === "win32";
        const wrappedCommand = isWin
            ? `${command}; Write-Host "${sentinel}$LASTEXITCODE"`
            : `${command}; printf '\\n${sentinel}%d\\n' $?`;
        return new Promise((resolve) => {
            let output = "";
            let resolved = false;
            const disposable = session.onData((data) => {
                output += data;
                // Look for the sentinel in accumulated output
                const sentinelEscaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const match = output.match(new RegExp(`${sentinelEscaped}(\\d+)`));
                if (match) {
                    resolved = true;
                    disposable.dispose();
                    clearTimeout(timer);
                    const exitCode = parseInt(match[1], 10);
                    // --- Clean up captured output ---
                    let captured = output;
                    // 1. Strip ANSI escape codes
                    // eslint-disable-next-line no-control-regex
                    captured = captured.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
                    // 2. Remove the sentinel line (and everything after it — prompt noise)
                    const sentinelIdx = captured.indexOf(sentinel);
                    if (sentinelIdx >= 0) {
                        captured = captured.slice(0, sentinelIdx);
                    }
                    // 3. Remove the echoed command line (first line contains the wrapped command)
                    //    The shell echoes back what we wrote; strip it.
                    const firstNewline = captured.indexOf("\n");
                    if (firstNewline >= 0) {
                        captured = captured.slice(firstNewline + 1);
                    }
                    // 4. Also strip any trailing printf wrapper echo that some shells show
                    captured = captured.replace(/; printf [^\n]*$/m, "");
                    captured = captured.trim();
                    // 5. Truncate very large output
                    if (captured.length > 8000) {
                        captured =
                            captured.slice(0, 4000) +
                                "\n...(truncated)...\n" +
                                captured.slice(-4000);
                    }
                    resolve({ stdout: captured, exitCode });
                }
            });
            // Write the wrapped command to the PTY
            session.write(wrappedCommand + "\r");
            // Timeout after 30s
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    disposable.dispose();
                    resolve({
                        stdout: output.trim() || "(Command timed out after 30s)",
                        exitCode: 124,
                    });
                }
            }, 30000);
        });
    });
}
//# sourceMappingURL=terminal.js.map