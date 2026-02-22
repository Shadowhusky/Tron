import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { sshSessionIds, sshSessions } from "./ssh.js";
// Conditional node-pty import — gateway deployments may not have the native module
let pty = null;
try {
    pty = await import("node-pty");
}
catch {
    console.log("[Terminal] node-pty not available (expected in gateway mode)");
}
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
    if (!pty) {
        throw new Error("Local terminals not available (node-pty not loaded)");
    }
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
// --- Additional handlers needed for web mode ---
function stripSentinels(text) {
    return text
        .replace(/; printf '\\n__TRON_DONE_[^']*' \$\?/g, "")
        .replace(/printf\s+'\\n__TRON_DONE_[^']*'\s*\$\?/g, "")
        .replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "")
        .replace(/Write-Host\s+["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "")
        .replace(/__TRON_DONE_[a-z0-9]+__\d*/g, "");
}
export function readHistory(sessionId, lines = 100) {
    try {
        const history = sessionHistory.get(sessionId) || "";
        if (!history)
            return "(No terminal output yet)";
        // eslint-disable-next-line no-control-regex
        let clean = history.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
        clean = clean.replace(/[^\n]*\r(?!\n)/g, "");
        clean = stripSentinels(clean);
        // eslint-disable-next-line no-control-regex
        clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
        const allLines = clean.split("\n").filter(line => line.trim() !== "");
        return allLines.slice(-lines).join("\n") || "(No output)";
    }
    catch (err) {
        return `(Error reading terminal: ${err.message})`;
    }
}
export function clearHistory(sessionId) {
    sessionHistory.set(sessionId, "");
}
const occupiedSessions = new Set();
export async function execInTerminal(sessionId, command, pushEvent) {
    const session = sessions.get(sessionId);
    if (!session) {
        return { stdout: "", exitCode: 1, error: "No PTY session found" };
    }
    if (occupiedSessions.has(sessionId)) {
        occupiedSessions.delete(sessionId);
        session.write("\x03");
        await new Promise(r => setTimeout(r, 500));
    }
    const nonce = Math.random().toString(36).slice(2, 8);
    const sentinel = `__TRON_DONE_${nonce}__`;
    const isWin = os.platform() === "win32";
    const wrappedCommand = isWin
        ? `${command}; Write-Host "${sentinel}$LASTEXITCODE"`
        : `${command}; printf '\\n${sentinel}%d\\n' $?`;
    const clearChar = isWin ? "\x1b" : "\x15";
    session.write(clearChar);
    return new Promise((resolve) => {
        let output = "";
        let resolved = false;
        let stallTimer = null;
        const resetStallTimer = () => {
            if (stallTimer)
                clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                if (!resolved && output.length > 0) {
                    resolved = true;
                    disposable.dispose();
                    clearTimeout(hardTimer);
                    occupiedSessions.add(sessionId);
                    resolve({ stdout: cleanExecOutput(output, sentinel), exitCode: 124 });
                }
            }, 3000);
        };
        const disposable = session.onData((data) => {
            output += data;
            resetStallTimer();
            const sentinelEscaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const match = output.match(new RegExp(`${sentinelEscaped}(\\d+)`));
            if (match) {
                resolved = true;
                disposable.dispose();
                clearTimeout(hardTimer);
                if (stallTimer)
                    clearTimeout(stallTimer);
                occupiedSessions.delete(sessionId);
                resolve({ stdout: cleanExecOutput(output, sentinel), exitCode: parseInt(match[1], 10) });
            }
        });
        session.write(wrappedCommand + "\r");
        resetStallTimer();
        const hardTimer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                disposable.dispose();
                if (stallTimer)
                    clearTimeout(stallTimer);
                occupiedSessions.add(sessionId);
                resolve({ stdout: cleanExecOutput(output, sentinel), exitCode: 124 });
            }
        }, 30000);
    });
}
function cleanExecOutput(raw, sentinel) {
    // eslint-disable-next-line no-control-regex
    let clean = raw.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
    clean = clean.replace(/[^\n]*\r(?!\n)/g, "");
    clean = stripSentinels(clean);
    // eslint-disable-next-line no-control-regex
    clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    return clean.trim();
}
export async function scanCommands() {
    try {
        const isWin = os.platform() === "win32";
        const cmd = isWin
            ? "powershell -Command \"Get-Command -CommandType Application,Cmdlet | Select-Object -ExpandProperty Name | Select-Object -First 200\""
            : "compgen -c 2>/dev/null | sort -u | head -200";
        const { stdout } = await new Promise((resolve, reject) => {
            exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
                if (err)
                    reject(err);
                else
                    resolve({ stdout, stderr });
            });
        });
        return stdout.trim().split("\n").filter(Boolean);
    }
    catch {
        return [];
    }
}
// File operations
export function writeFile(filePath, content) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const existed = fs.existsSync(filePath);
        fs.writeFileSync(filePath, content, "utf-8");
        return { success: true, existed };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
export function readFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `File not found: ${filePath}` };
        }
        const content = fs.readFileSync(filePath, "utf-8");
        return { success: true, content };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
export function editFile(filePath, search, replace) {
    try {
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `File not found: ${filePath}` };
        }
        const content = fs.readFileSync(filePath, "utf-8");
        if (!content.includes(search)) {
            return { success: false, error: "Search string not found in file." };
        }
        let count = 0;
        let idx = 0;
        while ((idx = content.indexOf(search, idx)) !== -1) {
            count++;
            idx += search.length;
        }
        const updated = content.split(search).join(replace);
        fs.writeFileSync(filePath, updated, "utf-8");
        return { success: true, replacements: count };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
export function listDir(dirPath) {
    try {
        if (!fs.existsSync(dirPath))
            return { success: false, error: `Directory not found: ${dirPath}` };
        const stats = fs.statSync(dirPath);
        if (!stats.isDirectory())
            return { success: false, error: `Not a directory: ${dirPath}` };
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        const contents = items.map(item => ({ name: item.name, isDirectory: item.isDirectory() }));
        contents.sort((a, b) => {
            if (a.isDirectory === b.isDirectory)
                return a.name.localeCompare(b.name);
            return a.isDirectory ? -1 : 1;
        });
        return { success: true, contents };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
export function searchDir(dirPath, query) {
    try {
        if (!fs.existsSync(dirPath))
            return { success: false, error: `Directory not found: ${dirPath}` };
        const results = [];
        const maxResults = 50;
        function walk(dir) {
            if (results.length >= maxResults)
                return;
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                if (results.length >= maxResults)
                    break;
                if (["node_modules", ".git", "dist", "build"].includes(item.name))
                    continue;
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    walk(fullPath);
                    continue;
                }
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > 2 * 1024 * 1024)
                        continue;
                    const content = fs.readFileSync(fullPath, "utf-8");
                    if (content.includes("\0"))
                        continue;
                    const lines = content.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes(query)) {
                            results.push({ file: fullPath, line: i + 1, content: lines[i].trim().slice(0, 150) });
                            if (results.length >= maxResults)
                                break;
                        }
                    }
                }
                catch { /* skip unreadable */ }
            }
        }
        walk(dirPath);
        return { success: true, results };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
export function saveSessionLog(data) {
    try {
        const transientSteps = new Set(["streaming", "thinking", "executing"]);
        const cleanedThread = data.agentThread.filter(s => !transientSteps.has(s.step));
        const structuredThread = cleanedThread.map(s => {
            if (s.step === "separator")
                return { step: s.step, prompt: s.output, payload: s.payload };
            if ((s.step === "executed" || s.step === "failed") && s.output.includes("\n---\n")) {
                const idx = s.output.indexOf("\n---\n");
                let terminalOutput = s.output.slice(idx + 5);
                // eslint-disable-next-line no-control-regex
                terminalOutput = terminalOutput.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
                terminalOutput = stripSentinels(terminalOutput);
                // eslint-disable-next-line no-control-regex
                terminalOutput = terminalOutput.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
                return { step: s.step, command: s.output.slice(0, idx), terminalOutput, payload: s.payload };
            }
            return { step: s.step, content: s.output, payload: s.payload };
        });
        const logId = randomUUID().slice(0, 10);
        const logsDir = path.join(os.homedir(), ".tron", "logs");
        if (!fs.existsSync(logsDir))
            fs.mkdirSync(logsDir, { recursive: true });
        const filePath = path.join(logsDir, `${logId}.json`);
        const logData = {
            logId, version: 2, generatedAt: new Date().toISOString(),
            session: data.session, interactions: data.interactions,
            agentThread: structuredThread, contextSummary: data.contextSummary,
        };
        fs.writeFileSync(filePath, JSON.stringify(logData, null, 2), "utf-8");
        return { success: true, logId, filePath };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
//# sourceMappingURL=terminal.js.map