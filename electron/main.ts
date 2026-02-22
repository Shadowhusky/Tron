import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  ipcMain,
} from "electron";
import path from "path";
import { registerTerminalHandlers, cleanupAllSessions, getSessions, getSessionHistory } from "./ipc/terminal";
import { registerSystemHandlers } from "./ipc/system";
import { registerAIHandlers } from "./ipc/ai";
import { registerConfigHandlers } from "./ipc/config";
import { registerSSHHandlers, cleanupAllSSHSessions } from "./ipc/ssh";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  app.quit();
}

// Ensure Playwright E2E tests do not mutate the user's real application state
if (process.env.TRON_TEST_PROFILE) {
  const fs = require("fs");
  if (!fs.existsSync(process.env.TRON_TEST_PROFILE)) {
    fs.mkdirSync(process.env.TRON_TEST_PROFILE, { recursive: true });
  }
  app.setPath("userData", process.env.TRON_TEST_PROFILE);
}

// Suppress Chromium GPU SharedImageManager / mailbox errors on macOS.
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

// --- Global State ---
let mainWindow: BrowserWindow | null = null;
let forceQuit = false;

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
            await shell.openExternal("https://electronjs.org");
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
  console.log("Preload Path:", preloadPath);

  const isMacOS = process.platform === "darwin";

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !process.argv.includes("--hidden"),
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

  // Intercept close to show confirmation in renderer
  mainWindow.on("close", (e) => {
    if (!forceQuit && mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault();
      mainWindow.webContents.send("window.confirmClose");
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

// --- Register all IPC handlers ---
registerTerminalHandlers(() => mainWindow);
registerSSHHandlers(() => mainWindow, getSessions, getSessionHistory);
registerSystemHandlers();
registerAIHandlers();
registerConfigHandlers();

// --- Window close response from renderer ---
ipcMain.on("window.closeConfirmed", () => {
  forceQuit = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

ipcMain.on("window.closeCancelled", () => {
  // No-op — renderer dismissed the modal
});

// --- App lifecycle ---
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  cleanupAllSessions();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  forceQuit = true;
  cleanupAllSSHSessions();
  cleanupAllSessions();
});
