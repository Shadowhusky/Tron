"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readWebServerConfig = readWebServerConfig;
exports.startWebServer = startWebServer;
exports.stopWebServer = stopWebServer;
exports.startWebServerManaged = startWebServerManaged;
exports.getWebServerStatus = getWebServerStatus;
exports.registerWebServerHandlers = registerWebServerHandlers;
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const net_1 = __importDefault(require("net"));
const os_1 = __importDefault(require("os"));
const fs_1 = __importDefault(require("fs"));
let serverProcess = null;
let currentPort = null;
let lastError = null;
// --- Auto-restart state ---
const MAX_RESTART_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1000; // 1s → 2s → 4s → 8s → 16s (capped at 30s)
const MAX_BACKOFF_MS = 30000;
let intentionalStop = false;
let restartAttempts = 0;
let restartTimer = null;
let lastStartPort = 3888;
let lastStartExpose = true;
const CONFIG_FILE = "tron.config.json";
/** Read webServer config from the persisted tron.config.json. */
function readWebServerConfig() {
    try {
        const configPath = path_1.default.join(electron_1.app.getPath("userData"), CONFIG_FILE);
        if (fs_1.default.existsSync(configPath)) {
            const raw = JSON.parse(fs_1.default.readFileSync(configPath, "utf-8"));
            return {
                enabled: raw?.webServer?.enabled !== false,
                port: raw?.webServer?.port || 3888,
                expose: raw?.webServer?.expose !== false,
            };
        }
    }
    catch { /* use defaults */ }
    return { enabled: true, port: 3888, expose: true };
}
/** Resolve path to the server entry point (dev vs production). */
function getServerPath() {
    if (electron_1.app.isPackaged) {
        // Production: use the asar-unpacked copy so the forked child process
        // can resolve node_modules (express, ws, etc.) via normal require paths.
        return path_1.default.join(process.resourcesPath, "app.asar.unpacked", "dist-server", "index.js");
    }
    // Dev: built server is at project root dist-server/
    return path_1.default.join(__dirname, "../../dist-server/index.js");
}
/** Check if a port is available. */
function isPortAvailable(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const server = net_1.default.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => {
            server.close(() => resolve(true));
        });
        server.listen(port, host);
    });
}
/** Schedule an auto-restart with exponential backoff. */
function scheduleRestart() {
    if (intentionalStop)
        return;
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        console.error(`[Tron] Web server restart limit reached (${MAX_RESTART_ATTEMPTS} attempts). Giving up.`);
        return;
    }
    const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** restartAttempts, MAX_BACKOFF_MS);
    restartAttempts++;
    console.log(`[Tron] Scheduling web server restart in ${backoff}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
    restartTimer = setTimeout(async () => {
        restartTimer = null;
        const result = await startWebServer(lastStartPort, lastStartExpose);
        if (!result.success) {
            console.error(`[Tron] Web server restart failed: ${result.error}`);
            scheduleRestart();
        }
    }, backoff);
}
/** Start the web server as a forked child process. */
async function startWebServer(port, expose = true) {
    if (serverProcess) {
        return { success: false, error: "Server is already running" };
    }
    lastStartPort = port;
    lastStartExpose = expose;
    lastError = null;
    const serverPath = getServerPath();
    if (!fs_1.default.existsSync(serverPath)) {
        lastError = `Server not found at ${serverPath}`;
        return { success: false, error: lastError };
    }
    const host = expose ? "0.0.0.0" : "127.0.0.1";
    const available = await isPortAvailable(port, host);
    if (!available) {
        lastError = `Port ${port} is already in use`;
        return { success: false, error: lastError };
    }
    return new Promise((resolve) => {
        const isDev = !electron_1.app.isPackaged;
        const child = (0, child_process_1.fork)(serverPath, isDev ? ["--dev"] : [], {
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: "1",
                TRON_PORT: String(port),
                TRON_HOST: host,
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
        }, 10000);
        child.on("message", (msg) => {
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
                resolve({ success: true, port: currentPort });
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
        child.stdout?.on("data", (data) => {
            process.stdout.write(`[WebServer] ${data}`);
        });
        child.stderr?.on("data", (data) => {
            stderrBuf += data.toString();
            process.stderr.write(`[WebServer] ${data}`);
        });
    });
}
/** Stop the web server process. */
async function stopWebServer() {
    intentionalStop = true;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    restartAttempts = 0;
    if (!serverProcess)
        return;
    const child = serverProcess;
    serverProcess = null;
    currentPort = null;
    return new Promise((resolve) => {
        const forceTimeout = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            }
            catch { /* already dead */ }
            resolve();
        }, 3000);
        child.once("exit", () => {
            clearTimeout(forceTimeout);
            resolve();
        });
        try {
            child.kill("SIGTERM");
        }
        catch {
            clearTimeout(forceTimeout);
            resolve();
        }
    });
}
/** Get non-internal IPv4 addresses for this machine. */
function getLocalIPs() {
    const interfaces = os_1.default.networkInterfaces();
    const ips = [];
    for (const iface of Object.values(interfaces)) {
        if (!iface)
            continue;
        for (const info of iface) {
            // Node 18.4+ returns family as number (4/6), older versions as string ("IPv4"/"IPv6")
            const isIPv4 = info.family === "IPv4" || info.family === 4;
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
async function startWebServerManaged(port, expose = true) {
    intentionalStop = false;
    restartAttempts = 0;
    lastStartPort = port;
    lastStartExpose = expose;
    const result = await startWebServer(port, expose);
    if (!result.success)
        scheduleRestart();
    return result;
}
/** Get current server status. */
function getWebServerStatus() {
    return {
        running: serverProcess !== null && !serverProcess.killed,
        port: currentPort,
        expose: lastStartExpose,
        localIPs: getLocalIPs(),
        error: lastError,
        restarting: restartTimer !== null,
        restartAttempts,
    };
}
/** Register all web server IPC handlers. */
function registerWebServerHandlers() {
    electron_1.ipcMain.handle("webServer.start", async (_event, port, expose) => {
        return startWebServer(port || 3888, expose ?? true);
    });
    electron_1.ipcMain.handle("webServer.stop", async () => {
        await stopWebServer();
        return { success: true };
    });
    electron_1.ipcMain.handle("webServer.status", async () => {
        return getWebServerStatus();
    });
    electron_1.ipcMain.handle("webServer.checkPort", async (_event, port) => {
        const available = await isPortAvailable(port);
        return { available };
    });
    electron_1.ipcMain.handle("webServer.killPort", async (_event, port) => {
        try {
            const { execSync } = require("child_process");
            if (process.platform === "win32") {
                execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F`, { timeout: 5000, stdio: "ignore" });
            }
            else {
                execSync(`lsof -ti:${port} | xargs kill -9`, { timeout: 5000, stdio: "ignore" });
            }
            return { success: true };
        }
        catch {
            return { success: false };
        }
    });
}
//# sourceMappingURL=web-server.js.map