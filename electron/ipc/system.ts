import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import path from "path";

/** Cross-platform absolute path check (Unix / and Windows C:\ or UNC \\). */
function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p);
}

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
    if (typeof url !== "string") return;
    // Trim whitespace/quotes that may wrap the URL
    const trimmed = url.trim().replace(/^["']+|["']+$/g, "");
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return;
    try {
      new URL(trimmed); // validate
      await shell.openExternal(trimmed);
    } catch {
      // Invalid URL — ignore silently
    }
  });

  ipcMain.handle("shell.openPath", async (_event, filePath: string) => {
    if (typeof filePath === "string" && isAbsolutePath(filePath)) {
      return await shell.openPath(filePath);
    }
    return "Invalid path";
  });

  ipcMain.handle("shell.showItemInFolder", (_event, filePath: string) => {
    if (typeof filePath === "string" && isAbsolutePath(filePath)) {
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
