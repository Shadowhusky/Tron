"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSystemHandlers = registerSystemHandlers;
const electron_1 = require("electron");
function registerSystemHandlers() {
    electron_1.ipcMain.handle("system.selectFolder", async (_event, defaultPath) => {
        const win = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0];
        if (!win)
            return null;
        const result = await electron_1.dialog.showOpenDialog(win, {
            properties: ["openDirectory"],
            title: "Select Directory",
            ...(defaultPath ? { defaultPath } : {}),
        });
        if (result.canceled || result.filePaths.length === 0)
            return null;
        return result.filePaths[0];
    });
    electron_1.ipcMain.handle("shell.openExternal", async (_event, url) => {
        if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
            await electron_1.shell.openExternal(url);
        }
    });
    electron_1.ipcMain.handle("shell.openPath", async (_event, filePath) => {
        if (typeof filePath === "string" && filePath.startsWith("/")) {
            return await electron_1.shell.openPath(filePath);
        }
        return "Invalid path";
    });
    electron_1.ipcMain.handle("shell.showItemInFolder", (_event, filePath) => {
        if (typeof filePath === "string" && filePath.startsWith("/")) {
            electron_1.shell.showItemInFolder(filePath);
        }
    });
    // Flush localStorage/IndexedDB to disk — ensures data is persisted before window close
    electron_1.ipcMain.handle("system.flushStorage", async (event) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        if (win) {
            await win.webContents.session.flushStorageData();
        }
    });
}
//# sourceMappingURL=system.js.map