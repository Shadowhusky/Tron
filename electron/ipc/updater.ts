import { ipcMain, app, BrowserWindow } from "electron";

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

interface UpdateInfoLite {
  version: string;
  releaseNotes?: string;
}

let updateStatus: UpdateStatus = "idle";
let updateInfo: UpdateInfoLite | null = null;
let downloadProgress: DownloadProgress | null = null;
let lastError: string | null = null;

// Lazy-loaded autoUpdater — avoids blocking app startup with the heavy
// electron-updater module. Resolved on first use (IPC call or auto-check).
let _autoUpdater: typeof import("electron-updater").autoUpdater | null = null;
let _initPromise: Promise<typeof import("electron-updater").autoUpdater> | null = null;

function getAutoUpdater(
  getMainWindow?: () => BrowserWindow | null,
): Promise<typeof import("electron-updater").autoUpdater> {
  if (_autoUpdater) return Promise.resolve(_autoUpdater);
  if (_initPromise) return _initPromise;

  _initPromise = import("electron-updater").then(({ autoUpdater }) => {
    _autoUpdater = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    // Wire events (only once)
    if (getMainWindow) {
      wireEvents(autoUpdater, getMainWindow);
    }

    return autoUpdater;
  });

  return _initPromise;
}

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

function wireEvents(
  autoUpdater: typeof import("electron-updater").autoUpdater,
  getMainWindow: () => BrowserWindow | null,
) {
  autoUpdater.on("checking-for-update", () => {
    updateStatus = "checking";
    sendToRenderer(getMainWindow, "updater.status", { status: updateStatus });
  });

  autoUpdater.on("update-available", (info) => {
    updateStatus = "available";
    updateInfo = { version: info.version, releaseNotes: info.releaseNotes as string | undefined };
    sendToRenderer(getMainWindow, "updater.status", {
      status: updateStatus,
      updateInfo,
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

  autoUpdater.on("update-downloaded", (info) => {
    updateStatus = "downloaded";
    updateInfo = { version: info.version, releaseNotes: info.releaseNotes as string | undefined };
    sendToRenderer(getMainWindow, "updater.status", {
      status: updateStatus,
      updateInfo,
    });
  });
}

export function registerUpdaterHandlers(
  getMainWindow: () => BrowserWindow | null,
) {
  // IPC handlers — lazy-load electron-updater on first call
  ipcMain.handle("updater.checkForUpdates", async () => {
    const au = await getAutoUpdater(getMainWindow);
    await au.checkForUpdates();
  });

  ipcMain.handle("updater.downloadUpdate", async () => {
    const au = await getAutoUpdater(getMainWindow);
    await au.downloadUpdate();
  });

  ipcMain.handle("updater.quitAndInstall", async () => {
    const au = await getAutoUpdater(getMainWindow);
    au.quitAndInstall();
  });

  ipcMain.handle("updater.getStatus", () => ({
    status: updateStatus,
    updateInfo,
    downloadProgress,
    lastError,
  }));

  ipcMain.handle("updater.getVersion", () => app.getVersion());
}

/** Check for updates after app is idle, then periodically. Only runs when packaged. */
export function autoCheckForUpdates(
  autoDownload: boolean,
  getMainWindow: () => BrowserWindow | null,
) {
  if (!app.isPackaged) return;

  const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

  const doCheck = async () => {
    try {
      const au = await getAutoUpdater(getMainWindow);
      au.autoDownload = autoDownload;
      // Skip if already downloaded — no need to re-check
      if (updateStatus === "downloaded" || updateStatus === "downloading") return;
      await au.checkForUpdates();
    } catch {
      // Silently ignore check errors (e.g. no internet)
    }
  };

  // Defer first check until app is idle (10s after launch)
  setTimeout(() => {
    doCheck();
    // Re-check periodically (every 4 hours)
    setInterval(doCheck, CHECK_INTERVAL);
  }, 10_000);
}
