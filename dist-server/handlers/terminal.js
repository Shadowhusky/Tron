import * as pty from "node-pty";
import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { sshSessionIds, sshSessions } from "./ssh.js";
/** Detect the best available shell. Avoids posix_spawnp failures on systems without /bin/zsh. */
function detectShell() {
    if (os.platform() === "win32") {
        const winCandidates = ["pwsh.exe", "powershell.exe", "cmd.exe"];
        for (const candidate of winCandidates) {
            try {
                require("child_process").execSync(`where ${candidate}`, { stdio: "ignore" });
                return { shell: candidate, args: candidate === "cmd.exe" ? [] : ["-NoLogo"] };
            }
            catch { /* not found, try next */ }
        }
        return { shell: "cmd.exe", args: [] };
    }
    const candidates = [
        process.env.SHELL,
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/sh",
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                const isZsh = candidate.endsWith("/zsh");
                return { shell: candidate, args: isZsh ? ["+o", "PROMPT_SP"] : [] };
            }
        }
        catch { }
    }
    return { shell: "/bin/sh", args: [] };
}
const sessions = new Map();
const sessionHistory = new Map();
// Track which WS client owns each session
const sessionOwners = new Map();
const activeChildProcesses = new Set();
/** Spawn a child process and track it for cleanup. */
function trackedExec(command, options) {
    return new Promise((resolve, reject) => {
        const child = exec(command, options, (error, stdout, stderr) => {
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
        if (os.platform() === "darwin") {
            const { stdout } = await trackedExec(`lsof -p ${pid} 2>/dev/null | grep ' cwd ' | awk '{print $NF}'`);
            return stdout.trim() || null;
        }
        else if (os.platform() === "linux") {
            const { stdout } = await trackedExec(`readlink /proc/${pid}/cwd`);
            return stdout.trim() || null;
        }
        else if (os.platform() === "win32") {
            try {
                const { stdout } = await trackedExec(`powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; if ($p -and $p.ExecutablePath) { Split-Path $p.ExecutablePath -Parent }"`, { timeout: 5000 });
                return stdout.trim() || null;
            }
            catch {
                return null;
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
export function getSessions() {
    return sessions;
}
export function getSessionOwners() {
    return sessionOwners;
}
export function getSessionHistory() {
    return sessionHistory;
}
export function cleanupClientSessions(clientId) {
    for (const [sessionId, owner] of sessionOwners.entries()) {
        if (owner === clientId) {
            const session = sessions.get(sessionId);
            if (session) {
                session.kill();
                sessions.delete(sessionId);
                sessionHistory.delete(sessionId);
            }
            sessionOwners.delete(sessionId);
        }
    }
}
/** Kill all tracked child processes and PTY sessions. */
export function cleanupAllServerSessions() {
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
    sessionOwners.clear();
}
export function sessionExists(sessionId) {
    return sessions.has(sessionId);
}
export function createSession({ cols, rows, cwd, reconnectId }, clientId, pushEvent) {
    if (reconnectId && sessions.has(reconnectId)) {
        const existing = sessions.get(reconnectId);
        try {
            existing.resize(cols || 80, rows || 30);
        }
        catch { }
        sessionOwners.set(reconnectId, clientId);
        return reconnectId;
    }
    const { shell, args: shellArgs } = detectShell();
    const sessionId = randomUUID();
    const ptyProcess = pty.spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols: cols || 80,
        rows: rows || 30,
        cwd: cwd || os.homedir(),
        env: {
            ...process.env,
            ...(os.platform() !== "win32" ? { PROMPT_EOL_MARK: "" } : {}),
        },
    });
    sessionHistory.set(sessionId, "");
    sessionOwners.set(sessionId, clientId);
    ptyProcess.onData((data) => {
        const currentHistory = sessionHistory.get(sessionId) || "";
        if (currentHistory.length < 100000) {
            sessionHistory.set(sessionId, currentHistory + data);
        }
        else {
            sessionHistory.set(sessionId, currentHistory.slice(-80000) + data);
        }
        pushEvent("terminal.incomingData", { id: sessionId, data });
    });
    ptyProcess.onExit(({ exitCode }) => {
        pushEvent("terminal.exit", { id: sessionId, exitCode });
        sessions.delete(sessionId);
        sessionHistory.delete(sessionId);
        sessionOwners.delete(sessionId);
    });
    sessions.set(sessionId, ptyProcess);
    return sessionId;
}
export function writeToSession(id, data) {
    const session = sessions.get(id);
    if (session)
        session.write(data);
}
export function resizeSession(id, cols, rows) {
    const session = sessions.get(id);
    if (session)
        session.resize(cols, rows);
}
export function closeSession(id) {
    const session = sessions.get(id);
    if (session) {
        session.kill();
        sessions.delete(id);
        sessionHistory.delete(id);
        sessionOwners.delete(id);
    }
}
export async function checkCommand(command, sessionId) {
    // SSH session: check on remote
    if (sessionId && sshSessionIds.has(sessionId)) {
        const sshSession = sshSessions.get(sessionId);
        if (sshSession)
            return sshSession.checkCommand(command);
        return false;
    }
    try {
        const checkCmd = os.platform() === "win32" ? `where ${command}` : `which ${command}`;
        await trackedExec(checkCmd);
        return true;
    }
    catch {
        return false;
    }
}
async function getSessionCwd(sessionId) {
    const session = sessions.get(sessionId);
    let cwd = os.homedir() || "/";
    if (session) {
        const resolved = await getCwdForPid(session.pid);
        if (resolved)
            cwd = resolved;
    }
    return cwd;
}
export async function execCommand(sessionId, command) {
    // SSH session: exec on remote
    if (sshSessionIds.has(sessionId)) {
        const sshSession = sshSessions.get(sessionId);
        if (!sshSession)
            return { stdout: "", stderr: "SSH session not found", exitCode: 1 };
        try {
            return await sshSession.exec(command, 30000);
        }
        catch (e) {
            return { stdout: "", stderr: e.message, exitCode: 1 };
        }
    }
    const cwd = await getSessionCwd(sessionId);
    return new Promise((resolve) => {
        const child = exec(command, { cwd, timeout: 30000 }, (error, stdout, stderr) => {
            activeChildProcesses.delete(child);
            if (error && error.killed) {
                resolve({
                    stdout: stdout || "",
                    stderr: stderr || "",
                    exitCode: 124,
                    timedOut: true,
                });
            }
            else if (error) {
                resolve({
                    stdout: stdout || "",
                    stderr: stderr || error.message,
                    exitCode: error.code || 1,
                });
            }
            else {
                resolve({
                    stdout: stdout || "",
                    stderr: stderr || "",
                    exitCode: 0,
                });
            }
        });
        activeChildProcesses.add(child);
    });
}
export async function getCwd(sessionId) {
    // SSH session: get remote CWD
    if (sshSessionIds.has(sessionId)) {
        const sshSession = sshSessions.get(sessionId);
        if (sshSession)
            return sshSession.getCwd();
        return null;
    }
    const session = sessions.get(sessionId);
    if (!session)
        return null;
    return getCwdForPid(session.pid);
}
export async function getCompletions({ prefix, cwd, sessionId }) {
    // SSH session: get completions from remote
    if (sessionId && sshSessionIds.has(sessionId)) {
        const sshSession = sshSessions.get(sessionId);
        if (sshSession)
            return sshSession.getCompletions(prefix);
        return [];
    }
    let workDir = cwd || process.env.HOME || "/";
    if (!cwd && sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
            const resolved = await getCwdForPid(session.pid);
            if (resolved)
                workDir = resolved;
        }
    }
    try {
        const parts = prefix.trim().split(/\s+/);
        const isWin = os.platform() === "win32";
        if (parts.length <= 1) {
            const word = parts[0] || "";
            const safeWinWord = word.replace(/'/g, "''");
            const safeUnixWord = word.replace(/"/g, '\\"');
            const cmd = isWin
                ? `powershell -NoProfile -Command "Get-Command '${safeWinWord}*' -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty Name"`
                : `bash -c 'compgen -abck "${safeUnixWord}" 2>/dev/null | sort -u | head -30'`;
            const { stdout } = await trackedExec(cmd, { cwd: workDir });
            const results = stdout.trim().split("\n").filter(Boolean);
            return [...new Set(results)].sort((a, b) => a.length - b.length).slice(0, 15);
        }
        const lastWord = parts[parts.length - 1];
        const safeWinLastWord = lastWord.replace(/'/g, "''");
        const safeUnixLastWord = lastWord.replace(/"/g, '\\"');
        const cmd = isWin
            ? `powershell -NoProfile -Command "Get-ChildItem '${safeWinLastWord}*' -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty Name"`
            : `bash -c 'compgen -df "${safeUnixLastWord}" 2>/dev/null | head -30'`;
        const { stdout } = await trackedExec(cmd, { cwd: workDir });
        const results = stdout.trim().split("\n").filter(Boolean);
        return [...new Set(results)].sort((a, b) => a.length - b.length).slice(0, 15);
    }
    catch {
        return [];
    }
}
export function getHistory(sessionId) {
    return sessionHistory.get(sessionId) || "";
}
export async function getSystemInfo(sessionId) {
    // SSH session: get remote system info
    if (sessionId && sshSessionIds.has(sessionId)) {
        const sshSession = sshSessions.get(sessionId);
        if (sshSession)
            return sshSession.getSystemInfo();
        return { platform: "linux", arch: "unknown", shell: "bash", release: "unknown" };
    }
    const { shell } = detectShell();
    const shellName = path.basename(shell).replace(/\.exe$/i, "");
    return {
        platform: os.platform(),
        arch: os.arch(),
        shell: shellName,
        release: os.release(),
    };
}
//# sourceMappingURL=terminal.js.map