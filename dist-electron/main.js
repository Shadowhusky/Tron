"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const pty = __importStar(require("node-pty"));
const os_1 = __importDefault(require("os"));
const crypto_1 = require("crypto");
// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    electron_1.app.quit();
}
let mainWindow = null;
// Store multiple PTY sessions: ID -> IPty
const sessions = new Map();
const createWindow = () => {
    // Create the browser window.
    mainWindow = new electron_1.BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        titleBarStyle: 'hiddenInset',
        vibrancy: 'under-window',
        visualEffectState: 'active',
        backgroundColor: '#00000000', // Transparent for vibrancy
    });
    // Check if we are in dev mode
    const isDev = !electron_1.app.isPackaged;
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path_1.default.join(__dirname, '../dist-react/index.html'));
    }
};
// --- IPC Handlers for Multi-Session ---
const sessionHistory = new Map(); // Simple in-memory buffer for restore
const initializeIpcHandlers = () => {
    // Create a new PTY session
    electron_1.ipcMain.handle('terminal.create', (event, { cols, rows, cwd }) => {
        const shell = os_1.default.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh';
        const sessionId = (0, crypto_1.randomUUID)();
        try {
            const ptyProcess = pty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: cols || 80,
                rows: rows || 30,
                cwd: cwd || process.env.HOME,
                env: process.env
            });
            sessionHistory.set(sessionId, ''); // Init history
            // Handle incoming data
            ptyProcess.onData((data) => {
                // Buffer data (limit to ~100KB for performance)
                const currentHistory = sessionHistory.get(sessionId) || '';
                if (currentHistory.length < 100000) {
                    sessionHistory.set(sessionId, currentHistory + data);
                }
                else {
                    // Rotate buffer (keep last 80k)
                    sessionHistory.set(sessionId, currentHistory.slice(-80000) + data);
                }
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('terminal.incomingData', { id: sessionId, data });
                }
            });
            ptyProcess.onExit(({ exitCode, signal }) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('terminal.exit', { id: sessionId, exitCode });
                }
                sessions.delete(sessionId);
                sessionHistory.delete(sessionId);
            });
            sessions.set(sessionId, ptyProcess);
            return sessionId;
        }
        catch (e) {
            console.error('Failed to create PTY session:', e);
            throw e;
        }
    });
    // Write to a specific session
    electron_1.ipcMain.on('terminal.write', (event, { id, data }) => {
        const session = sessions.get(id);
        if (session) {
            session.write(data);
        }
    });
    // Resize a specific session
    electron_1.ipcMain.on('terminal.resize', (event, { id, cols, rows }) => {
        const session = sessions.get(id);
        if (session) {
            session.resize(cols, rows);
        }
    });
    // Close/Kill a session
    electron_1.ipcMain.on('terminal.close', (event, id) => {
        const session = sessions.get(id);
        if (session) {
            session.kill();
            sessions.delete(id);
            sessionHistory.delete(id);
        }
    });
    // Check if command exists
    electron_1.ipcMain.handle('terminal.checkCommand', async (event, command) => {
        const { exec } = await Promise.resolve().then(() => __importStar(require('child_process')));
        const { promisify } = await Promise.resolve().then(() => __importStar(require('util')));
        const execAsync = promisify(exec);
        try {
            const checkCmd = os_1.default.platform() === 'win32' ? `where ${command}` : `which ${command}`;
            await execAsync(checkCmd);
            return true;
        }
        catch (e) {
            return false;
        }
    });
    // Get CWD
    electron_1.ipcMain.handle('terminal.getCwd', async (event, sessionId) => {
        const session = sessions.get(sessionId);
        if (!session)
            return null;
        const pid = session.pid;
        const { exec } = await Promise.resolve().then(() => __importStar(require('child_process')));
        const { promisify } = await Promise.resolve().then(() => __importStar(require('util')));
        const execAsync = promisify(exec);
        try {
            if (os_1.default.platform() === 'darwin') {
                const { stdout } = await execAsync(`lsof -d cwd -Fn -p ${pid} 2>/dev/null | grep '^n' | head -1 | cut -c2-`);
                const cwd = stdout.trim();
                return cwd || null;
            }
            else if (os_1.default.platform() === 'linux') {
                const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
                return stdout.trim() || null;
            }
            return null;
        }
        catch (e) {
            return null;
        }
    });
    // Get completions
    electron_1.ipcMain.handle('terminal.getCompletions', async (event, { prefix, cwd }) => {
        const { exec } = await Promise.resolve().then(() => __importStar(require('child_process')));
        const { promisify } = await Promise.resolve().then(() => __importStar(require('util')));
        const execAsync = promisify(exec);
        const workDir = cwd || process.env.HOME || '/';
        try {
            const parts = prefix.trim().split(/\s+/);
            if (parts.length <= 1) {
                const word = parts[0] || '';
                if (!word)
                    return [];
                const { stdout } = await execAsync(`bash -c 'compgen -c "${word}" 2>/dev/null | head -20'`, { cwd: workDir });
                const results = stdout.trim().split('\n').filter(Boolean);
                return [...new Set(results)].sort((a, b) => a.length - b.length).slice(0, 10);
            }
            else {
                const lastWord = parts[parts.length - 1];
                const { stdout } = await execAsync(`bash -c 'compgen -f "${lastWord}" 2>/dev/null | head -20'`, { cwd: workDir });
                const results = stdout.trim().split('\n').filter(Boolean);
                return results.slice(0, 10);
            }
        }
        catch (e) {
            return [];
        }
    });
    // Get session history (for restore on split)
    electron_1.ipcMain.handle('terminal.getHistory', (event, sessionId) => {
        return sessionHistory.get(sessionId) || '';
    });
};
// Initialize handlers ONCE
initializeIpcHandlers();
electron_1.app.whenReady().then(() => {
    createWindow();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
//# sourceMappingURL=main.js.map