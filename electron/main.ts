import { app, BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions } from 'electron';
import path from 'path';
import * as pty from 'node-pty';
import os from 'os';
import { randomUUID } from 'crypto';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    app.quit();
}

// --- Global State ---
let mainWindow: BrowserWindow | null = null;
const sessions = new Map<string, pty.IPty>();
const sessionHistory = new Map<string, string>();

// --- Menu Helper ---
const createMenu = (win: BrowserWindow) => {
    const isMac = process.platform === 'darwin';

    const template: MenuItemConstructorOptions[] = [
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] as MenuItemConstructorOptions[] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Tab',
                    accelerator: 'CmdOrCtrl+T',
                    click: () => {
                        win.webContents.send('menu.createTab');
                    }
                },
                {
                    label: 'Close Tab',
                    accelerator: 'CmdOrCtrl+W',
                    click: () => {
                        win.webContents.send('menu.closeTab');
                    }
                },
                { type: 'separator' },
                { role: 'close' }
            ]
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                {
                    label: 'Learn More',
                    click: async () => {
                        const { shell } = await import('electron');
                        await shell.openExternal('https://electronjs.org');
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
};

// --- Window Creation ---
const createWindow = () => {
    const preloadPath = path.join(__dirname, 'preload.js');
    console.log('Preload Path:', preloadPath);

    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
        },
        titleBarStyle: 'hiddenInset',
        vibrancy: 'under-window',
        visualEffectState: 'active',
        backgroundColor: '#00000000',
    });

    createMenu(mainWindow);

    const isDev = !app.isPackaged;
    const devPort = process.env.PORT || 5173;
    if (isDev) {
        mainWindow.loadURL(`http://localhost:${devPort}`);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist-react/index.html'));
    }
};

// --- IPC Handlers ---
const initializeIpcHandlers = () => {
    // Create Session
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

            sessionHistory.set(sessionId, '');

            ptyProcess.onData((data) => {
                const currentHistory = sessionHistory.get(sessionId) || '';
                if (currentHistory.length < 100000) {
                    sessionHistory.set(sessionId, currentHistory + data);
                } else {
                    sessionHistory.set(sessionId, currentHistory.slice(-80000) + data);
                }

                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('terminal.incomingData', { id: sessionId, data });
                }
            });

            ptyProcess.onExit(({ exitCode }) => {
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

    // Terminal Input/Output/Resize
    ipcMain.on('terminal.write', (event, { id, data }) => {
        const session = sessions.get(id);
        if (session) session.write(data);
    });

    ipcMain.on('terminal.resize', (event, { id, cols, rows }) => {
        const session = sessions.get(id);
        if (session) session.resize(cols, rows);
    });

    ipcMain.on('terminal.close', (event, id) => {
        const session = sessions.get(id);
        if (session) {
            session.kill();
            sessions.delete(id);
            sessionHistory.delete(id);
        }
    });

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

    // Agent Execution
    ipcMain.handle('terminal.exec', async (event, { sessionId, command }: { sessionId: string; command: string }) => {
        const session = sessions.get(sessionId);
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        let cwd = process.env.HOME || '/';
        if (session) {
            try {
                const pid = session.pid;
                if (os.platform() === 'darwin') {
                    // Try to get CWD of the process
                    const { stdout } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $9}'`);
                    if (stdout.trim()) cwd = stdout.trim();
                } else if (os.platform() === 'linux') {
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
                const { stdout: lsofOut } = await execAsync(`lsof -p ${pid} | grep cwd | awk '{print $NF}' `);
                return lsofOut.trim() || null;
            } else if (os.platform() === 'linux') {
                const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
                return stdout.trim() || null;
            }
            return null;
        } catch (e) {
            return null;
        }
    });

    ipcMain.handle('terminal.getCompletions', async (event, { prefix, cwd }: { prefix: string; cwd?: string }) => {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const workDir = cwd || process.env.HOME || '/';
        try {
            const parts = prefix.trim().split(/\s+/);
            const cmd = parts.length <= 1
                ? `bash -c 'compgen -c "${parts[0] || ''}" 2>/dev/null | head -20'`
                : `bash -c 'compgen -f "${parts[parts.length - 1]}" 2>/dev/null | head -20'`;

            const { stdout } = await execAsync(cmd, { cwd: workDir });
            const results = stdout.trim().split('\n').filter(Boolean);
            return [...new Set(results)].sort((a, b) => a.length - b.length).slice(0, 10);
        } catch (e) {
            return [];
        }
    });

    ipcMain.handle('terminal.getHistory', (event, sessionId: string) => {
        return sessionHistory.get(sessionId) || '';
    });
};

initializeIpcHandlers();

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
