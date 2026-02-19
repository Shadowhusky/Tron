import { ipcMain, BrowserWindow, app } from "electron";
import * as pty from "node-pty";
import os from "os";
import fs from "fs";
import path from "path";
import { randomUUID, randomBytes } from "crypto";
import { exec, ChildProcess } from "child_process";

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
const displayBuffers = new Map<string, { data: string; timer: ReturnType<typeof setTimeout> | null }>();
const execActiveSessions = new Set<string>(); // Sessions currently running execInTerminal

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
      // Use CIM to get the ExecutablePath, then derive its parent directory.
      // This is best-effort — Windows has no reliable cross-process CWD API.
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
  // Check if a PTY session is still alive (for reconnection after renderer refresh)
  ipcMain.handle("terminal.sessionExists", (_event, sessionId: string) => {
    return sessions.has(sessionId);
  });

  // Create Session (or reconnect to existing one)
  ipcMain.handle(
    "terminal.create",
    (_event, { cols, rows, cwd, reconnectId }) => {
      // If reconnectId is provided and a PTY with that ID exists, reuse it
      if (reconnectId && sessions.has(reconnectId)) {
        const existing = sessions.get(reconnectId)!;
        try {
          existing.resize(cols || 80, rows || 30);
        } catch { }
        return reconnectId;
      }

      const { shell, args: shellArgs } = detectShell();
      const sessionId = randomUUID();

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

        // Helper: strip sentinel patterns from display data (Unix printf + Windows Write-Host)
        const stripSentinels = (text: string): string => {
          let d = text;
          // Unix: "; printf '\n__TRON_DONE_...' $?"
          d = d.replace(/; printf '\\n__TRON_DONE_[^']*' \$\?/g, "");
          d = d.replace(/printf '\\n__TRON_DONE_[^']*' \$\?/g, "");
          // Windows: '; Write-Host "__TRON_DONE_...$LASTEXITCODE"'
          d = d.replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
          d = d.replace(/Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
          // Sentinel output itself (e.g. __TRON_DONE_abc12345__0)
          d = d.replace(/\n?__TRON_DONE_[a-z0-9]+__\d+\n?/g, "");
          return d;
        };

        // Helper: flush buffered display data to renderer
        const flushDisplayBuffer = () => {
          const buf = displayBuffers.get(sessionId);
          if (!buf || !buf.data) return;
          const cleaned = stripSentinels(buf.data);
          buf.data = "";
          if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed() && cleaned) {
            mainWindow.webContents.send("terminal.incomingData", {
              id: sessionId,
              data: cleaned,
            });
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

          // During execInTerminal: buffer display data so sentinel patterns
          // spanning multiple chunks can be stripped in one pass
          if (execActiveSessions.has(sessionId)) {
            let buf = displayBuffers.get(sessionId);
            if (!buf) {
              buf = { data: "", timer: null };
              displayBuffers.set(sessionId, buf);
            }
            buf.data += data;
            // Flush after short delay to accumulate chunks
            if (buf.timer) clearTimeout(buf.timer);
            buf.timer = setTimeout(flushDisplayBuffer, 8);
            return;
          }

          // Normal path (no exec active): pass through immediately
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed() && data) {
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

  ipcMain.handle("terminal.checkCommand", async (_event, command) => {
    // Sanitize: only allow alphanumeric, dashes, underscores, dots
    if (!/^[a-zA-Z0-9._-]+$/.test(command)) return false;
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
      const session = sessions.get(sessionId);

      let cwd = os.homedir() || "/";
      if (session) {
        const resolved = await getCwdForPid(session.pid);
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
    const session = sessions.get(sessionId);
    if (!session) return null;
    return getCwdForPid(session.pid);
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
      // Resolve CWD from session if available
      let workDir = cwd || os.homedir() || "/";
      if (!cwd && sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          const resolved = await getCwdForPid(session.pid);
          if (resolved) workDir = resolved;
        }
      }

      try {
        const isWin = os.platform() === "win32";
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
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle("terminal.getHistory", (_event, sessionId: string) => {
    return sessionHistory.get(sessionId) || "";
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
        // Flush any remaining buffered display data
        const buf = displayBuffers.get(sessionId);
        if (buf) {
          if (buf.timer) clearTimeout(buf.timer);
          // Final flush — give a tiny delay so the last sentinel chunk arrives
          setTimeout(() => {
            const remaining = buf.data;
            buf.data = "";
            if (remaining) {
              // Strip sentinels from the accumulated buffer (reuse same patterns)
              const cleaned = stripSentinels(remaining);
              const mainWindow = getMainWindow();
              if (mainWindow && !mainWindow.isDestroyed() && cleaned) {
                mainWindow.webContents.send("terminal.incomingData", {
                  id: sessionId,
                  data: cleaned,
                });
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
        fs.writeFileSync(filePath, content, "utf-8");
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );

  // Read a file directly via Node.js fs (bypasses terminal/PTY).
  ipcMain.handle(
    "file.readFile",
    async (
      _event,
      { filePath }: { filePath: string },
    ) => {
      try {
        if (!fs.existsSync(filePath)) {
          return { success: false, error: `File not found: ${filePath}` };
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
        agentThread: { step: string; output: string }[];
        contextSummary?: string;
      },
    ) => {
      try {
        // Read and clean terminal history
        const rawHistory = sessionHistory.get(sessionId) || "";
        // eslint-disable-next-line no-control-regex
        let terminalOutput = rawHistory.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
        terminalOutput = terminalOutput.replace(/[^\n]*\r(?!\n)/g, "");
        terminalOutput = terminalOutput.replace(/; printf '\\n__TRON_DONE_[^']*' \$\?/g, "");
        terminalOutput = terminalOutput.replace(/printf\s+'\\n__TRON_DONE_[^']*'\s*\$\?/g, "");
        terminalOutput = terminalOutput.replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
        terminalOutput = terminalOutput.replace(/Write-Host\s+["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
        terminalOutput = terminalOutput.replace(/__TRON_DONE_[a-z0-9]+__\d*/g, "");
        // eslint-disable-next-line no-control-regex
        terminalOutput = terminalOutput.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

        // Filter transient steps from agentThread
        const transientSteps = new Set(["streaming", "thinking", "executing"]);
        const cleanedThread = agentThread.filter((s) => !transientSteps.has(s.step));

        // Strip base64 image data from separator outputs
        const sanitizedThread = cleanedThread.map((s) => {
          if (s.step === "separator" && s.output.includes("\n---images---\n")) {
            return { ...s, output: s.output.slice(0, s.output.indexOf("\n---images---\n")) + "\n(images attached)" };
          }
          return s;
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
          version: 1,
          generatedAt: new Date().toISOString(),
          session: sessionMeta,
          interactions,
          agentThread: sanitizedThread,
          terminalOutput,
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
          return { success: false, error: `File not found: ${filePath}` };
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
