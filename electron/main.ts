import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import * as pty from 'node-pty';
import os from 'os';
import { randomUUID } from 'crypto';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    app.quit();
}

let mainWindow: BrowserWindow | null = null;
// Store multiple PTY sessions: ID -> IPty
const sessions = new Map<string, pty.IPty>();

const createWindow = () => {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        titleBarStyle: 'hiddenInset',
        vibrancy: 'under-window',
        visualEffectState: 'active',
        backgroundColor: '#00000000', // Transparent for vibrancy
    });

    // Check if we are in dev mode
    const isDev = !app.isPackaged;

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist-react/index.html'));
    }
};

// --- IPC Handlers for Multi-Session ---
const sessionHistory = new Map<string, string>(); // Simple in-memory buffer for restore

const initializeIpcHandlers = () => {
    // Create a new PTY session
    ipcMain.handle('terminal.create', (event, { cols, rows, cwd }) => {
        const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh';
        const sessionId = randomUUID();

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
                } else {
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
        } catch (e) {
            console.error('Failed to create PTY session:', e);
            throw e;
        }
    });

    // Write to a specific session
    ipcMain.on('terminal.write', (event, { id, data }) => {
        const session = sessions.get(id);
        if (session) {
            session.write(data);
        }
    });

    // Resize a specific session
    ipcMain.on('terminal.resize', (event, { id, cols, rows }) => {
        const session = sessions.get(id);
        if (session) {
            session.resize(cols, rows);
        }
    });

    // Close/Kill a session
    ipcMain.on('terminal.close', (event, id) => {
        const session = sessions.get(id);
        if (session) {
            session.kill();
            sessions.delete(id);
            sessionHistory.delete(id);
        }
    });

    // Check if command exists
    ipcMain.handle('terminal.checkCommand', async (event, command) => {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        try {
            const checkCmd = os.platform() === 'win32' ? `where ${command}` : `which ${command}`;
            await execAsync(checkCmd);
            return true;
        } catch (e) {
            return false;
        }
    });

});

// Execute command and return output (for Agent Mode)
ipcMain.handle('terminal.exec', async (event, { sessionId, command }: { sessionId: string; command: string }) => {
    const session = sessions.get(sessionId);
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Try to get CWD of the session, fallback to home
    let cwd = process.env.HOME || '/';
    if (session) {
        try {
            const pid = session.pid;
            if (os.platform() === 'darwin') {
                const { stdout } = await execAsync(`lsof -d cwd -Fn -p ${pid} 2>/dev/null | grep '^n' | head -1 | cut -c2-`);
                if (stdout.trim()) cwd = stdout.trim();
            } else if (os.platform() === 'linux') {
                const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
                if (stdout.trim()) cwd = stdout.trim();
            }
        } catch (e) {
            // ignore
        }
    }

    try {
        const { stdout, stderr } = await execAsync(command, { cwd });
        return { stdout, stderr, exitCode: 0 };
    } catch (e: any) {
        return { stdout: '', stderr: e.message, exitCode: e.code || 1 };
    }
});

// Get CWD
ipcMain.handle('terminal.getCwd', async (event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return null;

    const pid = session.pid;
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
        if (os.platform() === 'darwin') {
            const { stdout } = await execAsync(`lsof -d cwd -Fn -p ${pid} 2>/dev/null | grep '^n' | head -1 | cut -c2-`);
            const cwd = stdout.trim();
            return cwd || null;
        } else if (os.platform() === 'linux') {
            const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
            return stdout.trim() || null;
        }
        return null;
    } catch (e) {
        return null;
    }
});

// Get completions
ipcMain.handle('terminal.getCompletions', async (event, { prefix, cwd }: { prefix: string; cwd?: string }) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const workDir = cwd || process.env.HOME || '/';

    try {
        const parts = prefix.trim().split(/\s+/);
        if (parts.length <= 1) {
            const word = parts[0] || '';
            if (!word) return [];
            const { stdout } = await execAsync(`bash -c 'compgen -c "${word}" 2>/dev/null | head -20'`, { cwd: workDir });
            const results = stdout.trim().split('\n').filter(Boolean);
            return [...new Set(results)].sort((a, b) => a.length - b.length).slice(0, 10);
        } else {
            const lastWord = parts[parts.length - 1];
            const { stdout } = await execAsync(`bash -c 'compgen -f "${lastWord}" 2>/dev/null | head -20'`, { cwd: workDir });
            const results = stdout.trim().split('\n').filter(Boolean);
            return results.slice(0, 10);
        }
    } catch (e) {
        return [];
    }
});

// Get session history (for restore on split)
ipcMain.handle('terminal.getHistory', (event, sessionId: string) => {
    return sessionHistory.get(sessionId) || '';
});
};

// Initialize handlers ONCE
initializeIpcHandlers();

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
