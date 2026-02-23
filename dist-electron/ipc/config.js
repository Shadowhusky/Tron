"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerConfigHandlers = registerConfigHandlers;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
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
        try {
            const sessionsPath = getSessionsPath();
            if (!fs_1.default.existsSync(sessionsPath))
                return null;
            const raw = fs_1.default.readFileSync(sessionsPath, "utf-8");
            return JSON.parse(raw);
        }
        catch (e) {
            console.error("Failed to read sessions:", e);
            return null;
        }
    });
    electron_1.ipcMain.handle("sessions.write", async (_event, data) => {
        try {
            const sessionsPath = getSessionsPath();
            // Merge top-level keys (allows multiple contexts to coexist: _layout, _agent, etc.)
            let existing = {};
            try {
                if (fs_1.default.existsSync(sessionsPath)) {
                    existing = JSON.parse(fs_1.default.readFileSync(sessionsPath, "utf-8"));
                }
            }
            catch { /* start fresh if corrupt */ }
            fs_1.default.writeFileSync(sessionsPath, JSON.stringify({ ...existing, ...data }, null, 2), "utf-8");
            return true;
        }
        catch (e) {
            console.error("Failed to write sessions:", e);
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