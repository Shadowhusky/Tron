import { ipcMain, BrowserWindow } from "electron";
import * as pty from "node-pty";
import os from "os";
import { randomUUID } from "crypto";

const sessions = new Map<string, pty.IPty>();
const sessionHistory = new Map<string, string>();

export function getSessions() {
  return sessions;
}

export function getSessionHistory() {
  return sessionHistory;
}

export function registerTerminalHandlers(getMainWindow: () => BrowserWindow | null) {
  // Check if a PTY session is still alive (for reconnection after renderer refresh)
  ipcMain.handle("terminal.sessionExists", (_event, sessionId: string) => {
    return sessions.has(sessionId);
  });

  // Create Session (or reconnect to existing one)
  ipcMain.handle("terminal.create", (_event, { cols, rows, cwd, reconnectId }) => {
    // If reconnectId is provided and a PTY with that ID exists, reuse it
    if (reconnectId && sessions.has(reconnectId)) {
      const existing = sessions.get(reconnectId)!;
      try { existing.resize(cols || 80, rows || 30); } catch {}
      return reconnectId;
    }

    const isWin = os.platform() === "win32";
    const shell = isWin ? "powershell.exe" : "/bin/zsh";
    const shellArgs = isWin ? [] : ["+o", "PROMPT_SP"];
    const sessionId = randomUUID();

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
        } else {
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
    } catch (e) {
      console.error("Failed to create PTY session:", e);
      throw e;
    }
  });

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
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    try {
      const checkCmd =
        os.platform() === "win32" ? `where ${command}` : `which ${command}`;
      await execAsync(checkCmd);
      return true;
    } catch {
      return false;
    }
  });

  // Agent Execution
  ipcMain.handle(
    "terminal.exec",
    async (
      _event,
      { sessionId, command }: { sessionId: string; command: string },
    ) => {
      const session = sessions.get(sessionId);
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      let cwd = process.env.HOME || "/";
      if (session) {
        try {
          const pid = session.pid;
          if (os.platform() === "darwin") {
            const { stdout } = await execAsync(
              `lsof -p ${pid} | grep cwd | awk '{print $9}'`,
            );
            if (stdout.trim()) cwd = stdout.trim();
          } else if (os.platform() === "linux") {
            const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
            if (stdout.trim()) cwd = stdout.trim();
          }
        } catch (e) {
          console.error("Error fetching CWD:", e);
        }
      }

      try {
        const { stdout, stderr } = await execAsync(command, { cwd });
        return { stdout, stderr, exitCode: 0 };
      } catch (e: any) {
        return { stdout: "", stderr: e.message, exitCode: e.code || 1 };
      }
    },
  );

  // Get CWD
  ipcMain.handle("terminal.getCwd", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const pid = session.pid;
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      if (os.platform() === "darwin") {
        const { stdout: lsofOut } = await execAsync(
          `lsof -p ${pid} | grep cwd | awk '{print $NF}' `,
        );
        return lsofOut.trim() || null;
      } else if (os.platform() === "linux") {
        const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
        return stdout.trim() || null;
      }
      return null;
    } catch {
      return null;
    }
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
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      // Resolve CWD from session if available
      let workDir = cwd || process.env.HOME || "/";
      if (!cwd && sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          try {
            const pid = session.pid;
            if (os.platform() === "darwin") {
              const { stdout } = await execAsync(
                `lsof -p ${pid} | grep cwd | awk '{print $NF}'`,
              );
              if (stdout.trim()) workDir = stdout.trim();
            }
          } catch { /* ignore */ }
        }
      }

      try {
        const parts = prefix.trim().split(/\s+/);

        if (parts.length <= 1) {
          const word = parts[0] || "";
          const { stdout } = await execAsync(
            `bash -c 'compgen -abck "${word}" 2>/dev/null | sort -u | head -30'`,
            { cwd: workDir },
          );
          const results = stdout.trim().split("\n").filter(Boolean);
          return [...new Set(results)]
            .sort((a, b) => a.length - b.length)
            .slice(0, 15);
        }

        const lastWord = parts[parts.length - 1];
        const { stdout } = await execAsync(
          `bash -c 'compgen -df "${lastWord}" 2>/dev/null | head -30'`,
          { cwd: workDir },
        );
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
}
