import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  ipcMain,
} from "electron";
import path from "path";
import { registerTerminalHandlers, cleanupAllSessions, persistAllHistory, getSessions, getSessionHistory } from "./ipc/terminal";
import { registerSystemHandlers } from "./ipc/system";
import { registerAIHandlers } from "./ipc/ai";
import { registerConfigHandlers } from "./ipc/config";
import { registerSSHHandlers, cleanupAllSSHSessions } from "./ipc/ssh";
import { registerWebServerHandlers, startWebServerManaged, stopWebServer, readWebServerConfig } from "./ipc/web-server";
import { registerUpdaterHandlers, autoCheckForUpdates } from "./ipc/updater";
import { registerWebHandlers } from "./ipc/web";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  app.quit();
}

// In dev mode, use a separate userData directory so the dev app doesn't
// conflict with a running packaged app (LevelDB locks on localStorage).
if (!app.isPackaged && process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production") {
  app.setPath("userData", path.join(app.getPath("userData"), "dev"));
}

// Ensure Playwright E2E tests do not mutate the user's real application state
if (process.env.TRON_TEST_PROFILE) {
  const fs = require("fs");
  if (!fs.existsSync(process.env.TRON_TEST_PROFILE)) {
    fs.mkdirSync(process.env.TRON_TEST_PROFILE, { recursive: true });
  }
  app.setPath("userData", process.env.TRON_TEST_PROFILE);
}

// Note: do NOT use disable-gpu / disable-software-rasterizer — they force
// Chromium into a very slow CPU-only rendering path. The macOS
// SharedImageManager console warnings are harmless.

// --- Global State ---
let mainWindow: BrowserWindow | null = null;
let forceQuit = false;
let quitPending = false; // true when Cmd+Q / dock quit is waiting for user confirmation
let closeAttempts = 0;
let closeTimeout: ReturnType<typeof setTimeout> | null = null;

// --- Menu Helper ---
const createMenu = (win: BrowserWindow) => {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
        {
          label: app.name,
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
      ] as MenuItemConstructorOptions[])
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
            const { shell } = await import("electron");
            await shell.openExternal("https://tronai.dev");
          },
        },
        {
          label: "GitHub",
          click: async () => {
            const { shell } = await import("electron");
            await shell.openExternal("https://github.com/Shadowhusky/Tron");
          },
        },
        {
          label: "Discord",
          click: async () => {
            const { shell } = await import("electron");
            await shell.openExternal("https://discord.gg/EeTCS7A6");
          },
        },
        { type: "separator" },
        {
          label: "Report Issue",
          click: async () => {
            const { shell } = await import("electron");
            await shell.openExternal("https://github.com/Shadowhusky/Tron/issues");
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

// --- Window Creation ---
const createWindow = () => {
  const preloadPath = path.join(__dirname, "preload.js");

  const isMacOS = process.platform === "darwin";

  const shouldHide = process.argv.includes("--hidden");
  mainWindow = new BrowserWindow({
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
        titleBarStyle: "hidden" as const,
        ...(process.platform === "win32"
          ? {
            titleBarOverlay: {
              color: "#0a0a0a",
              symbolColor: "#ffffff",
              height: 40,
            },
            backgroundMaterial: "mica" as const,
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
      if (closeTimeout) clearTimeout(closeTimeout);
      closeTimeout = setTimeout(() => {
        forceQuit = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      }, 5000);
    }
  });

  mainWindow.on("closed", () => {
    cleanupAllSSHSessions();
    cleanupAllSessions();
    mainWindow = null;
  });

  const isDev = !app.isPackaged && process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production";
  const devPort = process.env.PORT || 5173;
  if (isDev) {
    mainWindow.loadURL(`http://localhost:${devPort}`);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist-react/index.html"));
  }
};

// --- Clipboard readers ---
ipcMain.handle("clipboard.readImage", async () => {
  const { clipboard } = await import("electron");
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  const png = image.toPNG();
  return png.toString("base64");
});

// Read file paths from system clipboard (e.g. files copied in Finder/Explorer)
ipcMain.handle("clipboard.readFilePaths", async () => {
  const { clipboard } = await import("electron");
  if (process.platform === "darwin") {
    // macOS: NSFilenamesPboardType is exposed as a property list (XML plist)
    // containing an array of file path strings.
    try {
      const raw = clipboard.read("NSFilenamesPboardType");
      if (raw) {
        // Parse plist XML — extract <string> values
        const paths = Array.from(raw.matchAll(/<string>([^<]+)<\/string>/g), m => m[1]);
        if (paths.length > 0) return paths;
      }
    } catch { /* not available */ }
    // Fallback: public.file-url
    try {
      const fileUrl = clipboard.read("public.file-url");
      if (fileUrl) {
        const decoded = decodeURIComponent(fileUrl.replace(/^file:\/\//, ""));
        if (decoded) return [decoded];
      }
    } catch { /* not available */ }
  } else if (process.platform === "win32") {
    // Windows: CF_HDROP exposed via FileNameW
    try {
      const buf = clipboard.readBuffer("FileNameW");
      if (buf && buf.length > 0) {
        const decoded = buf.toString("ucs2").replace(/\0+$/, "");
        if (decoded) return [decoded];
      }
    } catch { /* not available */ }
  }
  return null;
});

// --- Register all IPC handlers ---
registerTerminalHandlers(() => mainWindow);
registerSSHHandlers(() => mainWindow, getSessions, getSessionHistory);
registerSystemHandlers();
registerAIHandlers();
registerConfigHandlers();
registerWebServerHandlers();
registerWebHandlers();
registerUpdaterHandlers(() => mainWindow, () => { forceQuit = true; });

// --- Window close response from renderer ---
ipcMain.on("window.closeConfirmed", () => {
  if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
  closeAttempts = 0;
  // Flush all terminal history to disk immediately before closing.
  // This ensures the latest PTY output is persisted even if the window
  // close + cleanup sequence has timing issues.
  persistAllHistory();
  forceQuit = true;
  if (quitPending) {
    // Cmd+Q / dock quit — quit the entire app (not just close the window)
    quitPending = false;
    app.quit();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

ipcMain.on("window.closeCancelled", () => {
  if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
  closeAttempts = 0;
  quitPending = false;
});

// Update Windows title bar overlay colors when theme changes
ipcMain.on("window.themeChanged", (_, resolvedTheme: string) => {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
  const isLight = resolvedTheme === "light";
  mainWindow.setTitleBarOverlay({
    color: isLight ? "#f3f4f6" : "#0a0a0a",
    symbolColor: isLight ? "#111827" : "#ffffff",
  });
});

// --- App lifecycle ---
app.whenReady().then(async () => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Auto-start integrated web server (auto-restarts on crash with backoff)
  const wsConfig = readWebServerConfig();
  if (wsConfig.enabled) {
    const result = await startWebServerManaged(wsConfig.port);
    if (!result.success) {
      console.error(`[Tron] Web server initial start failed (will retry): ${result.error}`);
    }
  }

  // Auto-check for updates (deferred — does not block launch)
  {
    let autoUpdate = true;
    try {
      const fs = require("fs");
      const cfgPath = path.join(app.getPath("userData"), "tron.config.json");
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        if (raw?.autoUpdate === false) autoUpdate = false;
      }
    } catch { /* use default */ }
    autoCheckForUpdates(autoUpdate, () => mainWindow);
  }
});

app.on("window-all-closed", () => {
  cleanupAllSessions();
  stopWebServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (e) => {
  if (forceQuit) {
    // Already confirmed or force-closing — proceed with cleanup
    cleanupAllSSHSessions();
    cleanupAllSessions();
    stopWebServer();
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
    if (closeTimeout) clearTimeout(closeTimeout);
    closeTimeout = setTimeout(() => {
      forceQuit = true;
      quitPending = false;
      app.quit();
    }, 5000);
  }
});
