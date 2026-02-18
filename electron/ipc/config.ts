import { ipcMain, app } from "electron";
import fs from "fs";
import path from "path";

const CONFIG_FILE = "tron.config.json";

function getConfigPath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

export function registerConfigHandlers() {
  ipcMain.handle("config.read", async () => {
    try {
      const configPath = getConfigPath();
      if (!fs.existsSync(configPath)) return null;
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    } catch (e) {
      console.error("Failed to read config:", e);
      return null;
    }
  });

  ipcMain.handle("config.write", async (_event, data: Record<string, unknown>) => {
    try {
      const configPath = getConfigPath();
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
      return true;
    } catch (e) {
      console.error("Failed to write config:", e);
      return false;
    }
  });
}
