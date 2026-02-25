"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readWebServerConfig = readWebServerConfig;
exports.startWebServer = startWebServer;
exports.stopWebServer = stopWebServer;
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
            };
        }
    }
    catch { /* use defaults */ }
    return { enabled: true, port: 3888 };
}
/** Resolve path to the server entry point (dev vs production). */
function getServerPath() {
    if (electron_1.app.isPackaged) {
        // Production: dist-server is in extraResources
        return path_1.default.join(process.resourcesPath, "dist-server", "index.js");
    }
    // Dev: built server is at project root dist-server/
    return path_1.default.join(__dirname, "../../dist-server/index.js");
}
/** Check if a port is available. */
function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net_1.default.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => {
            server.close(() => resolve(true));
        });
        server.listen(port, "0.0.0.0");
    });
}
/** Start the web server as a forked child process. */
async function startWebServer(port) {
    if (serverProcess) {
        return { success: false, error: "Server is already running" };
    }
    const serverPath = getServerPath();
    if (!fs_1.default.existsSync(serverPath)) {
        return { success: false, error: `Server not found at ${serverPath}` };
    }
    const available = await isPortAvailable(port);
    if (!available) {
        return { success: false, error: `Port ${port} is already in use` };
    }
    return new Promise((resolve) => {
        const isDev = !electron_1.app.isPackaged;
        const child = (0, child_process_1.fork)(serverPath, isDev ? ["--dev"] : [], {
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: "1",
                TRON_PORT: String(port),
                TRON_DEV: isDev ? "true" : "false",
            },
            stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
        const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            serverProcess = null;
            currentPort = null;
            resolve({ success: false, error: "Server startup timed out (10s)" });
        }, 10000);
        child.on("message", (msg) => {
            if (msg?.type === "ready") {
                clearTimeout(timeout);
                serverProcess = child;
                currentPort = msg.port || port;
                console.log(`[Tron] Web server started on port ${currentPort}`);
                resolve({ success: true, port: currentPort });
            }
        });
        child.on("error", (err) => {
            clearTimeout(timeout);
            serverProcess = null;
            currentPort = null;
            resolve({ success: false, error: err.message });
        });
        child.on("exit", (code) => {
            clearTimeout(timeout);
            if (serverProcess === child) {
                console.log(`[Tron] Web server exited with code ${code}`);
                serverProcess = null;
                currentPort = null;
            }
        });
        // Forward server stdout/stderr to Electron's console
        child.stdout?.on("data", (data) => {
            process.stdout.write(`[WebServer] ${data}`);
        });
        child.stderr?.on("data", (data) => {
            process.stderr.write(`[WebServer] ${data}`);
        });
    });
}
/** Stop the web server process. */
async function stopWebServer() {
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
            if (info.family === "IPv4" && !info.internal) {
                ips.push(info.address);
            }
        }
    }
    return ips;
}
/** Get current server status. */
function getWebServerStatus() {
    return {
        running: serverProcess !== null && !serverProcess.killed,
        port: currentPort,
        localIPs: getLocalIPs(),
    };
}
/** Register all web server IPC handlers. */
function registerWebServerHandlers() {
    electron_1.ipcMain.handle("webServer.start", async (_event, port) => {
        return startWebServer(port || 3888);
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
}
//# sourceMappingURL=web-server.js.map