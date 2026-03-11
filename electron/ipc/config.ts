import { ipcMain, app } from "electron";
import fs from "fs";
import os from "os";
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
    const sessionsPath = getSessionsPath();
    try {
      if (!fs.existsSync(sessionsPath)) return null;
      const raw = fs.readFileSync(sessionsPath, "utf-8");
      return JSON.parse(raw);
    } catch (e) {
      console.error("Failed to read sessions:", e);
      // If main file is corrupt (e.g. crash mid-write before atomic rename was adopted),
      // try the .tmp file which may contain a valid previous write
      try {
        const tmpPath = sessionsPath + ".tmp";
        if (fs.existsSync(tmpPath)) {
          const raw = fs.readFileSync(tmpPath, "utf-8");
          return JSON.parse(raw);
        }
      } catch { /* both corrupt — give up */ }
      return null;
    }
  });

  /** Shared write logic — atomic tmp+rename */
  function writeSessionsSync(data: Record<string, unknown>): boolean {
    try {
      const sessionsPath = getSessionsPath();
      let existing: Record<string, unknown> = {};
      try {
        if (fs.existsSync(sessionsPath)) {
          existing = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
        }
      } catch { /* start fresh if corrupt */ }
      // Atomic write: write to tmp file then rename, so a crash mid-write
      // never corrupts the sessions file (rename is atomic on most filesystems).
      const tmpPath = sessionsPath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify({ ...existing, ...data }, null, 2), "utf-8");
      fs.renameSync(tmpPath, sessionsPath);
      return true;
    } catch (e) {
      console.error("Failed to write sessions:", e);
      return false;
    }
  }

  ipcMain.handle("sessions.write", async (_event, data: Record<string, unknown>) => {
    return writeSessionsSync(data);
  });

  // Synchronous write — blocks renderer but guarantees data is on disk before returning.
  // Used by the reactive layout save so force-quit can't lose state.
  ipcMain.on("sessions.writeSync", (event, data: Record<string, unknown>) => {
    event.returnValue = writeSessionsSync(data);
  });
  // --- Saved Tabs (cross-device snapshots) ---
  // Use ~/.tron/ (same path as web server) so Electron and web mode share the same file.
  const getSavedTabsPath = (): string => {
    const dir = path.join(os.homedir(), ".tron");
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

  // --- Remote Server Profiles ---
  const getRemoteProfilesPath = (): string => {
    const dir = path.join(app.getPath("userData"), "remote-servers");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "profiles.json");
  };

  ipcMain.handle("remote.profiles.read", async () => {
    try {
      const filePath = getRemoteProfilesPath();
      if (!fs.existsSync(filePath)) return [];
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch { return []; }
  });

  ipcMain.handle("remote.profiles.write", async (_event, profiles: any[]) => {
    try {
      fs.writeFileSync(getRemoteProfilesPath(), JSON.stringify(profiles, null, 2), "utf-8");
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
