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
function getConfigPath() {
    return path_1.default.join(electron_1.app.getPath("userData"), CONFIG_FILE);
}
function registerConfigHandlers() {
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
}
//# sourceMappingURL=config.js.map