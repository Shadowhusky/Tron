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
/**
 * Normalize electron-updater's polymorphic `releaseNotes` into an HTML
 * string. The shape is:
 *   - string (HTML or plain text) — pass through.
 *   - Array<{version, note}>     — concatenate notes with version headers.
 *   - undefined / null           — return empty.
 *
 * latest.yml from electron-builder doesn't always include notes. We rely on
 * `fetchReleaseNotesFromGitHub` as a fallback when this returns "".
 */
function normalizeReleaseNotes(raw) {
    if (!raw)
        return "";
    if (typeof raw === "string")
        return raw.trim();
    if (Array.isArray(raw)) {
        return raw
            .map((entry) => {
            if (!entry)
                return "";
            if (typeof entry === "string")
                return entry;
            const v = entry.version;
            const n = entry.note;
            if (!n)
                return "";
            return v ? `<h4>v${v}</h4>${n}` : String(n);
        })
            .filter(Boolean)
            .join("\n");
    }
    return "";
}
/** Fetch the GitHub release body for a tag — fallback when electron-updater
 *  doesn't have notes. Markdown body becomes the modal content (rendered as
 *  text since the main process doesn't ship a markdown parser). */
async function fetchReleaseNotesFromGitHub(version) {
    try {
        const tag = `v${version}`;
        const res = await fetch(`https://api.github.com/repos/Shadowhusky/Tron/releases/tags/${tag}`, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok)
            return "";
        const data = (await res.json());
        const body = (data?.body || "").trim();
        if (!body)
            return "";
        // Convert minimal Markdown → HTML so the renderer's
        // dangerouslySetInnerHTML produces something readable. Headings, lists,
        // bold, inline code, and links are the common shapes Anthropic-style
        // release notes use; full Markdown rendering is overkill here.
        const escapeHtml = (s) => s
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        let html = escapeHtml(body);
        html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
        html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
        html = html.replace(/^# (.+)$/gm, "<h3>$1</h3>");
        html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
        html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
        html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
        html = html.replace(/\n\n+/g, "<br/><br/>");
        return html;
    }
    catch {
        return "";
    }
}
async function captureReleaseNotes(rawNotes, version) {
    const normalized = normalizeReleaseNotes(rawNotes);
    if (normalized)
        return normalized;
    return await fetchReleaseNotesFromGitHub(version);
}
function wireEvents(autoUpdater, getMainWindow) {
    autoUpdater.on("checking-for-update", () => {
        updateStatus = "checking";
        sendToRenderer(getMainWindow, "updater.status", { status: updateStatus });
    });
    autoUpdater.on("update-available", async (info) => {
        updateStatus = "available";
        const notes = await captureReleaseNotes(info.releaseNotes, info.version);
        updateInfo = { version: info.version, releaseNotes: notes };
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
    autoUpdater.on("update-downloaded", async (info) => {
        updateStatus = "downloaded";
        // Prefer the notes captured during update-available (already populated,
        // including GitHub fallback). Re-capture only if that pass produced
        // nothing — covers the edge case where update-available didn't fire
        // (cached check-for-update result).
        const existing = updateInfo?.version === info.version ? updateInfo.releaseNotes : "";
        const notes = existing || (await captureReleaseNotes(info.releaseNotes, info.version));
        updateInfo = { version: info.version, releaseNotes: notes };
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
    const sendStep = (step) => {
        updateStatus = "installing";
        sendToRenderer(getMainWindow, "updater.status", { status: "installing", updateInfo, installStep: step });
    };
    // Locate the pending update zip
    sendStep("Locating update...");
    // electron-updater downloads to ~/Library/Caches/<app-name>-updater/pending/
    const cacheDir = (0, node_path_1.join)(electron_1.app.getPath("home"), "Library", "Caches", "tron-updater", "pending");
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
    // Extract to a temp directory using ditto (preserves macOS attrs + code signing)
    sendStep("Extracting update...");
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
    sendStep("Applying update...");
    (0, node_fs_1.rmSync)(appBundlePath, { recursive: true, force: true });
    await execFileAsync("mv", [newAppPath, appBundlePath]);
    // Clean up temp dir (ignore errors)
    sendStep("Cleaning up...");
    try {
        (0, node_fs_1.rmSync)(extractDir, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
    sendStep("Restarting...");
    console.log("[Updater] macOS update applied successfully");
}
function registerUpdaterHandlers(getMainWindow, setForceQuit) {
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
        // Mark forceQuit FIRST so the close interceptor doesn't block app.quit()
        setForceQuit?.();
        const au = await getAutoUpdater(getMainWindow);
        // Safety net: if nothing exits the app within 30s, force-kill.
        setTimeout(() => {
            console.error("[Updater] Safety timeout — forcing app.exit(0)");
            electron_1.app.exit(0);
        }, 30000);
        // Use electron-updater's built-in quitAndInstall.
        // isSilent=false (show installer), isForceRunAfter=true (relaunch after install).
        // electron-updater handles extraction and replacement natively.
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
function autoCheckForUpdates(_autoDownload, getMainWindow) {
    if (!electron_1.app.isPackaged)
        return;
    const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
    const doCheck = async () => {
        try {
            const au = await getAutoUpdater(getMainWindow);
            // Never auto-download — only notify. User must click "Update Now".
            au.autoDownload = false;
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