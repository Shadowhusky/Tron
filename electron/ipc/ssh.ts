import { ipcMain, BrowserWindow, app } from "electron";
import { Client, ConnectConfig } from "ssh2";
import fs from "fs";
import path from "path";
import os from "os";

// --- Types ---

interface SSHConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent";
  privateKeyPath?: string;
  password?: string;
  passphrase?: string;
  saveCredentials?: boolean;
  fingerprint?: string;
  lastConnected?: number;
  cols?: number;
  rows?: number;
  sessionId?: string;
}

interface SSHProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent";
  privateKeyPath?: string;
  saveCredentials?: boolean;
  savedPassword?: string;
  savedPassphrase?: string;
  fingerprint?: string;
  lastConnected?: number;
}

interface Disposable {
  dispose(): void;
}

// --- PtyLike interface matching node-pty.IPty ---

export interface PtyLike {
  onData(cb: (data: string) => void): Disposable;
  onExit(cb: (info: { exitCode: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pid: number;
}

// --- Friendly error messages ---

function friendlySSHError(err: Error, config: SSHConnectionConfig): string {
  const msg = err.message || "";
  if (/All configured authentication methods failed/i.test(msg)) {
    if (config.authMethod === "password") {
      return `Authentication failed — incorrect password for ${config.username}@${config.host}`;
    } else if (config.authMethod === "key") {
      return `Authentication failed — the server rejected the private key for ${config.username}@${config.host}. Check that the key is authorized and the passphrase is correct.`;
    } else if (config.authMethod === "agent") {
      return `Authentication failed — SSH agent has no key accepted by ${config.host}. Make sure your agent has the correct key loaded.`;
    }
    return `Authentication failed for ${config.username}@${config.host}`;
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `Connection refused — ${config.host}:${config.port || 22} is not accepting SSH connections`;
  }
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
    return `Host not found — could not resolve "${config.host}"`;
  }
  if (/ETIMEDOUT|timed? ?out/i.test(msg)) {
    return `Connection timed out — ${config.host}:${config.port || 22} did not respond`;
  }
  if (/EHOSTUNREACH/i.test(msg)) {
    return `Host unreachable — cannot reach ${config.host}`;
  }
  if (/ECONNRESET/i.test(msg)) {
    return `Connection reset by ${config.host}`;
  }
  if (/no such file|ENOENT/i.test(msg) && config.authMethod === "key") {
    return `Private key file not found: ${config.privateKeyPath}`;
  }
  return msg;
}

// --- SSH Session Class ---

let nextSyntheticPid = -1000;

class SSHSession implements PtyLike {
  pid: number;
  private client: Client;
  private channel: any | null = null;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((info: { exitCode: number }) => void)[] = [];
  private _connected = false;
  private cachedCwd: string | null = null;
  private cachedSystemInfo: { platform: string; arch: string; shell: string; release: string } | null = null;

  constructor() {
    this.pid = nextSyntheticPid--;
    this.client = new Client();
  }

  get connected() { return this._connected; }
  get sshClient() { return this.client; }

  async connect(config: SSHConnectionConfig, cols: number, rows: number): Promise<void> {
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 10000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    };

    if (config.authMethod === "password") {
      connectConfig.password = config.password;
    } else if (config.authMethod === "key") {
      if (config.privateKeyPath) {
        const keyPath = config.privateKeyPath.replace(/^~/, os.homedir());
        connectConfig.privateKey = fs.readFileSync(keyPath);
      }
      if (config.passphrase) {
        connectConfig.passphrase = config.passphrase;
      }
    } else if (config.authMethod === "agent") {
      connectConfig.agent = process.env.SSH_AUTH_SOCK;
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("SSH connection timed out"));
        this.client.end();
      }, 15000);

      this.client.on("ready", () => {
        clearTimeout(timeout);
        this._connected = true;
        this.client.shell(
          { term: "xterm-256color", cols, rows },
          (err: Error | undefined, stream: any) => {
            if (err) { reject(err); return; }
            this.channel = stream;

            stream.on("data", (data: Buffer) => {
              const str = data.toString("utf-8");
              for (const listener of this.dataListeners) listener(str);
            });

            stream.stderr?.on("data", (data: Buffer) => {
              const str = data.toString("utf-8");
              for (const listener of this.dataListeners) listener(str);
            });

            stream.on("close", () => {
              this._connected = false;
              for (const listener of this.exitListeners) listener({ exitCode: 0 });
            });

            resolve();
          },
        );
      });

      this.client.on("error", (err: Error) => {
        clearTimeout(timeout);
        this._connected = false;
        reject(new Error(friendlySSHError(err, config)));
      });

      this.client.on("close", () => {
        this._connected = false;
        for (const listener of this.exitListeners) listener({ exitCode: 0 });
      });

      this.client.connect(connectConfig);
    });
  }

  onData(cb: (data: string) => void): Disposable {
    this.dataListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.dataListeners.indexOf(cb);
        if (idx >= 0) this.dataListeners.splice(idx, 1);
      },
    };
  }

  onExit(cb: (info: { exitCode: number }) => void): Disposable {
    this.exitListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.exitListeners.indexOf(cb);
        if (idx >= 0) this.exitListeners.splice(idx, 1);
      },
    };
  }

  write(data: string): void {
    if (this.channel) this.channel.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.channel) this.channel.setWindow(rows, cols, rows * 16, cols * 8);
  }

  kill(): void {
    try { this.channel?.close(); } catch { /* ignore */ }
    try { this.client.end(); } catch { /* ignore */ }
    this._connected = false;
  }

  async exec(command: string, timeout = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSH exec timed out")), timeout);
      this.client.exec(command, (err: Error | undefined, stream: any) => {
        if (err) { clearTimeout(timer); reject(err); return; }
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer) => { stdout += data.toString("utf-8"); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf-8"); });
        stream.on("close", (code: number) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });
      });
    });
  }

  async getCwd(): Promise<string | null> {
    try {
      const result = await this.exec("pwd", 5000);
      const cwd = result.stdout.trim();
      if (cwd) { this.cachedCwd = cwd; return cwd; }
      return this.cachedCwd;
    } catch { return this.cachedCwd; }
  }

  async getSystemInfo(): Promise<{ platform: string; arch: string; shell: string; release: string }> {
    if (this.cachedSystemInfo) return this.cachedSystemInfo;
    try {
      const [p, a, s, r] = await Promise.all([
        this.exec("uname -s", 5000),
        this.exec("uname -m", 5000),
        this.exec("echo $SHELL", 5000),
        this.exec("uname -r", 5000),
      ]);
      this.cachedSystemInfo = {
        platform: p.stdout.trim().toLowerCase() || "linux",
        arch: a.stdout.trim() || "unknown",
        shell: path.basename(s.stdout.trim() || "bash"),
        release: r.stdout.trim() || "unknown",
      };
      return this.cachedSystemInfo;
    } catch {
      return { platform: "linux", arch: "unknown", shell: "bash", release: "unknown" };
    }
  }

  async getCompletions(prefix: string): Promise<string[]> {
    try {
      const parts = prefix.trim().split(/\s+/);
      const safeWord = (parts.length <= 1 ? (parts[0] || "") : parts[parts.length - 1]).replace(/"/g, '\\"');
      const compType = parts.length <= 1 ? "-abck" : "-df";
      const cmd = `bash -c 'compgen ${compType} "${safeWord}" 2>/dev/null | sort -u | head -30'`;
      const result = await this.exec(cmd, 5000);
      const results = result.stdout.trim().split("\n").filter(Boolean);
      return [...new Set(results)].sort((a: string, b: string) => a.length - b.length).slice(0, 15);
    } catch { return []; }
  }

  async checkCommand(command: string): Promise<boolean> {
    try {
      const result = await this.exec(`which ${command}`, 5000);
      return result.exitCode === 0;
    } catch { return false; }
  }
}

// --- Tracking ---

export const sshSessionIds = new Set<string>();
export const sshSessions = new Map<string, SSHSession>();

// --- Profile Persistence ---

function getProfilesPath(): string {
  const dir = path.join(app.getPath("userData"), "ssh-profiles");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "profiles.json");
}

function readProfiles(): SSHProfile[] {
  try {
    const filePath = getProfilesPath();
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch { return []; }
}

function writeProfiles(profiles: SSHProfile[]): boolean {
  try {
    fs.writeFileSync(getProfilesPath(), JSON.stringify(profiles, null, 2), "utf-8");
    return true;
  } catch { return false; }
}

// --- Register IPC Handlers ---

export function registerSSHHandlers(
  getMainWindow: () => BrowserWindow | null,
  getSessions: () => Map<string, any>,
  getSessionHistory: () => Map<string, string>,
) {
  ipcMain.handle("ssh.connect", async (_event, config: SSHConnectionConfig) => {
    const session = new SSHSession();
    const sessionId = config.sessionId || `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await session.connect(config, config.cols || 80, config.rows || 30);

    // Register in tracking
    sshSessionIds.add(sessionId);
    sshSessions.set(sessionId, session);

    const sessions = getSessions();
    const history = getSessionHistory();
    sessions.set(sessionId, session);
    history.set(sessionId, "");

    const mainWindow = getMainWindow();

    // Wire data/exit
    session.onData((data) => {
      const currentHistory = history.get(sessionId) || "";
      if (currentHistory.length < 100000) {
        history.set(sessionId, currentHistory + data);
      } else {
        history.set(sessionId, currentHistory.slice(-80000) + data);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("terminal.incomingData", { id: sessionId, data });
      }
    });

    session.onExit(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("terminal.exit", { id: sessionId, exitCode: 0 });
        mainWindow.webContents.send("ssh.statusChange", { sessionId, status: "disconnected" });
      }
      sessions.delete(sessionId);
      history.delete(sessionId);
      sshSessionIds.delete(sessionId);
      sshSessions.delete(sessionId);
    });

    // Save profile
    if (config.saveCredentials || config.name) {
      const profiles = readProfiles();
      const existingIdx = profiles.findIndex((p: SSHProfile) => p.id === config.id);
      const profile: SSHProfile = {
        id: config.id,
        name: config.name || `${config.username}@${config.host}`,
        host: config.host,
        port: config.port,
        username: config.username,
        authMethod: config.authMethod,
        privateKeyPath: config.privateKeyPath,
        saveCredentials: config.saveCredentials,
        savedPassword: config.saveCredentials ? config.password : undefined,
        savedPassphrase: config.saveCredentials ? config.passphrase : undefined,
        fingerprint: config.fingerprint,
        lastConnected: Date.now(),
      };
      if (existingIdx >= 0) profiles[existingIdx] = profile;
      else profiles.push(profile);
      writeProfiles(profiles);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ssh.statusChange", { sessionId, status: "connected" });
    }

    return { sessionId };
  });

  ipcMain.handle("ssh.testConnection", async (_event, config: any) => {
    const client = new Client();
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 10000,
    };

    if (config.authMethod === "password") {
      connectConfig.password = config.password;
    } else if (config.authMethod === "key") {
      if (config.privateKeyPath) {
        try {
          const keyPath = config.privateKeyPath.replace(/^~/, os.homedir());
          connectConfig.privateKey = fs.readFileSync(keyPath);
        } catch (e: any) {
          return { success: false, error: `Cannot read key file: ${e.message}` };
        }
      }
      if (config.passphrase) connectConfig.passphrase = config.passphrase;
    } else if (config.authMethod === "agent") {
      connectConfig.agent = process.env.SSH_AUTH_SOCK;
      if (!connectConfig.agent) {
        return { success: false, error: "SSH_AUTH_SOCK not set — SSH agent not available" };
      }
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.end();
        resolve({ success: false, error: "Connection timed out" });
      }, 10000);

      client.on("ready", () => {
        clearTimeout(timeout);
        client.end();
        resolve({ success: true });
      });

      client.on("error", (err: Error) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });

      client.connect(connectConfig);
    });
  });

  ipcMain.handle("ssh.disconnect", (_event, sessionId: string) => {
    const session = sshSessions.get(sessionId);
    if (!session) return false;
    session.kill();
    return true;
  });

  ipcMain.handle("ssh.profiles.read", () => {
    return readProfiles();
  });

  ipcMain.handle("ssh.profiles.write", (_event, profiles: SSHProfile[]) => {
    return writeProfiles(profiles);
  });
}

export function cleanupAllSSHSessions() {
  for (const [, session] of sshSessions) {
    try { session.kill(); } catch { /* ignore */ }
  }
  sshSessions.clear();
  sshSessionIds.clear();
}
