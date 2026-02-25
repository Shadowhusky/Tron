import { ipcMain, BrowserWindow, app } from "electron";
import * as pty from "node-pty";
import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID, randomBytes } from "crypto";
import { exec, ChildProcess } from "child_process";
import { sshSessionIds, sshSessions } from "./ssh";

/** Strip sentinel patterns from display data (Unix printf + Windows Write-Host) */
function stripSentinels(text: string): string {
  let d = text;
  // Match ANSI escape codes (e.g., \x1b[32m) injected by zsh-syntax-highlighting
  const A = "(?:\\x1B\\[[0-9;]*[a-zA-Z])*";

  // Unix: "; printf '\n__TRON_DONE_...' $?" (ignores ANSI colors anywhere inside)
  const unixRegex = new RegExp(`;${A}\\s*${A}printf${A}\\s+${A}["']?${A}\\\\n${A}__TRON_DONE_[a-z0-9]+__(?:%d|\\d+)${A}\\\\n${A}["']?${A}\\s*${A}\\$\\?${A}`, "g");
  d = d.replace(unixRegex, "");

  const unixRegexNoSemi = new RegExp(`printf${A}\\s+${A}["']?${A}\\\\n${A}__TRON_DONE_[a-z0-9]+__(?:%d|\\d+)${A}\\\\n${A}["']?${A}\\s*${A}\\$\\?${A}`, "g");
  d = d.replace(unixRegexNoSemi, "");

  // Windows: '; Write-Host "__TRON_DONE_...$LASTEXITCODE"'
  d = d.replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
  d = d.replace(/Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");

  // Sentinel output itself (e.g. __TRON_DONE_abc12345__0 or __TRON_DONE_...__%d)
  // Only consume leading \n (part of printf format), keep trailing \n so prompt starts on new line
  d = d.replace(/\n?__TRON_DONE_[a-z0-9]+__(?:\d+|%d)/g, "");
  return d;
}

/** Detect the best available shell. Avoids posix_spawnp failures on systems without /bin/zsh. */
function detectShell(): { shell: string; args: string[] } {
  if (os.platform() === "win32") {
    // Prefer PowerShell 7+ (pwsh), fall back to Windows PowerShell, then cmd
    const winCandidates = ["pwsh.exe", "powershell.exe", "cmd.exe"];
    for (const candidate of winCandidates) {
      try {
        require("child_process").execSync(`where ${candidate}`, { stdio: "ignore" });
        return { shell: candidate, args: candidate === "cmd.exe" ? [] : ["-NoLogo"] };
      } catch { /* not found, try next */ }
    }
    return { shell: "cmd.exe", args: [] };
  }
  // Prefer user's SHELL env, then try common paths
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
  // Ultimate fallback
  return { shell: "/bin/sh", args: [] };
}

const sessions = new Map<string, pty.IPty>();
const sessionHistory = new Map<string, string>();
const occupiedSessions = new Set<string>(); // Sessions with a stalled process still running
const activeChildProcesses = new Set<ChildProcess>();

// Per-session display buffering — active during execInTerminal to strip sentinels cleanly
interface DisplayBuffer { data: string; timer: ReturnType<typeof setTimeout> | null; send: (cleaned: string) => void }
const displayBuffers = new Map<string, DisplayBuffer>();
const execActiveSessions = new Set<string>(); // Sessions currently running execInTerminal

/**
 * If the session is currently running execInTerminal, buffer data and strip sentinels.
 * Returns true if data was buffered (caller should NOT send it directly).
 */
export function bufferIfExecActive(
  sessionId: string,
  data: string,
  send: (cleaned: string) => void,
): boolean {
  if (!execActiveSessions.has(sessionId)) return false;
  let buf = displayBuffers.get(sessionId);
  if (!buf) {
    buf = { data: "", timer: null, send };
    displayBuffers.set(sessionId, buf);
  }
  buf.data += data;
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    const cleaned = stripSentinels(buf!.data);
    buf!.data = "";
    buf!.timer = null;
    if (cleaned) buf!.send(cleaned);
  }, 8);
  return true;
}

/** Flush remaining display buffer data for a session. */
function flushDisplayBuffer(sessionId: string) {
  const buf = displayBuffers.get(sessionId);
  if (buf) {
    if (buf.timer) clearTimeout(buf.timer);
    // Give a tiny delay so the last chunk arrives
    setTimeout(() => {
      const remaining = buf.data;
      buf.data = "";
      if (remaining) {
        const cleaned = stripSentinels(remaining);
        if (cleaned) buf.send(cleaned);
      }
      displayBuffers.delete(sessionId);
    }, 15);
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

/** CWD cache — avoids spawning lsof/readlink on every IPC call (completions fire per keystroke). */
const cwdCache = new Map<number, { cwd: string; ts: number }>();
const CWD_CACHE_TTL = 2000; // 2 seconds

/** Strip ANSI escape sequences (CSI, OSC, simple escapes) from a string. */
function stripAnsiCodes(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")   // CSI sequences (e.g. \x1b[32m)
    .replace(/\x1B\][^\x07]*\x07/g, "")       // OSC sequences (e.g. \x1b]0;title\x07)
    .replace(/\x1B\][^\x1B]*\x1B\\/g, "")     // OSC with ST terminator
    .replace(/\x1B[^[\]]/g, "");               // Other simple escape sequences
}

/**
 * Parse CWD from shell prompt in terminal history (Windows fallback).
 * PowerShell shows "PS C:\path>" and cmd.exe shows "C:\path>".
 * History contains raw ANSI codes, so we strip them before matching.
 */
function parseCwdFromHistory(sessionId: string): string | null {
  const history = sessionHistory.get(sessionId);
  if (!history) return null;
  const lines = history.split("\n").slice(-20);
  // Scan from bottom up for the most recent prompt
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripAnsiCodes(lines[i]).trim();
    // PowerShell: "PS C:\Users\foo\project> " or "PS C:\Users\foo\project>"
    const psMatch = line.match(/^PS\s+([A-Z]:\\[^>]*?)>\s*$/i);
    if (psMatch) return psMatch[1];
    // cmd.exe: "C:\Users\foo\project>"
    const cmdMatch = line.match(/^([A-Z]:\\[^>]*?)>\s*$/i);
    if (cmdMatch) return cmdMatch[1];
  }
  return null;
}

/** Get CWD for a PID. Uses cache to avoid expensive subprocess spawns. */
async function getCwdForPid(pid: number, sessionId?: string): Promise<string | null> {
  // Check cache first
  const cached = cwdCache.get(pid);
  if (cached && Date.now() - cached.ts < CWD_CACHE_TTL) {
    return cached.cwd;
  }

  try {
    let result: string | null = null;
    if (os.platform() === "darwin") {
      const { stdout } = await trackedExec(
        `lsof -p ${pid} 2>/dev/null | grep ' cwd ' | awk '{print $NF}'`,
      );
      result = stdout.trim() || null;
    } else if (os.platform() === "linux") {
      const { stdout } = await trackedExec(`readlink /proc/${pid}/cwd`);
      result = stdout.trim() || null;
    } else if (os.platform() === "win32") {
      // Windows: PowerShell doesn't update the OS-level CWD on cd (Set-Location),
      // so we parse the prompt from terminal history instead.
      if (sessionId) {
        result = parseCwdFromHistory(sessionId);
      }
    }

    if (result) {
      cwdCache.set(pid, { cwd: result, ts: Date.now() });
    }
    return result;
  } catch {
    return null;
  }
}

export function getSessions() {
  return sessions;
}

export function getSessionHistory() {
  return sessionHistory;
}

/** Kill all tracked child processes and PTY sessions. */
export function cleanupAllSessions() {
  for (const child of activeChildProcesses) {
    try {
      child.kill();
    } catch { }
  }
  activeChildProcesses.clear();

  for (const [, session] of sessions) {
    try {
      session.kill();
    } catch { }
  }
  sessions.clear();
  sessionHistory.clear();
}

export function registerTerminalHandlers(
  getMainWindow: () => BrowserWindow | null,
) {
  // Terminal history stats — no-op in Electron (history isn't persisted to disk)
  ipcMain.handle("terminal.history.getStats", () => ({ fileCount: 0, totalBytes: 0 }));
  ipcMain.handle("terminal.history.clearAll", () => ({ deletedCount: 0 }));

  // Check if a PTY session is still alive (for reconnection after renderer refresh)
  ipcMain.handle("terminal.sessionExists", (_event, sessionId: string) => {
    return sessions.has(sessionId);
  });

  // Create Session (or reconnect to existing one)
  ipcMain.handle(
    "terminal.create",
    (_event, { cols, rows, cwd, reconnectId }) => {
      // If reconnectId is provided and a PTY with that ID exists, reuse it.
      // Do NOT resize here — the renderer's Terminal component will send the
      // correct dimensions after mounting and registering its data listener.
      // Resizing now would trigger SIGWINCH → TUI redraw before the renderer
      // can capture the output, causing stale data in the history buffer.
      if (reconnectId && sessions.has(reconnectId)) {
        return { sessionId: reconnectId, reconnected: true };
      }

      const { shell, args: shellArgs } = detectShell();
      const sessionId = reconnectId || randomUUID();

      try {
        // Clean environment: strip Electron/Node npm vars that conflict
        // with user tools like nvm (which rejects npm_config_prefix).
        const cleanEnv: Record<string, string> = { ...process.env as Record<string, string> };
        // Suppress zsh end-of-line mark (Unix only; harmless but unnecessary on Windows)
        if (os.platform() !== "win32") cleanEnv.PROMPT_EOL_MARK = "";
        delete cleanEnv.npm_config_prefix;
        delete cleanEnv.npm_config_loglevel;
        delete cleanEnv.npm_config_production;
        delete cleanEnv.NODE_ENV;

        const ptyProcess = pty.spawn(shell, shellArgs, {
          name: "xterm-256color",
          cols: cols || 80,
          rows: rows || 30,
          cwd: cwd || os.homedir(),
          env: cleanEnv,
        });

        sessionHistory.set(sessionId, "");

        const sendToRenderer = (cleaned: string) => {
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed() && cleaned) {
            mainWindow.webContents.send("terminal.incomingData", { id: sessionId, data: cleaned });
          }
        };

        ptyProcess.onData((data) => {
          // Raw data to history (needed for sentinel detection in execInTerminal)
          const currentHistory = sessionHistory.get(sessionId) || "";
          if (currentHistory.length < 100000) {
            sessionHistory.set(sessionId, currentHistory + data);
          } else {
            sessionHistory.set(sessionId, currentHistory.slice(-80000) + data);
          }

          // During execInTerminal: buffer display data and strip sentinels
          if (bufferIfExecActive(sessionId, data, sendToRenderer)) return;

          // Normal path (no exec active): pass through immediately
          sendToRenderer(data);
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
        return { sessionId, reconnected: false };
      } catch (e) {
        console.error("Failed to create PTY session:", e);
        throw e;
      }
    },
  );

  // Terminal Input/Output/Resize
  ipcMain.on("terminal.write", (_event, { id, data }) => {
    const session = sessions.get(id);
    if (session) session.write(data);
  });

  ipcMain.on("terminal.resize", (_event, { id, cols, rows }) => {
    const session = sessions.get(id);
    if (session) session.resize(cols, rows);
  });

  ipcMain.on("terminal.close", (_event, id) => {
    const session = sessions.get(id);
    if (session) {
      session.kill();
      sessions.delete(id);
      sessionHistory.delete(id);
    }
  });

  ipcMain.handle("terminal.checkCommand", async (_event, data) => {
    // Support both old (string) and new (object with sessionId) formats
    const command = typeof data === "string" ? data : data.command;
    const sessionId = typeof data === "object" ? data.sessionId : undefined;

    // Sanitize: only allow alphanumeric, dashes, underscores, dots
    if (!/^[a-zA-Z0-9._-]+$/.test(command)) return false;

    // SSH session: check on remote
    if (sessionId && sshSessionIds.has(sessionId)) {
      const sshSession = sshSessions.get(sessionId);
      if (sshSession) return sshSession.checkCommand(command);
      return false;
    }

    try {
      const checkCmd =
        os.platform() === "win32" ? `where ${command}` : `which ${command}`;
      await trackedExec(checkCmd);
      return true;
    } catch {
      return false;
    }
  });

  // Agent Execution (with 30s timeout to prevent blocking on long-running commands)
  ipcMain.handle(
    "terminal.exec",
    async (
      _event,
      { sessionId, command }: { sessionId: string; command: string },
    ) => {
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

      const session = sessions.get(sessionId);

      let cwd = os.homedir() || "/";
      if (session) {
        const resolved = await getCwdForPid(session.pid, sessionId);
        if (resolved) cwd = resolved;
      }

      return new Promise((resolve) => {
        const child = exec(
          command,
          { cwd, timeout: 30000 },
          (error, stdout, stderr) => {
            activeChildProcesses.delete(child);
            if (error && (error as any).killed) {
              // Process was killed due to timeout — return partial output
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
    },
  );

  // Get CWD
  ipcMain.handle("terminal.getCwd", async (_event, sessionId: string) => {
    // SSH session: get remote CWD
    if (sshSessionIds.has(sessionId)) {
      const sshSession = sshSessions.get(sessionId);
      if (sshSession) return sshSession.getCwd();
      return null;
    }
    const session = sessions.get(sessionId);
    if (!session) return null;
    return getCwdForPid(session.pid, sessionId);
  });

  // Get system info (OS, shell, arch) for agent environment context
  ipcMain.handle("terminal.getSystemInfo", async (_event, sessionId?: string) => {
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
  });

  ipcMain.handle(
    "terminal.getCompletions",
    async (
      _event,
      {
        prefix,
        cwd,
        sessionId,
      }: { prefix: string; cwd?: string; sessionId?: string },
    ) => {
      // SSH session: get completions from remote
      if (sessionId && sshSessionIds.has(sessionId)) {
        const sshSession = sshSessions.get(sessionId);
        if (sshSession) return sshSession.getCompletions(prefix);
        return [];
      }

      // Resolve CWD from session if available
      let workDir = cwd || os.homedir() || "/";
      if (!cwd && sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          const resolved = await getCwdForPid(session.pid, sessionId);
          if (resolved) workDir = resolved;
        }
      }

      try {
        const isWin = os.platform() === "win32";
        const parts = prefix.trim().split(/\s+/);

        if (parts.length <= 1) {
          const word = parts[0] || "";
          const safeWinWord = word.replace(/'/g, "''");
          const safeUnixWord = word.replace(/"/g, '\\"');
          const cmd = isWin
            ? `powershell -NoProfile -Command "Get-Command '${safeWinWord}*' -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty Name"`
            : `bash -c 'compgen -abck "${safeUnixWord}" 2>/dev/null | sort -u | head -30'`;
          const { stdout } = await trackedExec(cmd, { cwd: workDir });
          const results = stdout.trim().split("\n").filter(Boolean);
          return [...new Set(results)]
            .sort((a, b) => a.length - b.length)
            .slice(0, 15);
        }

        const lastWord = parts[parts.length - 1];
        const safeWinLastWord = lastWord.replace(/'/g, "''");
        const safeUnixLastWord = lastWord.replace(/"/g, '\\"');
        const cmd = isWin
          ? `powershell -NoProfile -Command "Get-ChildItem '${safeWinLastWord}*' -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty Name"`
          : `bash -c 'compgen -df "${safeUnixLastWord}" 2>/dev/null | head -30'`;
        const { stdout } = await trackedExec(cmd, { cwd: workDir });
        const results = stdout.trim().split("\n").filter(Boolean);
        return [...new Set(results)]
          .sort((a, b) => a.length - b.length)
          .slice(0, 15);
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle("terminal.getHistory", (_event, sessionId: string) => {
    const raw = sessionHistory.get(sessionId) || "";
    return stripSentinels(raw);
  });

  // Inject saved terminal history into a session (used when loading sync tabs)
  ipcMain.handle("terminal.setHistory", (_event, { sessionId, history }: { sessionId: string; history: string }) => {
    if (sessions.has(sessionId)) {
      sessionHistory.set(sessionId, history);
    }
  });

  // Scan all available commands on the system (for auto-mode classification)
  // Two-phase: fast non-interactive scan first, then interactive scan for shell
  // functions (nvm, pyenv, rvm) that are only loaded in interactive shells.
  ipcMain.handle("terminal.scanCommands", async () => {
    const isWin = os.platform() === "win32";
    const results: string[] = [];

    if (isWin) {
      try {
        const cmd = `powershell -NoProfile -Command "Get-Command -CommandType Application,Cmdlet | Select-Object -ExpandProperty Name -First 500"`;
        const { stdout } = await trackedExec(cmd, { timeout: 10000 });
        results.push(...stdout.trim().split("\n").filter(Boolean));
      } catch { /* non-critical */ }
    } else {
      // Phase 1: Fast non-interactive scan (PATH commands, builtins, aliases)
      try {
        const { stdout } = await trackedExec(
          `bash -c 'compgen -abck 2>/dev/null | sort -u | head -1000'`,
          { timeout: 5000 },
        );
        results.push(...stdout.trim().split("\n").filter(Boolean));
      } catch { /* non-critical */ }

      // Phase 2: Interactive shell scan to find shell functions (nvm, pyenv, etc.)
      // These are sourced in .bashrc/.zshrc which only load in interactive mode.
      try {
        const shell = process.env.SHELL || "/bin/bash";
        const isBash = shell.endsWith("/bash");
        const funcCmd = isBash
          ? `${shell} -lic 'compgen -A function 2>/dev/null' </dev/null`
          : `${shell} -lic 'print -l \${(ok)functions} 2>/dev/null' </dev/null`;
        const { stdout } = await trackedExec(funcCmd, { timeout: 8000 });
        results.push(...stdout.trim().split("\n").filter(Boolean));
      } catch { /* non-critical — interactive scan can fail */ }
    }

    return [...new Set(results)];
  });

  // Read session history (for agent "read_terminal" tool)
  ipcMain.handle("terminal.readHistory", (_event, { sessionId, lines = 100 }) => {
    try {
      const history = sessionHistory.get(sessionId) || "";
      if (!history) return "(No terminal output yet)";
      // Clean escape codes for easier reading by LLM
      // eslint-disable-next-line no-control-regex
      let clean = history.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
      // Handle \r overwrites (keep only text after last \r on each segment)
      clean = clean.replace(/[^\n]*\r(?!\n)/g, "");
      // Strip sentinel patterns so agent doesn't see internal markers (Unix + Windows)
      clean = clean.replace(/; printf '\\n__TRON_DONE_[^']*' \$\?/g, "");
      clean = clean.replace(/printf\s+'\\n__TRON_DONE_[^']*'\s*\$\?/g, "");
      clean = clean.replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
      clean = clean.replace(/Write-Host\s+["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
      clean = clean.replace(/__TRON_DONE_[a-z0-9]+__\d*/g, "");
      // Strip remaining control characters (except newline/tab)
      // eslint-disable-next-line no-control-regex
      clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
      const allLines = clean.split("\n")
        .filter(line => line.trim() !== "");
      return allLines.slice(-lines).join("\n") || "(No output)";
    } catch (err: any) {
      return `(Error reading terminal: ${err.message})`;
    }
  });

  ipcMain.handle("terminal.clearHistory", (_event, sessionId: string) => {
    sessionHistory.set(sessionId, "");
  });

  // Execute a command visibly in the PTY and capture output via sentinel marker.
  // The command runs in the user's terminal so they see it, but we also capture
  // the output to feed back to the agent.
  ipcMain.handle(
    "terminal.execInTerminal",
    async (
      _event,
      { sessionId, command }: { sessionId: string; command: string },
    ) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return { stdout: "", exitCode: 1, error: "No PTY session found" };
      }

      // If a previous command left the terminal occupied (stalled process),
      // send Ctrl+C to kill it and wait for the shell to recover.
      if (occupiedSessions.has(sessionId)) {
        occupiedSessions.delete(sessionId);
        session.write("\x03");
        await new Promise(r => setTimeout(r, 500));
      }

      // Use a unique sentinel so concurrent calls don't collide
      const nonce = Math.random().toString(36).slice(2, 8);
      const sentinel = `__TRON_DONE_${nonce}__`;
      // Wrap: run command, then emit sentinel with exit code.
      const isWin = os.platform() === "win32";
      const wrappedCommand = isWin
        ? `${command}; Write-Host "${sentinel}$LASTEXITCODE"`
        : `${command}; printf '\\n${sentinel}%d\\n' $?`;

      // Mark session as exec-active so display data gets buffered for sentinel stripping
      execActiveSessions.add(sessionId);

      const finishExec = () => {
        execActiveSessions.delete(sessionId);
        flushDisplayBuffer(sessionId);
      };

      return new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        let output = "";
        let resolved = false;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;

        // Clear any text the user may have typed in the terminal before injecting the command.
        // Ctrl+U clears the current line in bash/zsh without killing a running process.
        // On Windows PowerShell/Cmd, Escape (\x1b) clears the line.
        const clearChar = os.platform() === "win32" ? "\x1b" : "\x15";
        session.write(clearChar);

        // Stall detection: if no new PTY output for 3s, assume process is
        // waiting for input. Return early so agent can interact via send_text.
        // Do NOT kill the process — mark session as occupied instead.
        const resetStallTimer = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            if (!resolved && output.length > 0) {
              resolved = true;
              disposable.dispose();
              clearTimeout(hardTimer);
              occupiedSessions.add(sessionId); // Let agent interact
              finishExec();
              resolve({
                stdout: cleanOutput(output, sentinel),
                exitCode: 124,
              });
            }
          }, 3000);
        };

        const disposable = session.onData((data: string) => {
          output += data;
          resetStallTimer();

          // Look for completion sentinel
          const sentinelEscaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const match = output.match(new RegExp(`${sentinelEscaped}(\\d+)`));
          if (match) {
            resolved = true;
            disposable.dispose();
            clearTimeout(hardTimer);
            if (stallTimer) clearTimeout(stallTimer);
            occupiedSessions.delete(sessionId); // Command completed normally

            const exitCode = parseInt(match[1], 10);
            const captured = cleanOutput(output, sentinel);
            finishExec();
            resolve({ stdout: captured, exitCode });
          }
        });

        // Write the wrapped command to the PTY
        session.write(wrappedCommand + "\r");
        resetStallTimer();

        // Hard timeout after 30s — safety net
        const hardTimer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            disposable.dispose();
            if (stallTimer) clearTimeout(stallTimer);
            occupiedSessions.add(sessionId); // Let agent interact or clean up later
            finishExec();
            resolve({
              stdout: cleanOutput(output, sentinel),
              exitCode: 124,
            });
          }
        }, 30000);
      });
    },
  );

  // Save a clipboard image to a temp file and return the path.
  // Used when pasting images into the terminal (e.g. for Claude CLI).
  ipcMain.handle(
    "file.saveTempImage",
    async (_event, { base64, ext }: { base64: string; ext: string }) => {
      const os = require("os");
      const tmpDir = path.join(os.tmpdir(), "tron-images");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const name = `paste-${Date.now()}.${ext}`;
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
      return filePath;
    },
  );

  // Write a file directly via Node.js fs (bypasses terminal/PTY).
  // This avoids heredoc corruption for large files.
  ipcMain.handle(
    "file.writeFile",
    async (
      _event,
      { filePath, content }: { filePath: string; content: string },
    ) => {
      try {
        // Create parent directories if they don't exist
        const dir = require("path").dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const existed = fs.existsSync(filePath);
        fs.writeFileSync(filePath, content, "utf-8");
        return { success: true, existed };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );

  // Helper to provide intelligent file suggestions when the agent hallucinates paths
  function getFuzzySuggestions(targetPath: string): string[] {
    try {
      const dir = path.dirname(targetPath);
      const base = path.basename(targetPath).toLowerCase();
      if (!base || !fs.existsSync(dir)) return [];

      const files = fs.readdirSync(dir);
      const matches = files.filter(f => {
        const fLower = f.toLowerCase();
        // Exact prefix (e.g. package. -> package.json)
        if (fLower.startsWith(base)) return true;
        // Truncated or slight typo (packa -> package.json)
        if (base.length > 3 && fLower.startsWith(base.substring(0, 4))) return true;
        // Missing extension (App -> App.tsx)
        const parsed = path.parse(f);
        if (parsed.name.toLowerCase() === base) return true;
        return false;
      });

      // Return top 5 matches sorted by closest length
      return matches
        .sort((a, b) => Math.abs(a.length - base.length) - Math.abs(b.length - base.length))
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  // Read a file directly via Node.js fs (bypasses terminal/PTY).
  ipcMain.handle(
    "file.readFile",
    async (
      _event,
      { filePath }: { filePath: string },
    ) => {
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
    },
  );

  // Save a session log to disk for debugging / sharing
  ipcMain.handle(
    "log.saveSessionLog",
    async (
      _event,
      {
        sessionId,
        session: sessionMeta,
        interactions,
        agentThread,
        contextSummary,
      }: {
        sessionId: string;
        session: Record<string, unknown>;
        interactions: { role: string; content: string; timestamp: number }[];
        agentThread: { step: string; output: string; payload?: any }[];
        contextSummary?: string;
      },
    ) => {
      try {
        // Filter transient steps from agentThread
        const transientSteps = new Set(["streaming", "thinking", "executing"]);
        const cleanedThread = agentThread.filter((s) => !transientSteps.has(s.step));

        // Restructure each step into a structured log entry
        const structuredThread = cleanedThread.map((s) => {
          // Strip base64 image data from separator outputs
          if (s.step === "separator" && s.output.includes("\n---images---\n")) {
            return { step: s.step, prompt: s.output.slice(0, s.output.indexOf("\n---images---\n")), note: "(images attached)", payload: s.payload };
          }
          if (s.step === "separator") {
            return { step: s.step, prompt: s.output, payload: s.payload };
          }

          // Split executed/failed steps on "\n---\n" into command + terminal output
          if ((s.step === "executed" || s.step === "failed") && s.output.includes("\n---\n")) {
            const idx = s.output.indexOf("\n---\n");
            const command = s.output.slice(0, idx);
            let terminalOutput = s.output.slice(idx + 5);
            // Clean ANSI codes and sentinels from terminal output
            // eslint-disable-next-line no-control-regex
            terminalOutput = terminalOutput.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
            // Use robust sentinels stripped
            terminalOutput = stripSentinels(terminalOutput);
            // eslint-disable-next-line no-control-regex
            terminalOutput = terminalOutput.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
            return { step: s.step, command, terminalOutput, payload: s.payload };
          }

          // For done/question/thought/system/error/warning — keep as-is with a content field
          return { step: s.step, content: s.output, payload: s.payload };
        });

        // Generate log ID and paths
        const logId = randomBytes(5).toString("hex");
        const logsDir = path.join(app.getPath("userData"), "logs");
        if (!fs.existsSync(logsDir)) {
          fs.mkdirSync(logsDir, { recursive: true });
        }
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
    },
  );

  // Edit a file: targeted search-and-replace (much more efficient than rewriting).
  ipcMain.handle(
    "file.editFile",
    async (
      _event,
      {
        filePath,
        search,
        replace,
      }: { filePath: string; search: string; replace: string },
    ) => {
      try {
        if (!fs.existsSync(filePath)) {
          const suggestions = getFuzzySuggestions(filePath);
          const sugStr = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
          return { success: false, error: `File not found: ${filePath}.${sugStr}` };
        }
        const content = fs.readFileSync(filePath, "utf-8");
        if (!content.includes(search)) {
          return {
            success: false,
            error: `Search string not found in file. Make sure the search text matches exactly (including whitespace and newlines).`,
          };
        }
        // Count occurrences
        let count = 0;
        let idx = 0;
        while ((idx = content.indexOf(search, idx)) !== -1) {
          count++;
          idx += search.length;
        }
        const updated = content.split(search).join(replace);
        fs.writeFileSync(filePath, updated, "utf-8");
        return { success: true, replacements: count };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );

  // List directory structure safely without OS-specific commands (ls/dir)
  ipcMain.handle(
    "file.listDir",
    async (_event, { dirPath }: { dirPath: string }) => {
      try {
        if (!fs.existsSync(dirPath)) {
          return { success: false, error: `Directory not found: ${dirPath}` };
        }
        const stats = fs.statSync(dirPath);
        if (!stats.isDirectory()) {
          return { success: false, error: `Path is not a directory: ${dirPath}` };
        }
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        const contents = items.map((item) => ({
          name: item.name,
          isDirectory: item.isDirectory(),
        }));
        // Sort directories first, then alphabetically
        contents.sort((a, b) => {
          if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
          return a.isDirectory ? -1 : 1;
        });
        return { success: true, contents };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );

  // Search directory contents recursively (ripgrep/grep equivalent) avoiding regex issues
  ipcMain.handle(
    "file.searchDir",
    async (
      _event,
      { dirPath, query }: { dirPath: string; query: string },
    ) => {
      try {
        if (!fs.existsSync(dirPath)) {
          return { success: false, error: `Directory not found: ${dirPath}` };
        }
        const results: { file: string; line: number; content: string }[] = [];
        const maxResults = 50;

        function walk(dir: string) {
          if (results.length >= maxResults) return;
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            if (results.length >= maxResults) break;
            if (item.name === "node_modules" || item.name === ".git" || item.name === "dist" || item.name === "build") {
              continue;
            }
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
              walk(fullPath);
            } else {
              try {
                const stat = fs.statSync(fullPath);
                if (stat.size > 2 * 1024 * 1024) continue; // Skip files > 2MB
                const content = fs.readFileSync(fullPath, "utf-8");
                if (content.includes("\0")) continue; // Skip binary files
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].includes(query)) {
                    results.push({
                      file: fullPath,
                      line: i + 1,
                      content: lines[i].trim().slice(0, 150),
                    });
                    if (results.length >= maxResults) break;
                  }
                }
              } catch {
                // Ignore read errors for individual files
              }
            }
          }
        }

        walk(dirPath);
        return { success: true, results };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );
}

// Helper to clean captured output
function cleanOutput(output: string, sentinel: string) {
  let captured = output;
  // eslint-disable-next-line no-control-regex
  captured = captured.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  // Handle \r overwrites (keep only text after last \r on each segment)
  captured = captured.replace(/[^\n]*\r(?!\n)/g, "");

  const sentinelIdx = captured.indexOf(sentinel);
  if (sentinelIdx >= 0) {
    captured = captured.slice(0, sentinelIdx);
  }

  // Strip the command echo line (first line) which includes the sentinel printf
  const firstNewline = captured.indexOf("\n");
  if (firstNewline >= 0) {
    captured = captured.slice(firstNewline + 1);
  }

  // Strip any remaining sentinel fragments (Unix printf + Windows Write-Host)
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
