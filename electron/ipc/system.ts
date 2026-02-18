import { ipcMain, dialog, BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import os from "os";

export function registerSystemHandlers() {
  ipcMain.handle("system.fixPermissions", async () => {
    if (process.platform !== "darwin") return true;

    const nodePtyPath = path.join(__dirname, "../../node_modules/node-pty");
    const fixCommand = `chmod -R +x "${nodePtyPath}"`;

    try {
      await new Promise<void>((resolve, reject) => {
        require("child_process").exec(fixCommand, (error: any) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return true;
    } catch (error) {
      console.error("Failed to fix permissions:", error);
      return false;
    }
  });

  ipcMain.handle("system.checkPermissions", async () => {
    if (process.platform !== "darwin") return true;

    try {
      await fs.promises.access(
        "/Library/Preferences/com.apple.TimeMachine.plist",
        fs.constants.R_OK,
      );
      return true;
    } catch (error) {
      console.log("FDA Check 1 (TimeMachine) failed:", (error as any).code);

      try {
        const safariPath = path.join(os.homedir(), "Library/Safari");
        await fs.promises.readdir(safariPath);
        return true;
      } catch (e2) {
        console.log("FDA Check 2 (Safari) failed:", (e2 as any).code);
        return false;
      }
    }
  });

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

  ipcMain.handle("system.openPrivacySettings", async () => {
    if (process.platform !== "darwin") return;

    const { exec } = await import("child_process");

    const commands = [
      'open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"',
      'open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"',
    ];

    for (const cmd of commands) {
      exec(cmd, (error) => {
        if (error) console.error("Failed to open settings via:", cmd, error);
      });
    }
  });
}
