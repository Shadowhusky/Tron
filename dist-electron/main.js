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
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const terminal_1 = require("./ipc/terminal");
const system_1 = require("./ipc/system");
const ai_1 = require("./ipc/ai");
const config_1 = require("./ipc/config");
// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
    electron_1.app.quit();
}
// Suppress Chromium GPU SharedImageManager / mailbox errors on macOS.
electron_1.app.commandLine.appendSwitch("disable-gpu");
electron_1.app.commandLine.appendSwitch("disable-software-rasterizer");
// --- Global State ---
let mainWindow = null;
let forceQuit = false;
// --- Menu Helper ---
const createMenu = (win) => {
    const isMac = process.platform === "darwin";
    const template = [
        ...(isMac
            ? [
                {
                    label: electron_1.app.name,
                    submenu: [
                        { role: "about" },
                        { type: "separator" },
                        { role: "services" },
                        { type: "separator" },
                        { role: "hide" },
                        { role: "hideOthers" },
                        { role: "unhide" },
                        { type: "separator" },
                        { role: "quit" },
                    ],
                },
            ]
            : []),
        {
            label: "File",
            submenu: [
                {
                    label: "New Tab",
                    accelerator: "CmdOrCtrl+T",
                    click: () => {
                        win.webContents.send("menu.createTab");
                    },
                },
                {
                    label: "Close Tab",
                    accelerator: "CmdOrCtrl+W",
                    click: () => {
                        win.webContents.send("menu.closeTab");
                    },
                },
                { type: "separator" },
                { role: "close" },
            ],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
        {
            role: "help",
            submenu: [
                {
                    label: "Learn More",
                    click: async () => {
                        const { shell } = await Promise.resolve().then(() => __importStar(require("electron")));
                        await shell.openExternal("https://electronjs.org");
                    },
                },
            ],
        },
    ];
    const menu = electron_1.Menu.buildFromTemplate(template);
    electron_1.Menu.setApplicationMenu(menu);
};
// --- Window Creation ---
const createWindow = () => {
    const preloadPath = path_1.default.join(__dirname, "preload.js");
    console.log("Preload Path:", preloadPath);
    const isMacOS = process.platform === "darwin";
    mainWindow = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
        },
        ...(isMacOS
            ? {
                titleBarStyle: "hiddenInset",
                vibrancy: "under-window",
                visualEffectState: "active",
                backgroundColor: "#00000000",
            }
            : {
                // Windows/Linux: use Mica material on Windows 11, opaque background otherwise
                ...(process.platform === "win32" ? { backgroundMaterial: "mica" } : {}),
                backgroundColor: "#0a0a0a",
            }),
    });
    createMenu(mainWindow);
    // Intercept close to show confirmation in renderer
    mainWindow.on("close", (e) => {
        if (!forceQuit && mainWindow && !mainWindow.isDestroyed()) {
            e.preventDefault();
            mainWindow.webContents.send("window.confirmClose");
        }
    });
    mainWindow.on("closed", () => {
        (0, terminal_1.cleanupAllSessions)();
        mainWindow = null;
    });
    const isDev = !electron_1.app.isPackaged;
    const devPort = process.env.PORT || 5173;
    if (isDev) {
        mainWindow.loadURL(`http://localhost:${devPort}`);
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path_1.default.join(__dirname, "../dist-react/index.html"));
    }
};
// --- Register all IPC handlers ---
(0, terminal_1.registerTerminalHandlers)(() => mainWindow);
(0, system_1.registerSystemHandlers)();
(0, ai_1.registerAIHandlers)();
(0, config_1.registerConfigHandlers)();
// --- Window close response from renderer ---
electron_1.ipcMain.on("window.closeConfirmed", () => {
    forceQuit = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
    }
});
electron_1.ipcMain.on("window.closeCancelled", () => {
    // No-op — renderer dismissed the modal
});
// --- App lifecycle ---
electron_1.app.whenReady().then(() => {
    createWindow();
    electron_1.app.on("activate", () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on("window-all-closed", () => {
    (0, terminal_1.cleanupAllSessions)();
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.app.on("before-quit", () => {
    forceQuit = true;
    (0, terminal_1.cleanupAllSessions)();
});
//# sourceMappingURL=main.js.map