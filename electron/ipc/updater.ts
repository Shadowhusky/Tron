import { ipcMain, app, BrowserWindow } from "electron";
import { autoUpdater, UpdateInfo } from "electron-updater";

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

interface DownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

let updateStatus: UpdateStatus = "idle";
let updateInfo: UpdateInfo | null = null;
let downloadProgress: DownloadProgress | null = null;
let lastError: string | null = null;

function sendToRenderer(
  getMainWindow: () => BrowserWindow | null,
  channel: string,
  data: unknown,
) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

export function registerUpdaterHandlers(
  getMainWindow: () => BrowserWindow | null,
) {
  // Configure autoUpdater
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // --- Event wiring ---
  autoUpdater.on("checking-for-update", () => {
    updateStatus = "checking";
    sendToRenderer(getMainWindow, "updater.status", { status: updateStatus });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    updateStatus = "available";
    updateInfo = info;
    sendToRenderer(getMainWindow, "updater.status", {
      status: updateStatus,
      updateInfo: { version: info.version, releaseNotes: info.releaseNotes },
    });
  });

  autoUpdater.on("update-not-available", () => {
    updateStatus = "not-available";
    sendToRenderer(getMainWindow, "updater.status", { status: updateStatus });
  });

  autoUpdater.on("download-progress", (progress) => {
    updateStatus = "downloading";
    downloadProgress = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    };
    sendToRenderer(getMainWindow, "updater.downloadProgress", downloadProgress);
    sendToRenderer(getMainWindow, "updater.status", {
      status: updateStatus,
      downloadProgress,
    });
  });

  autoUpdater.on("error", (err) => {
    updateStatus = "error";
    lastError = err?.message || String(err);
    sendToRenderer(getMainWindow, "updater.status", {
      status: updateStatus,
      lastError,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    updateStatus = "downloaded";
    updateInfo = info;
    sendToRenderer(getMainWindow, "updater.status", {
      status: updateStatus,
      updateInfo: { version: info.version, releaseNotes: info.releaseNotes },
    });
  });

  // --- IPC handlers ---
  ipcMain.handle("updater.checkForUpdates", async () => {
    await autoUpdater.checkForUpdates();
  });

  ipcMain.handle("updater.downloadUpdate", async () => {
    await autoUpdater.downloadUpdate();
  });

  ipcMain.handle("updater.quitAndInstall", () => {
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle("updater.getStatus", () => ({
    status: updateStatus,
    updateInfo: updateInfo
      ? { version: updateInfo.version, releaseNotes: updateInfo.releaseNotes }
      : null,
    downloadProgress,
    lastError,
  }));

  ipcMain.handle("updater.getVersion", () => app.getVersion());
}

/** Check for updates on startup (delayed 5s). Only runs when packaged. */
export function autoCheckForUpdates(autoDownload: boolean) {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = autoDownload;

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Silently ignore startup check errors (e.g. no internet)
    });
  }, 5000);
}
