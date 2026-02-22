import { Client } from "ssh2";
import fs from "fs";
import path from "path";
import os from "os";
// --- SSH Session ---
let nextSyntheticPid = -1000;
export class SSHSession {
    constructor() {
        this.channel = null;
        this.dataListeners = [];
        this.exitListeners = [];
        this._connected = false;
        this.cachedCwd = null;
        this.cachedSystemInfo = null;
        this.pid = nextSyntheticPid--;
        this.client = new Client();
        this.config = {};
    }
    get connected() { return this._connected; }
    get sshClient() { return this.client; }
    async connect(config, cols, rows) {
        this.config = config;
        const connectConfig = {
            host: config.host,
            port: config.port || 22,
            username: config.username,
            readyTimeout: 10000,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
        };
        // Auth method
        if (config.authMethod === "password") {
            connectConfig.password = config.password;
        }
        else if (config.authMethod === "key") {
            if (config.privateKeyPath) {
                const keyPath = config.privateKeyPath.replace(/^~/, os.homedir());
                connectConfig.privateKey = fs.readFileSync(keyPath);
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
                        for (const listener of this.dataListeners) {
                            listener(str);
                        }
                    });
                    stream.stderr?.on("data", (data) => {
                        const str = data.toString("utf-8");
                        for (const listener of this.dataListeners) {
                            listener(str);
                        }
                    });
                    stream.on("close", () => {
                        this._connected = false;
                        for (const listener of this.exitListeners) {
                            listener({ exitCode: 0 });
                        }
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
                for (const listener of this.exitListeners) {
                    listener({ exitCode: 0 });
                }
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
        if (this.channel) {
            this.channel.write(data);
        }
    }
    resize(cols, rows) {
        if (this.channel) {
            this.channel.setWindow(rows, cols, rows * 16, cols * 8);
        }
    }
    kill() {
        if (this.channel) {
            try {
                this.channel.close();
            }
            catch { /* ignore */ }
        }
        try {
            this.client.end();
        }
        catch { /* ignore */ }
        this._connected = false;
    }
    /** Execute a command over SSH and return stdout/stderr. Uses client.exec(), not the shell channel. */
    async exec(command, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("SSH exec timed out"));
            }, timeout);
            this.client.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    reject(err);
                    return;
                }
                let stdout = "";
                let stderr = "";
                stream.on("data", (data) => {
                    stdout += data.toString("utf-8");
                });
                stream.stderr.on("data", (data) => {
                    stderr += data.toString("utf-8");
                });
                stream.on("close", (code) => {
                    clearTimeout(timer);
                    resolve({ stdout, stderr, exitCode: code ?? 0 });
                });
            });
        });
    }
    /** Get remote CWD by running pwd in the interactive shell and capturing output. */
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
    /** Get remote system info (cached after first call). */
    async getSystemInfo() {
        if (this.cachedSystemInfo)
            return this.cachedSystemInfo;
        try {
            const [platformResult, archResult, shellResult, releaseResult] = await Promise.all([
                this.exec("uname -s", 5000),
                this.exec("uname -m", 5000),
                this.exec("echo $SHELL", 5000),
                this.exec("uname -r", 5000),
            ]);
            this.cachedSystemInfo = {
                platform: platformResult.stdout.trim().toLowerCase() || "linux",
                arch: archResult.stdout.trim() || "unknown",
                shell: path.basename(shellResult.stdout.trim() || "bash"),
                release: releaseResult.stdout.trim() || "unknown",
            };
            return this.cachedSystemInfo;
        }
        catch {
            return { platform: "linux", arch: "unknown", shell: "bash", release: "unknown" };
        }
    }
    /** Get completions over SSH using compgen. */
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
    /** Check if a command exists on the remote. */
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
// --- SSH Session Tracking ---
// Set of session IDs that are SSH (vs local PTY)
export const sshSessionIds = new Set();
// Map of session ID → SSHSession instance (for SSH-specific operations)
export const sshSessions = new Map();
// --- SSH Profile Persistence ---
function getProfilesPath() {
    const homeDir = os.homedir();
    const tronDir = path.join(homeDir, ".tron");
    if (!fs.existsSync(tronDir)) {
        fs.mkdirSync(tronDir, { recursive: true });
    }
    return path.join(tronDir, "ssh-profiles.json");
}
export function readProfiles() {
    try {
        const filePath = getProfilesPath();
        if (!fs.existsSync(filePath))
            return [];
        const data = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(data);
    }
    catch {
        return [];
    }
}
export function writeProfiles(profiles) {
    try {
        const filePath = getProfilesPath();
        fs.writeFileSync(filePath, JSON.stringify(profiles, null, 2), "utf-8");
        return true;
    }
    catch {
        return false;
    }
}
// --- SSH Session Creation & Management ---
export async function createSSHSession(config, clientId, pushEvent, sessionMap, historyMap, ownerMap) {
    const session = new SSHSession();
    const sessionId = config.sessionId || `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await session.connect(config, config.cols || 80, config.rows || 30);
    // Register in tracking maps
    sshSessionIds.add(sessionId);
    sshSessions.set(sessionId, session);
    // Store in same session map as local PTY (PtyLike duck type)
    sessionMap.set(sessionId, session);
    historyMap.set(sessionId, "");
    if (ownerMap)
        ownerMap.set(sessionId, clientId);
    // Wire up data/exit events
    session.onData((data) => {
        const currentHistory = historyMap.get(sessionId) || "";
        if (currentHistory.length < 100000) {
            historyMap.set(sessionId, currentHistory + data);
        }
        else {
            historyMap.set(sessionId, currentHistory.slice(-80000) + data);
        }
        pushEvent("terminal.incomingData", { id: sessionId, data });
    });
    session.onExit(() => {
        pushEvent("terminal.exit", { id: sessionId, exitCode: 0 });
        pushEvent("ssh.statusChange", { sessionId, status: "disconnected" });
        sessionMap.delete(sessionId);
        historyMap.delete(sessionId);
        sshSessionIds.delete(sessionId);
        sshSessions.delete(sessionId);
        if (ownerMap)
            ownerMap.delete(sessionId);
    });
    // Save profile if requested
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
        if (existingIdx >= 0) {
            profiles[existingIdx] = profile;
        }
        else {
            profiles.push(profile);
        }
        writeProfiles(profiles);
    }
    pushEvent("ssh.statusChange", { sessionId, status: "connected" });
    return { sessionId };
}
export async function testConnection(config) {
    const client = new Client();
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
                const keyPath = config.privateKeyPath.replace(/^~/, os.homedir());
                connectConfig.privateKey = fs.readFileSync(keyPath);
            }
            catch (e) {
                return { success: false, error: `Cannot read key file: ${e.message}` };
            }
        }
        if (config.passphrase) {
            connectConfig.passphrase = config.passphrase;
        }
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
}
export function disconnectSession(sessionId) {
    const session = sshSessions.get(sessionId);
    if (!session)
        return false;
    session.kill();
    return true;
}
/** Clean up all SSH sessions owned by a client. */
export function cleanupClientSSHSessions(clientId, ownerMap) {
    for (const [sessionId, owner] of ownerMap.entries()) {
        if (owner === clientId && sshSessionIds.has(sessionId)) {
            disconnectSession(sessionId);
        }
    }
}
/** Clean up all SSH sessions. */
export function cleanupAllSSHSessions() {
    for (const [, session] of sshSessions) {
        try {
            session.kill();
        }
        catch { /* ignore */ }
    }
    sshSessions.clear();
    sshSessionIds.clear();
}
//# sourceMappingURL=ssh.js.map