import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  shell,
} from "electron";
import fs from "fs";
import path from "path";
import * as pty from "node-pty";
import os from "os";
import { randomUUID } from "crypto";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  app.quit();
}

// --- Global State ---
let mainWindow: BrowserWindow | null = null;
const sessions = new Map<string, pty.IPty>();
const sessionHistory = new Map<string, string>();

// --- Menu Helper ---
const createMenu = (win: BrowserWindow) => {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => {
            win.webContents.send("menu.createTab");
          },
        },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            win.webContents.send("menu.closeTab");
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Learn More",
          click: async () => {
            const { shell } = await import("electron");
            await shell.openExternal("https://electronjs.org");
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

// --- Window Creation ---
const createWindow = () => {
  const preloadPath = path.join(__dirname, "preload.js");
  console.log("Preload Path:", preloadPath);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
  });

  createMenu(mainWindow);

  const isDev = !app.isPackaged;
  const devPort = process.env.PORT || 5173;
  if (isDev) {
    mainWindow.loadURL(`http://localhost:${devPort}`);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist-react/index.html"));
  }
};

// --- IPC Handlers ---
const initializeIpcHandlers = () => {
  // Create Session
  ipcMain.handle("terminal.create", (event, { cols, rows, cwd }) => {
    const shell = os.platform() === "win32" ? "powershell.exe" : "/bin/zsh";
    const sessionId = randomUUID();

    try {
      const ptyProcess = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: cols || 80,
        rows: rows || 30,
        cwd: cwd || process.env.HOME,
        env: process.env,
      });

      sessionHistory.set(sessionId, "");

      ptyProcess.onData((data) => {
        const currentHistory = sessionHistory.get(sessionId) || "";
        if (currentHistory.length < 100000) {
          sessionHistory.set(sessionId, currentHistory + data);
        } else {
          sessionHistory.set(sessionId, currentHistory.slice(-80000) + data);
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("terminal.incomingData", {
            id: sessionId,
            data,
          });
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("terminal.exit", {
            id: sessionId,
            exitCode,
          });
        }
        sessions.delete(sessionId);
        sessionHistory.delete(sessionId);
      });

      sessions.set(sessionId, ptyProcess);
      return sessionId;
    } catch (e) {
      console.error("Failed to create PTY session:", e);
      throw e;
    }
  });

  // Terminal Input/Output/Resize
  ipcMain.on("terminal.write", (event, { id, data }) => {
    const session = sessions.get(id);
    if (session) session.write(data);
  });

  ipcMain.on("terminal.resize", (event, { id, cols, rows }) => {
    const session = sessions.get(id);
    if (session) session.resize(cols, rows);
  });

  ipcMain.on("terminal.close", (event, id) => {
    const session = sessions.get(id);
    if (session) {
      session.kill();
      sessions.delete(id);
      sessionHistory.delete(id);
    }
  });

  ipcMain.handle("terminal.checkCommand", async (event, command) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    try {
      const checkCmd =
        os.platform() === "win32" ? `where ${command}` : `which ${command}`;
      await execAsync(checkCmd);
      return true;
    } catch (e) {
      return false;
    }
  });

  // Agent Execution
  ipcMain.handle(
    "terminal.exec",
    async (
      event,
      { sessionId, command }: { sessionId: string; command: string },
    ) => {
      const session = sessions.get(sessionId);
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      let cwd = process.env.HOME || "/";
      if (session) {
        try {
          const pid = session.pid;
          if (os.platform() === "darwin") {
            // Try to get CWD of the process
            const { stdout } = await execAsync(
              `lsof -p ${pid} | grep cwd | awk '{print $9}'`,
            );
            if (stdout.trim()) cwd = stdout.trim();
          } else if (os.platform() === "linux") {
            const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
            if (stdout.trim()) cwd = stdout.trim();
          }
        } catch (e) {
          console.error("Error fetching CWD:", e);
        }
      }

      try {
        const { stdout, stderr } = await execAsync(command, { cwd });
        return { stdout, stderr, exitCode: 0 };
      } catch (e: any) {
        return { stdout: "", stderr: e.message, exitCode: e.code || 1 };
      }
    },
  );

  // Get CWD
  ipcMain.handle("terminal.getCwd", async (event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const pid = session.pid;
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      if (os.platform() === "darwin") {
        const { stdout: lsofOut } = await execAsync(
          `lsof -p ${pid} | grep cwd | awk '{print $NF}' `,
        );
        return lsofOut.trim() || null;
      } else if (os.platform() === "linux") {
        const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
        return stdout.trim() || null;
      }
      return null;
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle(
    "terminal.getCompletions",
    async (
      event,
      {
        prefix,
        cwd,
        sessionId,
      }: { prefix: string; cwd?: string; sessionId?: string },
    ) => {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      // Resolve CWD from session if available
      let workDir = cwd || process.env.HOME || "/";
      if (!cwd && sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          try {
            const pid = session.pid;
            if (os.platform() === "darwin") {
              const { stdout } = await execAsync(
                `lsof -p ${pid} | grep cwd | awk '{print $NF}'`,
              );
              if (stdout.trim()) workDir = stdout.trim();
            }
          } catch {}
        }
      }

      try {
        const parts = prefix.trim().split(/\s+/);

        if (parts.length <= 1) {
          // Command name completion: commands + aliases + builtins + functions
          const word = parts[0] || "";
          const { stdout } = await execAsync(
            `bash -c 'compgen -abck "${word}" 2>/dev/null | sort -u | head -30'`,
            { cwd: workDir },
          );
          const results = stdout.trim().split("\n").filter(Boolean);
          return [...new Set(results)]
            .sort((a, b) => a.length - b.length)
            .slice(0, 15);
        }

        // Argument completion: files + directories
        const lastWord = parts[parts.length - 1];
        const { stdout } = await execAsync(
          `bash -c 'compgen -df "${lastWord}" 2>/dev/null | head -30'`,
          { cwd: workDir },
        );
        const results = stdout.trim().split("\n").filter(Boolean);
        return [...new Set(results)]
          .sort((a, b) => a.length - b.length)
          .slice(0, 15);
      } catch (e) {
        return [];
      }
    },
  );

  ipcMain.handle("terminal.getHistory", (event, sessionId: string) => {
    return sessionHistory.get(sessionId) || "";
  });

  // System Handlers
  ipcMain.handle("system.fixPermissions", async () => {
    if (process.platform !== "darwin") return true;

    // 1. Recursive chmod for node-pty binaries
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
      // 1. Try reading TimeMachine plist (System-wide check)
      await fs.promises.access(
        "/Library/Preferences/com.apple.TimeMachine.plist",
        fs.constants.R_OK,
      );
      return true;
    } catch (error) {
      console.log("FDA Check 1 (TimeMachine) failed:", (error as any).code);

      try {
        // 2. Try listing user's Safari directory (User-specific check)
        // This directory usually requires FDA to list
        const safariPath = path.join(os.homedir(), "Library/Safari");
        await fs.promises.readdir(safariPath);
        return true;
      } catch (e2) {
        console.log("FDA Check 2 (Safari) failed:", (e2 as any).code);
        return false;
      }
    }
  });

  ipcMain.handle("system.openPrivacySettings", async () => {
    if (process.platform !== "darwin") return;

    const { exec } = await import("child_process");

    // Ventura/Sonoma specific URL scheme via open command often works better than shell.openExternal for system panes
    // We try multiple approaches to ensure it opens
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

  ipcMain.handle(
    "ai.testConnection",
    async (event, { provider, model, apiKey }) => {
      try {
        // Simple fetch proxy to avoid CORS and keep secrets (somewhat) contained
        // 1. Ollama
        if (provider === "ollama") {
          const response = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: model || "llama3",
              prompt: "hi",
              stream: false,
            }),
          });
          return response.ok;
        }

        // 2. OpenAI
        if (provider === "openai") {
          const response = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: model || "gpt-3.5-turbo",
                messages: [{ role: "user", content: "hi" }],
                max_tokens: 5,
              }),
            },
          );
          return response.ok;
        }

        // 3. Anthropic
        if (provider === "anthropic") {
          const response = await fetch(
            "https://api.anthropic.com/v1/messages",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: model || "claude-3-opus-20240229",
                messages: [{ role: "user", content: "hi" }],
                max_tokens: 5,
              }),
            },
          );
          return response.ok;
        }

        return false;
      } catch (e) {
        console.error("AI Connection Test Failed:", e);
        return false;
      }
    },
  );
};

initializeIpcHandlers();

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
