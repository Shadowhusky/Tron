import { ipcMain, app } from "electron";
import { fork, ChildProcess } from "child_process";
import path from "path";
import net from "net";
import os from "os";
import fs from "fs";

let serverProcess: ChildProcess | null = null;
let currentPort: number | null = null;
let lastError: string | null = null;

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
    // Production: dist-server is in extraResources
    return path.join(process.resourcesPath, "dist-server", "index.js");
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

/** Start the web server as a forked child process. */
export async function startWebServer(port: number): Promise<{ success: boolean; port?: number; error?: string }> {
  if (serverProcess) {
    return { success: false, error: "Server is already running" };
  }

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
        lastError = stderrBuf.trim() || `Server exited with code ${code}`;
      }
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

/** Get current server status. */
export function getWebServerStatus(): { running: boolean; port: number | null; localIPs: string[]; error: string | null } {
  return {
    running: serverProcess !== null && !serverProcess.killed,
    port: currentPort,
    localIPs: getLocalIPs(),
    error: lastError,
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
