"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSystemHandlers = registerSystemHandlers;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
function registerSystemHandlers() {
    electron_1.ipcMain.handle("system.fixPermissions", async () => {
        if (process.platform !== "darwin")
            return true;
        const nodePtyPath = path_1.default.join(__dirname, "../../node_modules/node-pty");
        const fixCommand = `chmod -R +x "${nodePtyPath}"`;
        try {
            await new Promise((resolve, reject) => {
                require("child_process").exec(fixCommand, (error) => {
                    if (error)
                        reject(error);
                    else
                        resolve();
                });
            });
            return true;
        }
        catch (error) {
            console.error("Failed to fix permissions:", error);
            return false;
        }
    });
    electron_1.ipcMain.handle("system.checkPermissions", async () => {
        if (process.platform !== "darwin")
            return true;
        try {
            await fs_1.default.promises.access("/Library/Preferences/com.apple.TimeMachine.plist", fs_1.default.constants.R_OK);
            return true;
        }
        catch (error) {
            console.log("FDA Check 1 (TimeMachine) failed:", error.code);
            try {
                const safariPath = path_1.default.join(os_1.default.homedir(), "Library/Safari");
                await fs_1.default.promises.readdir(safariPath);
                return true;
            }
            catch (e2) {
                console.log("FDA Check 2 (Safari) failed:", e2.code);
                return false;
            }
        }
    });
    electron_1.ipcMain.handle("system.selectFolder", async (_event, defaultPath) => {
        const win = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0];
        if (!win)
            return null;
        const result = await electron_1.dialog.showOpenDialog(win, {
            properties: ["openDirectory"],
            title: "Select Directory",
            ...(defaultPath ? { defaultPath } : {}),
        });
        if (result.canceled || result.filePaths.length === 0)
            return null;
        return result.filePaths[0];
    });
    electron_1.ipcMain.handle("system.openPrivacySettings", async () => {
        if (process.platform !== "darwin")
            return;
        const { exec } = await Promise.resolve().then(() => __importStar(require("child_process")));
        const commands = [
            'open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"',
            'open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"',
        ];
        for (const cmd of commands) {
            exec(cmd, (error) => {
                if (error)
                    console.error("Failed to open settings via:", cmd, error);
            });
        }
    });
}
//# sourceMappingURL=system.js.map