import { ipcMain, app, BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
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

/**
 * Manually extract the downloaded update zip and replace the running .app bundle.
 * This avoids the race in electron-updater's default quitAndInstall on macOS
 * where the app relaunches before the zip extraction finishes.
 */
async function applyMacUpdate(
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  // Locate the pending update zip
  const cacheDir = join(app.getPath("userData"), "..", "Caches", "tron-updater", "pending");
  if (!existsSync(cacheDir)) {
    throw new Error(`Cache dir not found: ${cacheDir}`);
  }

  const zips = readdirSync(cacheDir).filter((f) => f.endsWith(".zip"));
  if (zips.length === 0) {
    throw new Error("No update zip found in pending directory");
  }
  const zipPath = join(cacheDir, zips[0]);

  // Resolve the .app bundle path from the running executable
  // exe is e.g. /Applications/Tron.app/Contents/MacOS/Tron
  const exePath = app.getPath("exe");
  const appBundlePath = dirname(dirname(dirname(exePath))); // -> /Applications/Tron.app
  if (!appBundlePath.endsWith(".app")) {
    throw new Error(`Unexpected app path: ${appBundlePath}`);
  }

  // Notify renderer that we're extracting (can take a few seconds for ~140MB zip)
  updateStatus = "installing";
  sendToRenderer(getMainWindow, "updater.status", { status: updateStatus, updateInfo });

  // Extract to a temp directory using ditto (preserves macOS attrs + code signing)
  const extractDir = join(tmpdir(), `tron-update-${Date.now()}`);
  await execFileAsync("ditto", ["-xk", zipPath, extractDir]);

  // Find the .app inside the extracted dir (should be Tron.app)
  const extracted = readdirSync(extractDir).filter((f) => f.endsWith(".app"));
  if (extracted.length === 0) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error("No .app bundle found in extracted zip");
  }
  const newAppPath = join(extractDir, extracted[0]);

  // Replace: remove old bundle, move new one in place
  rmSync(appBundlePath, { recursive: true, force: true });
  await execFileAsync("mv", [newAppPath, appBundlePath]);

  // Clean up temp dir (ignore errors)
  try {
    rmSync(extractDir, { recursive: true, force: true });
  } catch { /* best-effort */ }

  console.log("[Updater] macOS update applied successfully");
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

    // On macOS, electron-updater's default quitAndInstall can race — the app
    // relaunches before the zip extraction/replacement finishes, so the old
    // binary runs again. Fix: extract the update ourselves BEFORE quitting,
    // then relaunch. This guarantees the new binary is in place on restart.
    if (process.platform === "darwin") {
      try {
        await applyMacUpdate(getMainWindow);
        app.relaunch();
        app.exit(0);
        return;
      } catch (err) {
        // Fall through to default quitAndInstall if manual apply fails
        console.error("[Updater] Manual apply failed, falling back:", err);
      }
    }

    au.quitAndInstall(false, true);
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
