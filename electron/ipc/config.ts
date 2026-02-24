import { ipcMain, app } from "electron";
import fs from "fs";
import path from "path";

const CONFIG_FILE = "tron.config.json";
const SESSIONS_FILE = "tron.sessions.json";

function getConfigPath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

function getSessionsPath(): string {
  return path.join(app.getPath("userData"), SESSIONS_FILE);
}

export function registerConfigHandlers() {
  // --- App Config ---
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

  // --- Agent Session State ---
  ipcMain.handle("sessions.read", async () => {
    try {
      const sessionsPath = getSessionsPath();
      if (!fs.existsSync(sessionsPath)) return null;
      const raw = fs.readFileSync(sessionsPath, "utf-8");
      return JSON.parse(raw);
    } catch (e) {
      console.error("Failed to read sessions:", e);
      return null;
    }
  });

  ipcMain.handle("sessions.write", async (_event, data: Record<string, unknown>) => {
    try {
      const sessionsPath = getSessionsPath();
      // Merge top-level keys (allows multiple contexts to coexist: _layout, _agent, etc.)
      let existing: Record<string, unknown> = {};
      try {
        if (fs.existsSync(sessionsPath)) {
          existing = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
        }
      } catch { /* start fresh if corrupt */ }
      fs.writeFileSync(sessionsPath, JSON.stringify({ ...existing, ...data }, null, 2), "utf-8");
      return true;
    } catch (e) {
      console.error("Failed to write sessions:", e);
      return false;
    }
  });
  // --- Saved Tabs (cross-device snapshots) ---
  const getSavedTabsPath = (): string => {
    const dir = path.join(app.getPath("userData"), "saved-tabs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "saved-tabs.json");
  };

  ipcMain.handle("savedTabs.read", async () => {
    try {
      const filePath = getSavedTabsPath();
      if (!fs.existsSync(filePath)) return [];
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch { return []; }
  });

  ipcMain.handle("savedTabs.write", async (_event, data: any[]) => {
    try {
      fs.writeFileSync(getSavedTabsPath(), JSON.stringify(data, null, 2), "utf-8");
      return true;
    } catch { return false; }
  });

  // --- System Paths ---
  ipcMain.handle("config.getSystemPaths", async () => {
    return {
      home: app.getPath("home"),
      desktop: app.getPath("desktop"),
      documents: app.getPath("documents"),
      downloads: app.getPath("downloads"),
      temp: app.getPath("temp"),
    };
  });
}
