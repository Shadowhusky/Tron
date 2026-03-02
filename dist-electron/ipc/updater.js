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
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUpdaterHandlers = registerUpdaterHandlers;
exports.autoCheckForUpdates = autoCheckForUpdates;
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
let updateStatus = "idle";
let updateInfo = null;
let downloadProgress = null;
let lastError = null;
// Lazy-loaded autoUpdater — avoids blocking app startup with the heavy
// electron-updater module. Resolved on first use (IPC call or auto-check).
let _autoUpdater = null;
let _initPromise = null;
function getAutoUpdater(getMainWindow) {
    if (_autoUpdater)
        return Promise.resolve(_autoUpdater);
    if (_initPromise)
        return _initPromise;
    _initPromise = Promise.resolve().then(() => __importStar(require("electron-updater"))).then(({ autoUpdater }) => {
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
function sendToRenderer(getMainWindow, channel, data) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
    }
}
function wireEvents(autoUpdater, getMainWindow) {
    autoUpdater.on("checking-for-update", () => {
        updateStatus = "checking";
        sendToRenderer(getMainWindow, "updater.status", { status: updateStatus });
    });
    autoUpdater.on("update-available", (info) => {
        updateStatus = "available";
        updateInfo = { version: info.version, releaseNotes: info.releaseNotes };
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
        updateInfo = { version: info.version, releaseNotes: info.releaseNotes };
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
async function applyMacUpdate(getMainWindow) {
    // Locate the pending update zip
    const cacheDir = (0, node_path_1.join)(electron_1.app.getPath("userData"), "..", "Caches", "tron-updater", "pending");
    if (!(0, node_fs_1.existsSync)(cacheDir)) {
        throw new Error(`Cache dir not found: ${cacheDir}`);
    }
    const zips = (0, node_fs_1.readdirSync)(cacheDir).filter((f) => f.endsWith(".zip"));
    if (zips.length === 0) {
        throw new Error("No update zip found in pending directory");
    }
    const zipPath = (0, node_path_1.join)(cacheDir, zips[0]);
    // Resolve the .app bundle path from the running executable
    // exe is e.g. /Applications/Tron.app/Contents/MacOS/Tron
    const exePath = electron_1.app.getPath("exe");
    const appBundlePath = (0, node_path_1.dirname)((0, node_path_1.dirname)((0, node_path_1.dirname)(exePath))); // -> /Applications/Tron.app
    if (!appBundlePath.endsWith(".app")) {
        throw new Error(`Unexpected app path: ${appBundlePath}`);
    }
    // Notify renderer that we're extracting (can take a few seconds for ~140MB zip)
    updateStatus = "installing";
    sendToRenderer(getMainWindow, "updater.status", { status: updateStatus, updateInfo });
    // Extract to a temp directory using ditto (preserves macOS attrs + code signing)
    const extractDir = (0, node_path_1.join)((0, node_os_1.tmpdir)(), `tron-update-${Date.now()}`);
    await execFileAsync("ditto", ["-xk", zipPath, extractDir]);
    // Find the .app inside the extracted dir (should be Tron.app)
    const extracted = (0, node_fs_1.readdirSync)(extractDir).filter((f) => f.endsWith(".app"));
    if (extracted.length === 0) {
        (0, node_fs_1.rmSync)(extractDir, { recursive: true, force: true });
        throw new Error("No .app bundle found in extracted zip");
    }
    const newAppPath = (0, node_path_1.join)(extractDir, extracted[0]);
    // Replace: remove old bundle, move new one in place
    (0, node_fs_1.rmSync)(appBundlePath, { recursive: true, force: true });
    await execFileAsync("mv", [newAppPath, appBundlePath]);
    // Clean up temp dir (ignore errors)
    try {
        (0, node_fs_1.rmSync)(extractDir, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
    console.log("[Updater] macOS update applied successfully");
}
function registerUpdaterHandlers(getMainWindow) {
    // IPC handlers — lazy-load electron-updater on first call
    electron_1.ipcMain.handle("updater.checkForUpdates", async () => {
        const au = await getAutoUpdater(getMainWindow);
        await au.checkForUpdates();
    });
    electron_1.ipcMain.handle("updater.downloadUpdate", async () => {
        const au = await getAutoUpdater(getMainWindow);
        await au.downloadUpdate();
    });
    electron_1.ipcMain.handle("updater.quitAndInstall", async () => {
        const au = await getAutoUpdater(getMainWindow);
        // On macOS, electron-updater's default quitAndInstall can race — the app
        // relaunches before the zip extraction/replacement finishes, so the old
        // binary runs again. Fix: extract the update ourselves BEFORE quitting,
        // then relaunch. This guarantees the new binary is in place on restart.
        if (process.platform === "darwin") {
            try {
                await applyMacUpdate(getMainWindow);
                electron_1.app.relaunch();
                electron_1.app.exit(0);
                return;
            }
            catch (err) {
                // Fall through to default quitAndInstall if manual apply fails
                console.error("[Updater] Manual apply failed, falling back:", err);
            }
        }
        au.quitAndInstall(false, true);
    });
    electron_1.ipcMain.handle("updater.getStatus", () => ({
        status: updateStatus,
        updateInfo,
        downloadProgress,
        lastError,
    }));
    electron_1.ipcMain.handle("updater.getVersion", () => electron_1.app.getVersion());
}
/** Check for updates after app is idle, then periodically. Only runs when packaged. */
function autoCheckForUpdates(autoDownload, getMainWindow) {
    if (!electron_1.app.isPackaged)
        return;
    const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
    const doCheck = async () => {
        try {
            const au = await getAutoUpdater(getMainWindow);
            au.autoDownload = autoDownload;
            // Skip if already downloaded — no need to re-check
            if (updateStatus === "downloaded" || updateStatus === "downloading")
                return;
            await au.checkForUpdates();
        }
        catch {
            // Silently ignore check errors (e.g. no internet)
        }
    };
    // Defer first check until app is idle (10s after launch)
    setTimeout(() => {
        doCheck();
        // Re-check periodically (every 4 hours)
        setInterval(doCheck, CHECK_INTERVAL);
    }, 10000);
}
//# sourceMappingURL=updater.js.map