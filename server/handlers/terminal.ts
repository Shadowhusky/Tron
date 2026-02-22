import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID, randomBytes } from "crypto";
import { exec, ChildProcess } from "child_process";
import { sshSessionIds, sshSessions } from "./ssh.js";

// Conditional node-pty import — gateway deployments may not have the native module
let pty: typeof import("node-pty") | null = null;
try {
  pty = await import("node-pty");
} catch {
  console.log("[Terminal] node-pty not available (expected in gateway mode)");
}

type IPty = import("node-pty").IPty;

/** Detect the best available shell. Avoids posix_spawnp failures on systems without /bin/zsh. */
function detectShell(): { shell: string; args: string[] } {
  if (os.platform() === "win32") {
    const winCandidates = ["pwsh.exe", "powershell.exe", "cmd.exe"];
    for (const candidate of winCandidates) {
      try {
        require("child_process").execSync(`where ${candidate}`, { stdio: "ignore" });
        return { shell: candidate, args: candidate === "cmd.exe" ? [] : ["-NoLogo"] };
      } catch { /* not found, try next */ }
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
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const isZsh = candidate.endsWith("/zsh");
        return { shell: candidate, args: isZsh ? ["+o", "PROMPT_SP"] : [] };
      }
    } catch { }
  }
  return { shell: "/bin/sh", args: [] };
}

const sessions = new Map<string, IPty>();
const sessionHistory = new Map<string, string>();
// Track which WS client owns each session
const sessionOwners = new Map<string, string>();
const activeChildProcesses = new Set<ChildProcess>();
// Per-session push functions for display buffering during execInTerminal
const sessionPushers = new Map<string, EventPusher>();
const execActiveSessions = new Set<string>();
const occupiedSessions = new Set<string>();
const displayBuffers = new Map<string, { data: string; timer?: ReturnType<typeof setTimeout> }>();

/** Strip sentinel patterns from terminal output. */
function stripSentinels(text: string): string {
  let d = text;
  const A = "(?:\\x1B\\[[0-9;]*[a-zA-Z])*";
  const unixRegex = new RegExp(`;${A}\\s*${A}printf${A}\\s+${A}["']?${A}\\\\n${A}__TRON_DONE_[a-z0-9]+__(?:%d|\\d+)${A}\\\\n${A}["']?${A}\\s*${A}\\$\\?${A}`, "g");
  d = d.replace(unixRegex, "");
  const unixRegexNoSemi = new RegExp(`printf${A}\\s+${A}["']?${A}\\\\n${A}__TRON_DONE_[a-z0-9]+__(?:%d|\\d+)${A}\\\\n${A}["']?${A}\\s*${A}\\$\\?${A}`, "g");
  d = d.replace(unixRegexNoSemi, "");
  d = d.replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
  d = d.replace(/Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
  d = d.replace(/\n?__TRON_DONE_[a-z0-9]+__(?:\d+|%d)/g, "");
  return d;
}

/** Clean captured output from execInTerminal. */
function cleanExecOutput(output: string, sentinel: string): string {
  let captured = output;
  // eslint-disable-next-line no-control-regex
  captured = captured.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  captured = captured.replace(/[^\n]*\r(?!\n)/g, "");
  const sentinelIdx = captured.indexOf(sentinel);
  if (sentinelIdx >= 0) captured = captured.slice(0, sentinelIdx);
  const firstNewline = captured.indexOf("\n");
  if (firstNewline >= 0) captured = captured.slice(firstNewline + 1);
  captured = captured.replace(/; printf '\\n__TRON_DONE_[^']*' \$\?/g, "");
  captured = captured.replace(/; printf [^\n]*$/m, "");
  captured = captured.replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
  captured = captured.replace(/; Write-Host [^\n]*$/m, "");
  // eslint-disable-next-line no-control-regex
  captured = captured.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  captured = captured.trim();
  if (captured.length > 8000) {
    captured = captured.slice(0, 4000) + "\n...(truncated)...\n" + captured.slice(-4000);
  }
  return captured;
}

/** Fuzzy file name suggestions for read/edit errors. */
function getFuzzySuggestions(targetPath: string): string[] {
  try {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath).toLowerCase();
    if (!base || !fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir);
    const matches = files.filter(f => {
      const fLower = f.toLowerCase();
      if (fLower.startsWith(base)) return true;
      if (base.length > 3 && fLower.startsWith(base.substring(0, 4))) return true;
      const parsed = path.parse(f);
      if (parsed.name.toLowerCase() === base) return true;
      return false;
    });
    return matches.sort((a, b) => Math.abs(a.length - base.length) - Math.abs(b.length - base.length)).slice(0, 5);
  } catch {
    return [];
  }
}

/** Spawn a child process and track it for cleanup. */
function trackedExec(
  command: string,
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = exec(command, options, (error, stdout, stderr) => {
      activeChildProcesses.delete(child);
      if (error) reject(error);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
    activeChildProcesses.add(child);
  });
}

/** Get CWD for a PID. Uses trackedExec for proper cleanup. */
async function getCwdForPid(pid: number): Promise<string | null> {
  try {
    if (os.platform() === "darwin") {
      const { stdout } = await trackedExec(
        `lsof -p ${pid} 2>/dev/null | grep ' cwd ' | awk '{print $NF}'`,
      );
      return stdout.trim() || null;
    } else if (os.platform() === "linux") {
      const { stdout } = await trackedExec(`readlink /proc/${pid}/cwd`);
      return stdout.trim() || null;
    } else if (os.platform() === "win32") {
      try {
        const { stdout } = await trackedExec(
          `powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; if ($p -and $p.ExecutablePath) { Split-Path $p.ExecutablePath -Parent }"`,
          { timeout: 5000 },
        );
        return stdout.trim() || null;
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export type EventPusher = (channel: string, data: any) => void;

export function getSessions() {
  return sessions;
}

export function getSessionOwners() {
  return sessionOwners;
}

export function getSessionHistory() {
  return sessionHistory;
}

export function cleanupClientSessions(clientId: string) {
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
    try { child.kill(); } catch { }
  }
  activeChildProcesses.clear();

  for (const [, session] of sessions) {
    try { session.kill(); } catch { }
  }
  sessions.clear();
  sessionHistory.clear();
  sessionOwners.clear();
}

export function sessionExists(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function createSession(
  { cols, rows, cwd, reconnectId }: { cols?: number; rows?: number; cwd?: string; reconnectId?: string },
  clientId: string,
  pushEvent: EventPusher
): string {
  if (!pty) {
    throw new Error("Local terminals not available (node-pty not loaded)");
  }

  if (reconnectId && sessions.has(reconnectId)) {
    const existing = sessions.get(reconnectId)!;
    try { existing.resize(cols || 80, rows || 30); } catch { }
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
    } as Record<string, string>,
  });

  sessionHistory.set(sessionId, "");
  sessionOwners.set(sessionId, clientId);
  sessionPushers.set(sessionId, pushEvent);

  ptyProcess.onData((data) => {
    const currentHistory = sessionHistory.get(sessionId) || "";
    if (currentHistory.length < 100000) {
      sessionHistory.set(sessionId, currentHistory + data);
    } else {
      sessionHistory.set(sessionId, currentHistory.slice(-80000) + data);
    }

    if (execActiveSessions.has(sessionId)) {
      // Buffer data for sentinel stripping during execInTerminal
      const buf = displayBuffers.get(sessionId) || { data: "" };
      buf.data += data;
      displayBuffers.set(sessionId, buf);
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(() => {
        const accumulated = buf.data;
        buf.data = "";
        const cleaned = stripSentinels(accumulated);
        if (cleaned) pushEvent("terminal.incomingData", { id: sessionId, data: cleaned });
      }, 10);
    } else {
      pushEvent("terminal.incomingData", { id: sessionId, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    pushEvent("terminal.exit", { id: sessionId, exitCode });
    sessions.delete(sessionId);
    sessionHistory.delete(sessionId);
    sessionOwners.delete(sessionId);
    sessionPushers.delete(sessionId);
    execActiveSessions.delete(sessionId);
    occupiedSessions.delete(sessionId);
    displayBuffers.delete(sessionId);
  });

  sessions.set(sessionId, ptyProcess);
  return sessionId;
}

export function writeToSession(id: string, data: string) {
  const session = sessions.get(id);
  if (session) session.write(data);
}

export function resizeSession(id: string, cols: number, rows: number) {
  const session = sessions.get(id);
  if (session) session.resize(cols, rows);
}

export function closeSession(id: string) {
  const session = sessions.get(id);
  if (session) {
    session.kill();
    sessions.delete(id);
    sessionHistory.delete(id);
    sessionOwners.delete(id);
  }
}

export async function checkCommand(command: string, sessionId?: string): Promise<boolean> {
  // SSH session: check on remote
  if (sessionId && sshSessionIds.has(sessionId)) {
    const sshSession = sshSessions.get(sessionId);
    if (sshSession) return sshSession.checkCommand(command);
    return false;
  }
  try {
    const checkCmd = os.platform() === "win32" ? `where ${command}` : `which ${command}`;
    await trackedExec(checkCmd);
    return true;
  } catch {
    return false;
  }
}

async function getSessionCwd(sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  let cwd = os.homedir() || "/";
  if (session) {
    const resolved = await getCwdForPid(session.pid);
    if (resolved) cwd = resolved;
  }
  return cwd;
}

export async function execCommand(sessionId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }> {
  // SSH session: exec on remote
  if (sshSessionIds.has(sessionId)) {
    const sshSession = sshSessions.get(sessionId);
    if (!sshSession) return { stdout: "", stderr: "SSH session not found", exitCode: 1 };
    try {
      return await sshSession.exec(command, 30000);
    } catch (e: any) {
      return { stdout: "", stderr: e.message, exitCode: 1 };
    }
  }

  const cwd = await getSessionCwd(sessionId);
  return new Promise((resolve) => {
    const child = exec(
      command,
      { cwd, timeout: 30000 },
      (error, stdout, stderr) => {
        activeChildProcesses.delete(child);
        if (error && (error as any).killed) {
          resolve({
            stdout: (stdout as string) || "",
            stderr: (stderr as string) || "",
            exitCode: 124,
            timedOut: true,
          });
        } else if (error) {
          resolve({
            stdout: (stdout as string) || "",
            stderr: (stderr as string) || error.message,
            exitCode: (error as any).code || 1,
          });
        } else {
          resolve({
            stdout: (stdout as string) || "",
            stderr: (stderr as string) || "",
            exitCode: 0,
          });
        }
      },
    );
    activeChildProcesses.add(child);
  });
}

export async function getCwd(sessionId: string): Promise<string | null> {
  // SSH session: get remote CWD
  if (sshSessionIds.has(sessionId)) {
    const sshSession = sshSessions.get(sessionId);
    if (sshSession) return sshSession.getCwd();
    return null;
  }
  const session = sessions.get(sessionId);
  if (!session) return null;
  return getCwdForPid(session.pid);
}

export async function getCompletions({ prefix, cwd, sessionId }: { prefix: string; cwd?: string; sessionId?: string }): Promise<string[]> {
  // SSH session: get completions from remote
  if (sessionId && sshSessionIds.has(sessionId)) {
    const sshSession = sshSessions.get(sessionId);
    if (sshSession) return sshSession.getCompletions(prefix);
    return [];
  }

  let workDir = cwd || process.env.HOME || "/";
  if (!cwd && sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      const resolved = await getCwdForPid(session.pid);
      if (resolved) workDir = resolved;
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
  } catch {
    return [];
  }
}

export function getHistory(sessionId: string): string {
  return sessionHistory.get(sessionId) || "";
}

export async function getSystemInfo(sessionId?: string): Promise<{ platform: string; arch: string; shell: string; release: string }> {
  // SSH session: get remote system info
  if (sessionId && sshSessionIds.has(sessionId)) {
    const sshSession = sshSessions.get(sessionId);
    if (sshSession) return sshSession.getSystemInfo();
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

// ------- Additional handlers for web mode parity -------

export function readHistory({ sessionId, lines = 100 }: { sessionId: string; lines?: number }): string {
  try {
    const history = sessionHistory.get(sessionId) || "";
    if (!history) return "(No terminal output yet)";
    // eslint-disable-next-line no-control-regex
    let clean = history.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
    clean = clean.replace(/[^\n]*\r(?!\n)/g, "");
    clean = clean.replace(/; printf '\\n__TRON_DONE_[^']*' \$\?/g, "");
    clean = clean.replace(/printf\s+'\\n__TRON_DONE_[^']*'\s*\$\?/g, "");
    clean = clean.replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
    clean = clean.replace(/Write-Host\s+["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
    clean = clean.replace(/__TRON_DONE_[a-z0-9]+__\d*/g, "");
    // eslint-disable-next-line no-control-regex
    clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    const allLines = clean.split("\n").filter(line => line.trim() !== "");
    return allLines.slice(-lines).join("\n") || "(No output)";
  } catch (err: any) {
    return `(Error reading terminal: ${err.message})`;
  }
}

export function clearHistory(sessionId: string): void {
  sessionHistory.set(sessionId, "");
}

export async function execInTerminal(
  { sessionId, command }: { sessionId: string; command: string },
): Promise<{ stdout: string; exitCode: number; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session) {
    return { stdout: "", exitCode: 1, error: "No PTY session found" };
  }

  // If a previous command left the terminal occupied, send Ctrl+C
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

  execActiveSessions.add(sessionId);

  const finishExec = () => {
    execActiveSessions.delete(sessionId);
    const buf = displayBuffers.get(sessionId);
    if (buf) {
      if (buf.timer) clearTimeout(buf.timer);
      setTimeout(() => {
        const remaining = buf.data;
        buf.data = "";
        if (remaining) {
          const cleaned = stripSentinels(remaining);
          const pusher = sessionPushers.get(sessionId);
          if (pusher && cleaned) {
            pusher("terminal.incomingData", { id: sessionId, data: cleaned });
          }
        }
        displayBuffers.delete(sessionId);
      }, 15);
    }
  };

  return new Promise<{ stdout: string; exitCode: number }>((resolve) => {
    let output = "";
    let resolved = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    const clearChar = os.platform() === "win32" ? "\x1b" : "\x15";
    session.write(clearChar);

    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!resolved && output.length > 0) {
          resolved = true;
          disposable.dispose();
          clearTimeout(hardTimer);
          occupiedSessions.add(sessionId);
          finishExec();
          resolve({ stdout: cleanExecOutput(output, sentinel), exitCode: 124 });
        }
      }, 3000);
    };

    const disposable = session.onData((data: string) => {
      output += data;
      resetStallTimer();

      const sentinelEscaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = output.match(new RegExp(`${sentinelEscaped}(\\d+)`));
      if (match) {
        resolved = true;
        disposable.dispose();
        clearTimeout(hardTimer);
        if (stallTimer) clearTimeout(stallTimer);
        occupiedSessions.delete(sessionId);
        const exitCode = parseInt(match[1], 10);
        const captured = cleanExecOutput(output, sentinel);
        finishExec();
        resolve({ stdout: captured, exitCode });
      }
    });

    session.write(wrappedCommand + "\r");
    resetStallTimer();

    const hardTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        disposable.dispose();
        if (stallTimer) clearTimeout(stallTimer);
        occupiedSessions.add(sessionId);
        finishExec();
        resolve({ stdout: cleanExecOutput(output, sentinel), exitCode: 124 });
      }
    }, 30000);
  });
}

export async function scanCommands(): Promise<string[]> {
  const isWin = os.platform() === "win32";
  const results: string[] = [];

  if (isWin) {
    try {
      const cmd = `powershell -NoProfile -Command "Get-Command -CommandType Application,Cmdlet | Select-Object -ExpandProperty Name -First 500"`;
      const { stdout } = await trackedExec(cmd, { timeout: 10000 });
      results.push(...stdout.trim().split("\n").filter(Boolean));
    } catch { /* non-critical */ }
  } else {
    try {
      const { stdout } = await trackedExec(
        `bash -c 'compgen -abck 2>/dev/null | sort -u | head -1000'`,
        { timeout: 5000 },
      );
      results.push(...stdout.trim().split("\n").filter(Boolean));
    } catch { /* non-critical */ }
    try {
      const shell = process.env.SHELL || "/bin/bash";
      const isBash = shell.endsWith("/bash");
      const funcCmd = isBash
        ? `${shell} -lic 'compgen -A function 2>/dev/null' </dev/null`
        : `${shell} -lic 'print -l \${(ok)functions} 2>/dev/null' </dev/null`;
      const { stdout } = await trackedExec(funcCmd, { timeout: 8000 });
      results.push(...stdout.trim().split("\n").filter(Boolean));
    } catch { /* non-critical */ }
  }

  return [...new Set(results)];
}

export async function writeFile(
  { filePath, content }: { filePath: string; content: string },
): Promise<{ success: boolean; existed?: boolean; error?: string }> {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existed = fs.existsSync(filePath);
    fs.writeFileSync(filePath, content, "utf-8");
    return { success: true, existed };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function readFile(
  { filePath }: { filePath: string },
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    if (!fs.existsSync(filePath)) {
      const suggestions = getFuzzySuggestions(filePath);
      const sugStr = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      return { success: false, error: `File not found: ${filePath}.${sugStr}` };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return { success: true, content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function editFile(
  { filePath, search, replace }: { filePath: string; search: string; replace: string },
): Promise<{ success: boolean; replacements?: number; error?: string }> {
  try {
    if (!fs.existsSync(filePath)) {
      const suggestions = getFuzzySuggestions(filePath);
      const sugStr = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      return { success: false, error: `File not found: ${filePath}.${sugStr}` };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes(search)) {
      return { success: false, error: `Search string not found in file. Make sure the search text matches exactly (including whitespace and newlines).` };
    }
    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(search, idx)) !== -1) { count++; idx += search.length; }
    const updated = content.split(search).join(replace);
    fs.writeFileSync(filePath, updated, "utf-8");
    return { success: true, replacements: count };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function listDir(
  { dirPath }: { dirPath: string },
): Promise<{ success: boolean; contents?: { name: string; isDirectory: boolean }[]; error?: string }> {
  try {
    if (!fs.existsSync(dirPath)) return { success: false, error: `Directory not found: ${dirPath}` };
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) return { success: false, error: `Path is not a directory: ${dirPath}` };
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const contents = items.map((item) => ({ name: item.name, isDirectory: item.isDirectory() }));
    contents.sort((a, b) => {
      if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
      return a.isDirectory ? -1 : 1;
    });
    return { success: true, contents };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function searchDir(
  { dirPath, query }: { dirPath: string; query: string },
): Promise<{ success: boolean; results?: { file: string; line: number; content: string }[]; error?: string }> {
  try {
    if (!fs.existsSync(dirPath)) return { success: false, error: `Directory not found: ${dirPath}` };
    const results: { file: string; line: number; content: string }[] = [];
    const maxResults = 50;

    function walk(dir: string) {
      if (results.length >= maxResults) return;
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (results.length >= maxResults) break;
        if (item.name === "node_modules" || item.name === ".git" || item.name === "dist" || item.name === "build") continue;
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(fullPath);
        } else {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 2 * 1024 * 1024) continue;
            const content = fs.readFileSync(fullPath, "utf-8");
            if (content.includes("\0")) continue;
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                results.push({ file: fullPath, line: i + 1, content: lines[i].trim().slice(0, 150) });
                if (results.length >= maxResults) break;
              }
            }
          } catch { /* ignore individual file read errors */ }
        }
      }
    }

    walk(dirPath);
    return { success: true, results };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function saveSessionLog(
  data: {
    sessionId: string;
    session: Record<string, unknown>;
    interactions: { role: string; content: string; timestamp: number }[];
    agentThread: { step: string; output: string; payload?: any }[];
    contextSummary?: string;
  },
): Promise<{ success: boolean; logId?: string; filePath?: string; error?: string }> {
  try {
    const { session: sessionMeta, interactions, agentThread, contextSummary } = data;
    const transientSteps = new Set(["streaming", "thinking", "executing"]);
    const cleanedThread = agentThread.filter((s) => !transientSteps.has(s.step));

    const structuredThread = cleanedThread.map((s) => {
      if (s.step === "separator" && s.output.includes("\n---images---\n")) {
        return { step: s.step, prompt: s.output.slice(0, s.output.indexOf("\n---images---\n")), note: "(images attached)", payload: s.payload };
      }
      if (s.step === "separator") return { step: s.step, prompt: s.output, payload: s.payload };

      if ((s.step === "executed" || s.step === "failed") && s.output.includes("\n---\n")) {
        const idx = s.output.indexOf("\n---\n");
        const command = s.output.slice(0, idx);
        let terminalOutput = s.output.slice(idx + 5);
        // eslint-disable-next-line no-control-regex
        terminalOutput = terminalOutput.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
        terminalOutput = stripSentinels(terminalOutput);
        // eslint-disable-next-line no-control-regex
        terminalOutput = terminalOutput.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
        return { step: s.step, command, terminalOutput, payload: s.payload };
      }

      return { step: s.step, content: s.output, payload: s.payload };
    });

    const logId = randomBytes(5).toString("hex");
    const logsDir = path.join(os.homedir(), ".tron", "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `${logId}.json`);

    const logData = {
      logId,
      version: 2,
      generatedAt: new Date().toISOString(),
      session: sessionMeta,
      interactions,
      agentThread: structuredThread,
      contextSummary: contextSummary || undefined,
    };

    fs.writeFileSync(filePath, JSON.stringify(logData, null, 2), "utf-8");
    return { success: true, logId, filePath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
