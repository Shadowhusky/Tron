"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUpdaterHandlers = registerUpdaterHandlers;
exports.autoCheckForUpdates = autoCheckForUpdates;
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
let updateStatus = "idle";
let updateInfo = null;
let downloadProgress = null;
let lastError = null;
function sendToRenderer(getMainWindow, channel, data) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
    }
}
function registerUpdaterHandlers(getMainWindow) {
    // Configure autoUpdater
    electron_updater_1.autoUpdater.autoDownload = false;
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = true;
    // --- Event wiring ---
    electron_updater_1.autoUpdater.on("checking-for-update", () => {
        updateStatus = "checking";
        sendToRenderer(getMainWindow, "updater.status", { status: updateStatus });
    });
    electron_updater_1.autoUpdater.on("update-available", (info) => {
        updateStatus = "available";
        updateInfo = info;
        sendToRenderer(getMainWindow, "updater.status", {
            status: updateStatus,
            updateInfo: { version: info.version, releaseNotes: info.releaseNotes },
        });
    });
    electron_updater_1.autoUpdater.on("update-not-available", () => {
        updateStatus = "not-available";
        sendToRenderer(getMainWindow, "updater.status", { status: updateStatus });
    });
    electron_updater_1.autoUpdater.on("download-progress", (progress) => {
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
    electron_updater_1.autoUpdater.on("error", (err) => {
        updateStatus = "error";
        lastError = err?.message || String(err);
        sendToRenderer(getMainWindow, "updater.status", {
            status: updateStatus,
            lastError,
        });
    });
    electron_updater_1.autoUpdater.on("update-downloaded", (info) => {
        updateStatus = "downloaded";
        updateInfo = info;
        sendToRenderer(getMainWindow, "updater.status", {
            status: updateStatus,
            updateInfo: { version: info.version, releaseNotes: info.releaseNotes },
        });
    });
    // --- IPC handlers ---
    electron_1.ipcMain.handle("updater.checkForUpdates", async () => {
        await electron_updater_1.autoUpdater.checkForUpdates();
    });
    electron_1.ipcMain.handle("updater.downloadUpdate", async () => {
        await electron_updater_1.autoUpdater.downloadUpdate();
    });
    electron_1.ipcMain.handle("updater.quitAndInstall", () => {
        electron_updater_1.autoUpdater.quitAndInstall();
    });
    electron_1.ipcMain.handle("updater.getStatus", () => ({
        status: updateStatus,
        updateInfo: updateInfo
            ? { version: updateInfo.version, releaseNotes: updateInfo.releaseNotes }
            : null,
        downloadProgress,
        lastError,
    }));
    electron_1.ipcMain.handle("updater.getVersion", () => electron_1.app.getVersion());
}
/** Check for updates on startup (delayed 5s). Only runs when packaged. */
function autoCheckForUpdates(autoDownload) {
    if (!electron_1.app.isPackaged)
        return;
    electron_updater_1.autoUpdater.autoDownload = autoDownload;
    setTimeout(() => {
        electron_updater_1.autoUpdater.checkForUpdates().catch(() => {
            // Silently ignore startup check errors (e.g. no internet)
        });
    }, 5000);
}
//# sourceMappingURL=updater.js.map