import * as pty from "node-pty";
import os from "os";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const sessions = new Map<string, pty.IPty>();
const sessionHistory = new Map<string, string>();
// Track which WS client owns each session
const sessionOwners = new Map<string, string>();

export type EventPusher = (channel: string, data: any) => void;

export function getSessions() {
  return sessions;
}

export function getSessionOwners() {
  return sessionOwners;
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

export function sessionExists(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function createSession(
  { cols, rows, cwd, reconnectId }: { cols?: number; rows?: number; cwd?: string; reconnectId?: string },
  clientId: string,
  pushEvent: EventPusher
): string {
  if (reconnectId && sessions.has(reconnectId)) {
    const existing = sessions.get(reconnectId)!;
    try { existing.resize(cols || 80, rows || 30); } catch {}
    sessionOwners.set(reconnectId, clientId);
    return reconnectId;
  }

  const isWin = os.platform() === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/zsh";
  const shellArgs = isWin ? [] : ["+o", "PROMPT_SP"];
  const sessionId = randomUUID();

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 30,
    cwd: cwd || process.env.HOME,
    env: { ...process.env, PROMPT_EOL_MARK: "" } as Record<string, string>,
  });

  sessionHistory.set(sessionId, "");
  sessionOwners.set(sessionId, clientId);

  ptyProcess.onData((data) => {
    const currentHistory = sessionHistory.get(sessionId) || "";
    if (currentHistory.length < 100000) {
      sessionHistory.set(sessionId, currentHistory + data);
    } else {
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

export async function checkCommand(command: string): Promise<boolean> {
  try {
    const checkCmd = os.platform() === "win32" ? `where ${command}` : `which ${command}`;
    await execAsync(checkCmd);
    return true;
  } catch {
    return false;
  }
}

async function getSessionCwd(sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  let cwd = process.env.HOME || "/";
  if (session) {
    try {
      const pid = session.pid;
      if (os.platform() === "darwin") {
        const { stdout } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $9}'`);
        if (stdout.trim()) cwd = stdout.trim();
      } else if (os.platform() === "linux") {
        const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
        if (stdout.trim()) cwd = stdout.trim();
      }
    } catch (e) {
      console.error("Error fetching CWD:", e);
    }
  }
  return cwd;
}

export async function execCommand(sessionId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = await getSessionCwd(sessionId);
  try {
    const { stdout, stderr } = await execAsync(command, { cwd });
    return { stdout, stderr, exitCode: 0 };
  } catch (e: any) {
    return { stdout: "", stderr: e.message, exitCode: e.code || 1 };
  }
}

export async function getCwd(sessionId: string): Promise<string | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const pid = session.pid;

  try {
    if (os.platform() === "darwin") {
      const { stdout } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $NF}'`);
      return stdout.trim() || null;
    } else if (os.platform() === "linux") {
      const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
      return stdout.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getCompletions({ prefix, cwd, sessionId }: { prefix: string; cwd?: string; sessionId?: string }): Promise<string[]> {
  let workDir = cwd || process.env.HOME || "/";
  if (!cwd && sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      try {
        const pid = session.pid;
        if (os.platform() === "darwin") {
          const { stdout } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $NF}'`);
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
        { cwd: workDir }
      );
      const results = stdout.trim().split("\n").filter(Boolean);
      return [...new Set(results)].sort((a, b) => a.length - b.length).slice(0, 15);
    }

    const lastWord = parts[parts.length - 1];
    const { stdout } = await execAsync(
      `bash -c 'compgen -df "${lastWord}" 2>/dev/null | head -30'`,
      { cwd: workDir }
    );
    const results = stdout.trim().split("\n").filter(Boolean);
    return [...new Set(results)].sort((a, b) => a.length - b.length).slice(0, 15);
  } catch {
    return [];
  }
}

export function getHistory(sessionId: string): string {
  return sessionHistory.get(sessionId) || "";
}
