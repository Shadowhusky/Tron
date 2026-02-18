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
}
//# sourceMappingURL=system.js.map