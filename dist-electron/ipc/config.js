"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerConfigHandlers = registerConfigHandlers;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const CONFIG_FILE = "tron.config.json";
const SESSIONS_FILE = "tron.sessions.json";
function getConfigPath() {
    return path_1.default.join(electron_1.app.getPath("userData"), CONFIG_FILE);
}
function getSessionsPath() {
    return path_1.default.join(electron_1.app.getPath("userData"), SESSIONS_FILE);
}
function registerConfigHandlers() {
    // --- App Config ---
    electron_1.ipcMain.handle("config.read", async () => {
        try {
            const configPath = getConfigPath();
            if (!fs_1.default.existsSync(configPath))
                return null;
            const raw = fs_1.default.readFileSync(configPath, "utf-8");
            return JSON.parse(raw);
        }
        catch (e) {
            console.error("Failed to read config:", e);
            return null;
        }
    });
    electron_1.ipcMain.handle("config.write", async (_event, data) => {
        try {
            const configPath = getConfigPath();
            fs_1.default.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
            return true;
        }
        catch (e) {
            console.error("Failed to write config:", e);
            return false;
        }
    });
    // --- Agent Session State ---
    electron_1.ipcMain.handle("sessions.read", async () => {
        const sessionsPath = getSessionsPath();
        try {
            if (!fs_1.default.existsSync(sessionsPath))
                return null;
            const raw = fs_1.default.readFileSync(sessionsPath, "utf-8");
            return JSON.parse(raw);
        }
        catch (e) {
            console.error("Failed to read sessions:", e);
            // If main file is corrupt (e.g. crash mid-write before atomic rename was adopted),
            // try the .tmp file which may contain a valid previous write
            try {
                const tmpPath = sessionsPath + ".tmp";
                if (fs_1.default.existsSync(tmpPath)) {
                    const raw = fs_1.default.readFileSync(tmpPath, "utf-8");
                    return JSON.parse(raw);
                }
            }
            catch { /* both corrupt — give up */ }
            return null;
        }
    });
    /** Shared write logic — atomic tmp+rename */
    function writeSessionsSync(data) {
        try {
            const sessionsPath = getSessionsPath();
            let existing = {};
            try {
                if (fs_1.default.existsSync(sessionsPath)) {
                    existing = JSON.parse(fs_1.default.readFileSync(sessionsPath, "utf-8"));
                }
            }
            catch { /* start fresh if corrupt */ }
            // Atomic write: write to tmp file then rename, so a crash mid-write
            // never corrupts the sessions file (rename is atomic on most filesystems).
            const tmpPath = sessionsPath + ".tmp";
            fs_1.default.writeFileSync(tmpPath, JSON.stringify({ ...existing, ...data }, null, 2), "utf-8");
            fs_1.default.renameSync(tmpPath, sessionsPath);
            return true;
        }
        catch (e) {
            console.error("Failed to write sessions:", e);
            return false;
        }
    }
    electron_1.ipcMain.handle("sessions.write", async (_event, data) => {
        return writeSessionsSync(data);
    });
    // Synchronous write — blocks renderer but guarantees data is on disk before returning.
    // Used by the reactive layout save so force-quit can't lose state.
    electron_1.ipcMain.on("sessions.writeSync", (event, data) => {
        event.returnValue = writeSessionsSync(data);
    });
    // --- Saved Tabs (cross-device snapshots) ---
    // Use ~/.tron/ (same path as web server) so Electron and web mode share the same file.
    const getSavedTabsPath = () => {
        const dir = path_1.default.join(os_1.default.homedir(), ".tron");
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        return path_1.default.join(dir, "saved-tabs.json");
    };
    electron_1.ipcMain.handle("savedTabs.read", async () => {
        try {
            const filePath = getSavedTabsPath();
            if (!fs_1.default.existsSync(filePath))
                return [];
            return JSON.parse(fs_1.default.readFileSync(filePath, "utf-8"));
        }
        catch {
            return [];
        }
    });
    electron_1.ipcMain.handle("savedTabs.write", async (_event, data) => {
        try {
            fs_1.default.writeFileSync(getSavedTabsPath(), JSON.stringify(data, null, 2), "utf-8");
            return true;
        }
        catch {
            return false;
        }
    });
    // --- System Paths ---
    electron_1.ipcMain.handle("config.getSystemPaths", async () => {
        return {
            home: electron_1.app.getPath("home"),
            desktop: electron_1.app.getPath("desktop"),
            documents: electron_1.app.getPath("documents"),
            downloads: electron_1.app.getPath("downloads"),
            temp: electron_1.app.getPath("temp"),
        };
    });
}
//# sourceMappingURL=config.js.map