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
const ssh_1 = require("./ipc/ssh");
const web_server_1 = require("./ipc/web-server");
const updater_1 = require("./ipc/updater");
const web_1 = require("./ipc/web");
const skills_1 = require("./ipc/skills");
// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
    electron_1.app.quit();
}
// In dev mode, use a separate userData directory so the dev app doesn't
// conflict with a running packaged app (LevelDB locks on localStorage).
if (!electron_1.app.isPackaged && process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production") {
    electron_1.app.setPath("userData", path_1.default.join(electron_1.app.getPath("userData"), "dev"));
}
// Ensure Playwright E2E tests do not mutate the user's real application state
if (process.env.TRON_TEST_PROFILE) {
    const fs = require("fs");
    if (!fs.existsSync(process.env.TRON_TEST_PROFILE)) {
        fs.mkdirSync(process.env.TRON_TEST_PROFILE, { recursive: true });
    }
    electron_1.app.setPath("userData", process.env.TRON_TEST_PROFILE);
}
// Note: do NOT use disable-gpu / disable-software-rasterizer — they force
// Chromium into a very slow CPU-only rendering path. The macOS
// SharedImageManager console warnings are harmless.
// --- Global State ---
let mainWindow = null;
let forceQuit = false;
let quitPending = false; // true when Cmd+Q / dock quit is waiting for user confirmation
let closeAttempts = 0;
let closeTimeout = null;
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
                        await shell.openExternal("https://tronai.dev");
                    },
                },
                {
                    label: "GitHub",
                    click: async () => {
                        const { shell } = await Promise.resolve().then(() => __importStar(require("electron")));
                        await shell.openExternal("https://github.com/Shadowhusky/Tron");
                    },
                },
                {
                    label: "Discord",
                    click: async () => {
                        const { shell } = await Promise.resolve().then(() => __importStar(require("electron")));
                        await shell.openExternal("https://discord.gg/EeTCS7A6");
                    },
                },
                { type: "separator" },
                {
                    label: "Report Issue",
                    click: async () => {
                        const { shell } = await Promise.resolve().then(() => __importStar(require("electron")));
                        await shell.openExternal("https://github.com/Shadowhusky/Tron/issues");
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
    const isMacOS = process.platform === "darwin";
    const shouldHide = process.argv.includes("--hidden");
    mainWindow = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        show: false, // Defer show until ready-to-show for faster perceived launch
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
            // Disable CORS enforcement so renderer can call external APIs directly
            // (Anthropic, LM Studio, Ollama, etc.). Safe for desktop apps with
            // controlled content — contextIsolation + preload allowlist remain active.
            webSecurity: false,
        },
        ...(isMacOS
            ? {
                titleBarStyle: "hiddenInset",
                vibrancy: "under-window",
                visualEffectState: "active",
                backgroundColor: "#00000000",
            }
            : {
                // Windows/Linux: hide title bar, use native overlay buttons
                titleBarStyle: "hidden",
                ...(process.platform === "win32"
                    ? {
                        titleBarOverlay: {
                            color: "#0a0a0a",
                            symbolColor: "#ffffff",
                            height: 40,
                        },
                        backgroundMaterial: "mica",
                    }
                    : {}),
                backgroundColor: "#0a0a0a",
            }),
    });
    createMenu(mainWindow);
    // Show window once content is painted — avoids blank window flash on Windows
    if (!shouldHide) {
        mainWindow.once("ready-to-show", () => {
            mainWindow?.show();
        });
    }
    // Intercept close to show confirmation in renderer
    mainWindow.on("close", (e) => {
        if (!forceQuit && mainWindow && !mainWindow.isDestroyed()) {
            closeAttempts++;
            // 3rd close attempt → force close (renderer is likely frozen/unresponsive)
            if (closeAttempts >= 3) {
                forceQuit = true;
                return; // let the close proceed
            }
            e.preventDefault();
            mainWindow.webContents.send("window.confirmClose");
            // Safety timeout — if renderer doesn't respond within 5s, force close
            if (closeTimeout)
                clearTimeout(closeTimeout);
            closeTimeout = setTimeout(() => {
                forceQuit = true;
                if (mainWindow && !mainWindow.isDestroyed())
                    mainWindow.close();
            }, 5000);
        }
    });
    mainWindow.on("closed", () => {
        (0, ssh_1.cleanupAllSSHSessions)();
        (0, terminal_1.cleanupAllSessions)();
        mainWindow = null;
    });
    const isDev = !electron_1.app.isPackaged && process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production";
    const devPort = process.env.PORT || 5173;
    if (isDev) {
        mainWindow.loadURL(`http://localhost:${devPort}`);
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path_1.default.join(__dirname, "../dist-react/index.html"));
    }
};
// --- Clipboard readers ---
electron_1.ipcMain.handle("clipboard.readImage", async () => {
    const { clipboard } = await Promise.resolve().then(() => __importStar(require("electron")));
    const image = clipboard.readImage();
    if (image.isEmpty())
        return null;
    const png = image.toPNG();
    return png.toString("base64");
});
// Read file paths from system clipboard (e.g. files copied in Finder/Explorer)
electron_1.ipcMain.handle("clipboard.readFilePaths", async () => {
    const { clipboard } = await Promise.resolve().then(() => __importStar(require("electron")));
    if (process.platform === "darwin") {
        // macOS: NSFilenamesPboardType is exposed as a property list (XML plist)
        // containing an array of file path strings.
        try {
            const raw = clipboard.read("NSFilenamesPboardType");
            if (raw) {
                // Parse plist XML — extract <string> values
                const paths = Array.from(raw.matchAll(/<string>([^<]+)<\/string>/g), m => m[1]);
                if (paths.length > 0)
                    return paths;
            }
        }
        catch { /* not available */ }
        // Fallback: public.file-url
        try {
            const fileUrl = clipboard.read("public.file-url");
            if (fileUrl) {
                const decoded = decodeURIComponent(fileUrl.replace(/^file:\/\//, ""));
                if (decoded)
                    return [decoded];
            }
        }
        catch { /* not available */ }
    }
    else if (process.platform === "win32") {
        // Windows: CF_HDROP exposed via FileNameW
        try {
            const buf = clipboard.readBuffer("FileNameW");
            if (buf && buf.length > 0) {
                const decoded = buf.toString("ucs2").replace(/\0+$/, "");
                if (decoded)
                    return [decoded];
            }
        }
        catch { /* not available */ }
    }
    return null;
});
// --- Register all IPC handlers ---
(0, terminal_1.registerTerminalHandlers)(() => mainWindow);
(0, ssh_1.registerSSHHandlers)(() => mainWindow, terminal_1.getSessions, terminal_1.getSessionHistory);
(0, system_1.registerSystemHandlers)();
(0, ai_1.registerAIHandlers)();
(0, config_1.registerConfigHandlers)();
(0, web_server_1.registerWebServerHandlers)();
(0, web_1.registerWebHandlers)();
(0, skills_1.registerSkillsHandlers)();
(0, updater_1.registerUpdaterHandlers)(() => mainWindow, () => { forceQuit = true; });
// --- Window close response from renderer ---
electron_1.ipcMain.on("window.closeConfirmed", () => {
    if (closeTimeout) {
        clearTimeout(closeTimeout);
        closeTimeout = null;
    }
    closeAttempts = 0;
    // Flush all terminal history to disk immediately before closing.
    // This ensures the latest PTY output is persisted even if the window
    // close + cleanup sequence has timing issues.
    (0, terminal_1.persistAllHistory)();
    forceQuit = true;
    if (quitPending) {
        // Cmd+Q / dock quit — quit the entire app (not just close the window)
        quitPending = false;
        electron_1.app.quit();
    }
    else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
    }
});
electron_1.ipcMain.on("window.closeCancelled", () => {
    if (closeTimeout) {
        clearTimeout(closeTimeout);
        closeTimeout = null;
    }
    closeAttempts = 0;
    quitPending = false;
});
// Update Windows title bar overlay colors when theme changes
electron_1.ipcMain.on("window.themeChanged", (_, resolvedTheme) => {
    if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed())
        return;
    const isLight = resolvedTheme === "light";
    mainWindow.setTitleBarOverlay({
        color: isLight ? "#f3f4f6" : "#0a0a0a",
        symbolColor: isLight ? "#111827" : "#ffffff",
    });
});
// --- App lifecycle ---
electron_1.app.whenReady().then(async () => {
    createWindow();
    electron_1.app.on("activate", () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
    // Auto-start integrated web server (auto-restarts on crash with backoff)
    const wsConfig = (0, web_server_1.readWebServerConfig)();
    if (wsConfig.enabled) {
        const result = await (0, web_server_1.startWebServerManaged)(wsConfig.port, wsConfig.expose);
        if (!result.success) {
            console.error(`[Tron] Web server initial start failed (will retry): ${result.error}`);
        }
    }
    // Auto-check for updates (deferred — does not block launch)
    {
        let autoUpdate = true;
        try {
            const fs = require("fs");
            const cfgPath = path_1.default.join(electron_1.app.getPath("userData"), "tron.config.json");
            if (fs.existsSync(cfgPath)) {
                const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
                if (raw?.autoUpdate === false)
                    autoUpdate = false;
            }
        }
        catch { /* use default */ }
        (0, updater_1.autoCheckForUpdates)(autoUpdate, () => mainWindow);
    }
});
electron_1.app.on("window-all-closed", () => {
    (0, terminal_1.cleanupAllSessions)();
    // Synchronous shutdown — async stopWebServer can be aborted by Electron's
    // quit sequence, orphaning the child and leaving the port bound for the
    // next launch. The sync variant SIGKILLs and reaps the port immediately.
    (0, web_server_1.stopWebServerSync)();
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.app.on("before-quit", (e) => {
    if (forceQuit) {
        // Already confirmed or force-closing — proceed with cleanup
        (0, ssh_1.cleanupAllSSHSessions)();
        (0, terminal_1.cleanupAllSessions)();
        // See note above — sync variant survives Electron tearing down before
        // an async kill resolves. Critical on auto-update where the new app
        // instance starts within seconds of the old one quitting.
        (0, web_server_1.stopWebServerSync)();
        return;
    }
    // Intercept Cmd+Q / dock quit to show the close confirm modal,
    // same as clicking the window close button.
    if (mainWindow && !mainWindow.isDestroyed()) {
        e.preventDefault();
        quitPending = true;
        // Trigger the same close interception flow as the window close button.
        // The renderer will show the confirm modal and respond with
        // window.closeConfirmed or window.closeCancelled.
        mainWindow.webContents.send("window.confirmClose");
        // Safety timeout — if renderer doesn't respond within 5s, force quit
        if (closeTimeout)
            clearTimeout(closeTimeout);
        closeTimeout = setTimeout(() => {
            forceQuit = true;
            quitPending = false;
            electron_1.app.quit();
        }, 5000);
    }
});
//# sourceMappingURL=main.js.map