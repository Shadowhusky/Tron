import { ipcMain, app } from "electron";
import { fork, ChildProcess } from "child_process";
import path from "path";
import net from "net";
import os from "os";
import fs from "fs";

let serverProcess: ChildProcess | null = null;
let currentPort: number | null = null;
let lastError: string | null = null;

// --- Auto-restart state ---
const MAX_RESTART_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1000; // 1s → 2s → 4s → 8s → 16s (capped at 30s)
const MAX_BACKOFF_MS = 30_000;

let intentionalStop = false;
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let lastStartPort = 3888;

const CONFIG_FILE = "tron.config.json";

/** Read webServer config from the persisted tron.config.json. */
export function readWebServerConfig(): { enabled: boolean; port: number } {
  try {
    const configPath = path.join(app.getPath("userData"), CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return {
        enabled: raw?.webServer?.enabled !== false,
        port: raw?.webServer?.port || 3888,
      };
    }
  } catch { /* use defaults */ }
  return { enabled: true, port: 3888 };
}

/** Resolve path to the server entry point (dev vs production). */
function getServerPath(): string {
  if (app.isPackaged) {
    // Production: use the asar-unpacked copy so the forked child process
    // can resolve node_modules (express, ws, etc.) via normal require paths.
    return path.join(process.resourcesPath, "app.asar.unpacked", "dist-server", "index.js");
  }
  // Dev: built server is at project root dist-server/
  return path.join(__dirname, "../../dist-server/index.js");
}

/** Check if a port is available. */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

/** Schedule an auto-restart with exponential backoff. */
function scheduleRestart() {
  if (intentionalStop) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(`[Tron] Web server restart limit reached (${MAX_RESTART_ATTEMPTS} attempts). Giving up.`);
    return;
  }
  const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** restartAttempts, MAX_BACKOFF_MS);
  restartAttempts++;
  console.log(`[Tron] Scheduling web server restart in ${backoff}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    const result = await startWebServer(lastStartPort);
    if (!result.success) {
      console.error(`[Tron] Web server restart failed: ${result.error}`);
      scheduleRestart();
    }
  }, backoff);
}

/** Start the web server as a forked child process. */
export async function startWebServer(port: number): Promise<{ success: boolean; port?: number; error?: string }> {
  if (serverProcess) {
    return { success: false, error: "Server is already running" };
  }

  lastStartPort = port;
  lastError = null;

  const serverPath = getServerPath();
  if (!fs.existsSync(serverPath)) {
    lastError = `Server not found at ${serverPath}`;
    return { success: false, error: lastError };
  }

  const available = await isPortAvailable(port);
  if (!available) {
    lastError = `Port ${port} is already in use`;
    return { success: false, error: lastError };
  }

  return new Promise((resolve) => {
    const isDev = !app.isPackaged;

    const child = fork(serverPath, isDev ? ["--dev"] : [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        TRON_PORT: String(port),
        TRON_DEV: isDev ? "true" : "false",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    // Collect stderr for error reporting
    let stderrBuf = "";

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      serverProcess = null;
      currentPort = null;
      lastError = stderrBuf.trim() || "Server startup timed out (10s)";
      resolve({ success: false, error: lastError });
    }, 10_000);

    child.on("message", (msg: any) => {
      if (msg?.type === "ready") {
        clearTimeout(timeout);
        serverProcess = child;
        currentPort = msg.port || port;
        lastError = null;
        restartAttempts = 0; // Reset backoff on successful start

        // Monitor for unexpected crashes after successful startup
        child.on("exit", (crashCode) => {
          if (!intentionalStop && serverProcess === child) {
            console.error(`[Tron] Web server crashed unexpectedly (code ${crashCode}). Scheduling restart...`);
            serverProcess = null;
            currentPort = null;
            scheduleRestart();
          }
        });

        console.log(`[Tron] Web server started on port ${currentPort}`);
        resolve({ success: true, port: currentPort! });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      serverProcess = null;
      currentPort = null;
      lastError = err.message;
      resolve({ success: false, error: lastError });
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (serverProcess === child) {
        console.log(`[Tron] Web server exited with code ${code}`);
        serverProcess = null;
        currentPort = null;
      }
      // Always resolve — if the child exits before sending "ready",
      // this ensures the IPC handler doesn't hang ("reply was never sent").
      // If "ready" already resolved the Promise, this second call is a no-op.
      lastError = stderrBuf.trim() || `Server exited with code ${code}`;
      resolve({ success: false, error: lastError });
    });

    // Forward server stdout/stderr to Electron's console
    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[WebServer] ${data}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
      process.stderr.write(`[WebServer] ${data}`);
    });
  });
}

/** Stop the web server process. */
export async function stopWebServer(): Promise<void> {
  intentionalStop = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  restartAttempts = 0;

  if (!serverProcess) return;

  const child = serverProcess;
  serverProcess = null;
  currentPort = null;

  return new Promise((resolve) => {
    const forceTimeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      resolve();
    }, 3000);

    child.once("exit", () => {
      clearTimeout(forceTimeout);
      resolve();
    });

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(forceTimeout);
      resolve();
    }
  });
}

/** Get non-internal IPv4 addresses for this machine. */
function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      // Node 18.4+ returns family as number (4/6), older versions as string ("IPv4"/"IPv6")
      const isIPv4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (isIPv4 && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

/**
 * Start the web server with automatic restart on crash.
 * Use this instead of `startWebServer` for the initial app startup.
 */
export async function startWebServerManaged(port: number) {
  intentionalStop = false;
  restartAttempts = 0;
  lastStartPort = port;
  const result = await startWebServer(port);
  if (!result.success) scheduleRestart();
  return result;
}

/** Get current server status. */
export function getWebServerStatus(): { running: boolean; port: number | null; localIPs: string[]; error: string | null; restarting: boolean; restartAttempts: number } {
  return {
    running: serverProcess !== null && !serverProcess.killed,
    port: currentPort,
    localIPs: getLocalIPs(),
    error: lastError,
    restarting: restartTimer !== null,
    restartAttempts,
  };
}

/** Register all web server IPC handlers. */
export function registerWebServerHandlers() {
  ipcMain.handle("webServer.start", async (_event, port: number) => {
    return startWebServer(port || 3888);
  });

  ipcMain.handle("webServer.stop", async () => {
    await stopWebServer();
    return { success: true };
  });

  ipcMain.handle("webServer.status", async () => {
    return getWebServerStatus();
  });

  ipcMain.handle("webServer.checkPort", async (_event, port: number) => {
    const available = await isPortAvailable(port);
    return { available };
  });
}
