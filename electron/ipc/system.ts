import { ipcMain, dialog, shell, BrowserWindow } from "electron";

export function registerSystemHandlers() {
  ipcMain.handle("system.selectFolder", async (_event, defaultPath?: string) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Select Directory",
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("shell.openExternal", async (_event, url: string) => {
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle("shell.openPath", async (_event, filePath: string) => {
    if (typeof filePath === "string" && filePath.startsWith("/")) {
      return await shell.openPath(filePath);
    }
    return "Invalid path";
  });

  ipcMain.handle("shell.showItemInFolder", (_event, filePath: string) => {
    if (typeof filePath === "string" && filePath.startsWith("/")) {
      shell.showItemInFolder(filePath);
    }
  });

  // Flush localStorage/IndexedDB to disk — ensures data is persisted before window close
  ipcMain.handle("system.flushStorage", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      await win.webContents.session.flushStorageData();
    }
  });
}
