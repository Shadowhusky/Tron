import { ipcMain, type BrowserWindow } from "electron";
import { CliAgentManager } from "./cliAgentCore";

const manager = new CliAgentManager();

export function registerCliAgentHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle("cliAgent.detect", () => manager.detect());
  ipcMain.handle("cliAgent.start", (_event, data) =>
    manager.start(data, (ev) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send("cliAgent.event", ev);
    }),
  );
  ipcMain.handle("cliAgent.respond", (_event, data) => manager.respond(data));
  ipcMain.handle("cliAgent.stop", (_event, runId) => manager.stop(runId));
  ipcMain.handle("cliAgent.complete", (_event, data) => manager.complete(data));
}

export function cleanupAllCliAgentRuns() {
  manager.stopAll();
}
