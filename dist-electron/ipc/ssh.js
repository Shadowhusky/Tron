"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sshSessions = exports.sshSessionIds = void 0;
exports.registerSSHHandlers = registerSSHHandlers;
exports.cleanupAllSSHSessions = cleanupAllSSHSessions;
const electron_1 = require("electron");
const ssh2_1 = require("ssh2");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
// --- SSH Session Class ---
let nextSyntheticPid = -1000;
class SSHSession {
    constructor() {
        this.channel = null;
        this.dataListeners = [];
        this.exitListeners = [];
        this._connected = false;
        this.cachedCwd = null;
        this.cachedSystemInfo = null;
        this.pid = nextSyntheticPid--;
        this.client = new ssh2_1.Client();
    }
    get connected() { return this._connected; }
    get sshClient() { return this.client; }
    async connect(config, cols, rows) {
        const connectConfig = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
            readyTimeout: 10000,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
        };
        if (config.authMethod === "password") {
            connectConfig.password = config.password;
        }
        else if (config.authMethod === "key") {
            if (config.privateKeyPath) {
                const keyPath = config.privateKeyPath.replace(/^~/, os_1.default.homedir());
                connectConfig.privateKey = fs_1.default.readFileSync(keyPath);
            }
            if (config.passphrase) {
                connectConfig.passphrase = config.passphrase;
            }
        }
        else if (config.authMethod === "agent") {
            connectConfig.agent = process.env.SSH_AUTH_SOCK;
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("SSH connection timed out"));
                this.client.end();
            }, 15000);
            this.client.on("ready", () => {
                clearTimeout(timeout);
                this._connected = true;
                this.client.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    this.channel = stream;
                    stream.on("data", (data) => {
                        const str = data.toString("utf-8");
                        for (const listener of this.dataListeners)
                            listener(str);
                    });
                    stream.stderr?.on("data", (data) => {
                        const str = data.toString("utf-8");
                        for (const listener of this.dataListeners)
                            listener(str);
                    });
                    stream.on("close", () => {
                        this._connected = false;
                        for (const listener of this.exitListeners)
                            listener({ exitCode: 0 });
                    });
                    resolve();
                });
            });
            this.client.on("error", (err) => {
                clearTimeout(timeout);
                this._connected = false;
                reject(err);
            });
            this.client.on("close", () => {
                this._connected = false;
                for (const listener of this.exitListeners)
                    listener({ exitCode: 0 });
            });
            this.client.connect(connectConfig);
        });
    }
    onData(cb) {
        this.dataListeners.push(cb);
        return {
            dispose: () => {
                const idx = this.dataListeners.indexOf(cb);
                if (idx >= 0)
                    this.dataListeners.splice(idx, 1);
            },
        };
    }
    onExit(cb) {
        this.exitListeners.push(cb);
        return {
            dispose: () => {
                const idx = this.exitListeners.indexOf(cb);
                if (idx >= 0)
                    this.exitListeners.splice(idx, 1);
            },
        };
    }
    write(data) {
        if (this.channel)
            this.channel.write(data);
    }
    resize(cols, rows) {
        if (this.channel)
            this.channel.setWindow(rows, cols, rows * 16, cols * 8);
    }
    kill() {
        try {
            this.channel?.close();
        }
        catch { /* ignore */ }
        try {
            this.client.end();
        }
        catch { /* ignore */ }
        this._connected = false;
    }
    async exec(command, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("SSH exec timed out")), timeout);
            this.client.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    reject(err);
                    return;
                }
                let stdout = "";
                let stderr = "";
                stream.on("data", (data) => { stdout += data.toString("utf-8"); });
                stream.stderr.on("data", (data) => { stderr += data.toString("utf-8"); });
                stream.on("close", (code) => {
                    clearTimeout(timer);
                    resolve({ stdout, stderr, exitCode: code ?? 0 });
                });
            });
        });
    }
    async getCwd() {
        try {
            const result = await this.exec("pwd", 5000);
            const cwd = result.stdout.trim();
            if (cwd) {
                this.cachedCwd = cwd;
                return cwd;
            }
            return this.cachedCwd;
        }
        catch {
            return this.cachedCwd;
        }
    }
    async getSystemInfo() {
        if (this.cachedSystemInfo)
            return this.cachedSystemInfo;
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
                shell: path_1.default.basename(s.stdout.trim() || "bash"),
                release: r.stdout.trim() || "unknown",
            };
            return this.cachedSystemInfo;
        }
        catch {
            return { platform: "linux", arch: "unknown", shell: "bash", release: "unknown" };
        }
    }
    async getCompletions(prefix) {
        try {
            const parts = prefix.trim().split(/\s+/);
            const safeWord = (parts.length <= 1 ? (parts[0] || "") : parts[parts.length - 1]).replace(/"/g, '\\"');
            const compType = parts.length <= 1 ? "-abck" : "-df";
            const cmd = `bash -c 'compgen ${compType} "${safeWord}" 2>/dev/null | sort -u | head -30'`;
            const result = await this.exec(cmd, 5000);
            const results = result.stdout.trim().split("\n").filter(Boolean);
            return [...new Set(results)].sort((a, b) => a.length - b.length).slice(0, 15);
        }
        catch {
            return [];
        }
    }
    async checkCommand(command) {
        try {
            const result = await this.exec(`which ${command}`, 5000);
            return result.exitCode === 0;
        }
        catch {
            return false;
        }
    }
}
// --- Tracking ---
exports.sshSessionIds = new Set();
exports.sshSessions = new Map();
// --- Profile Persistence ---
function getProfilesPath() {
    const dir = path_1.default.join(electron_1.app.getPath("userData"), "ssh-profiles");
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
    return path_1.default.join(dir, "profiles.json");
}
function readProfiles() {
    try {
        const filePath = getProfilesPath();
        if (!fs_1.default.existsSync(filePath))
            return [];
        return JSON.parse(fs_1.default.readFileSync(filePath, "utf-8"));
    }
    catch {
        return [];
    }
}
function writeProfiles(profiles) {
    try {
        fs_1.default.writeFileSync(getProfilesPath(), JSON.stringify(profiles, null, 2), "utf-8");
        return true;
    }
    catch {
        return false;
    }
}
// --- Register IPC Handlers ---
function registerSSHHandlers(getMainWindow, getSessions, getSessionHistory) {
    electron_1.ipcMain.handle("ssh.connect", async (_event, config) => {
        const session = new SSHSession();
        const sessionId = config.sessionId || `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await session.connect(config, config.cols || 80, config.rows || 30);
        // Register in tracking
        exports.sshSessionIds.add(sessionId);
        exports.sshSessions.set(sessionId, session);
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
            }
            else {
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
            exports.sshSessionIds.delete(sessionId);
            exports.sshSessions.delete(sessionId);
        });
        // Save profile
        if (config.saveCredentials || config.name) {
            const profiles = readProfiles();
            const existingIdx = profiles.findIndex((p) => p.id === config.id);
            const profile = {
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
            if (existingIdx >= 0)
                profiles[existingIdx] = profile;
            else
                profiles.push(profile);
            writeProfiles(profiles);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("ssh.statusChange", { sessionId, status: "connected" });
        }
        return { sessionId };
    });
    electron_1.ipcMain.handle("ssh.testConnection", async (_event, config) => {
        const client = new ssh2_1.Client();
        const connectConfig = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
            readyTimeout: 10000,
        };
        if (config.authMethod === "password") {
            connectConfig.password = config.password;
        }
        else if (config.authMethod === "key") {
            if (config.privateKeyPath) {
                try {
                    const keyPath = config.privateKeyPath.replace(/^~/, os_1.default.homedir());
                    connectConfig.privateKey = fs_1.default.readFileSync(keyPath);
                }
                catch (e) {
                    return { success: false, error: `Cannot read key file: ${e.message}` };
                }
            }
            if (config.passphrase)
                connectConfig.passphrase = config.passphrase;
        }
        else if (config.authMethod === "agent") {
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
            client.on("error", (err) => {
                clearTimeout(timeout);
                resolve({ success: false, error: err.message });
            });
            client.connect(connectConfig);
        });
    });
    electron_1.ipcMain.handle("ssh.disconnect", (_event, sessionId) => {
        const session = exports.sshSessions.get(sessionId);
        if (!session)
            return false;
        session.kill();
        return true;
    });
    electron_1.ipcMain.handle("ssh.profiles.read", () => {
        return readProfiles();
    });
    electron_1.ipcMain.handle("ssh.profiles.write", (_event, profiles) => {
        return writeProfiles(profiles);
    });
}
function cleanupAllSSHSessions() {
    for (const [, session] of exports.sshSessions) {
        try {
            session.kill();
        }
        catch { /* ignore */ }
    }
    exports.sshSessions.clear();
    exports.sshSessionIds.clear();
}
//# sourceMappingURL=ssh.js.map