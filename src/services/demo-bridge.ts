/**
 * Demo bridge — mock IPC handlers for static/offline deployments.
 * Installed by ws-bridge when no WebSocket server is reachable.
 * Provides a realistic-looking terminal experience with typewriter effect.
 */

type Listener = (...args: any[]) => void;

const eventListeners = new Map<string, Set<Listener>>();
let demoSessionCounter = 0;

// Canned terminal content for the typewriter effect
const DEMO_LINES = [
  "\x1b[32m$\x1b[0m whoami",
  "demo-user",
  "\x1b[32m$\x1b[0m ls -la",
  "total 48",
  "drwxr-xr-x  12 demo-user  staff   384 Feb 22 10:30 .",
  "drwxr-xr-x   5 demo-user  staff   160 Feb 22 09:00 ..",
  "-rw-r--r--   1 demo-user  staff   220 Feb 22 10:30 .env",
  "drwxr-xr-x   8 demo-user  staff   256 Feb 22 10:28 .git",
  "-rw-r--r--   1 demo-user  staff  1024 Feb 22 10:30 package.json",
  "-rw-r--r--   1 demo-user  staff   512 Feb 22 10:30 tsconfig.json",
  "drwxr-xr-x   6 demo-user  staff   192 Feb 22 10:28 src",
  "drwxr-xr-x   3 demo-user  staff    96 Feb 22 10:28 public",
  "\x1b[32m$\x1b[0m cat package.json | head -5",
  "{",
  '  "name": "my-app",',
  '  "version": "1.0.0",',
  '  "scripts": {',
  '    "dev": "vite"',
  "\x1b[32m$\x1b[0m ",
];

function pushEvent(channel: string, data: any) {
  const listeners = eventListeners.get(channel);
  if (listeners) {
    for (const fn of listeners) {
      fn(data);
    }
  }
}

/** Typewriter effect — push pre-canned terminal lines character-by-character. */
function startTypewriter(sessionId: string) {
  let lineIdx = 0;
  let charIdx = 0;
  const speed = 20; // ms per character
  const lineDelay = 300; // ms between lines

  function tick() {
    if (lineIdx >= DEMO_LINES.length) return;

    const line = DEMO_LINES[lineIdx];
    if (charIdx < line.length) {
      pushEvent("terminal.incomingData", {
        id: sessionId,
        data: line[charIdx],
      });
      charIdx++;
      setTimeout(tick, speed);
    } else {
      // End of line — push newline and move to next
      pushEvent("terminal.incomingData", { id: sessionId, data: "\r\n" });
      lineIdx++;
      charIdx = 0;
      setTimeout(tick, lineDelay);
    }
  }

  // Short initial delay before starting
  setTimeout(tick, 500);
}

/** Mock invoke handler for all IPC channels. */
async function handleInvoke(channel: string, _data?: any): Promise<any> {
  switch (channel) {
    case "terminal.create": {
      const sessionId = `demo-${++demoSessionCounter}`;
      // Start typewriter effect after a brief delay
      setTimeout(() => startTypewriter(sessionId), 200);
      return sessionId;
    }
    case "terminal.sessionExists":
      return true;
    case "terminal.checkCommand":
      return true;
    case "terminal.exec":
      return { stdout: "", stderr: "", exitCode: 0 };
    case "terminal.getCwd":
      return "/home/demo-user/my-app";
    case "terminal.getCompletions":
      return ["ls", "cd", "cat", "npm", "git"];
    case "terminal.getHistory":
      return DEMO_LINES.join("\n");
    case "terminal.readHistory":
      return DEMO_LINES.slice(-10).join("\n");
    case "terminal.clearHistory":
      return;
    case "terminal.getSystemInfo":
      return { platform: "linux", arch: "x64", shell: "bash", release: "5.15.0" };
    case "terminal.execInTerminal":
      return { stdout: "(demo mode)", exitCode: 0 };
    case "terminal.scanCommands":
      return ["ls", "cd", "cat", "npm", "git", "node", "python"];
    case "ai.testConnection":
      return { success: false, error: "AI connections not available in demo mode" };
    case "ssh.connect":
      return { sessionId: `demo-ssh-${++demoSessionCounter}` };
    case "ssh.testConnection":
      return { success: false, error: "SSH connections not available in demo mode" };
    case "ssh.disconnect":
      return true;
    case "ssh.profiles.read":
      return [
        { id: "demo-1", name: "Production Server", host: "prod.example.com", port: 22, username: "deploy" },
        { id: "demo-2", name: "Dev Server", host: "dev.example.com", port: 22, username: "dev" },
      ];
    case "ssh.profiles.write":
      return true;
    case "file.writeFile":
      return { success: false, error: "File operations not available in demo mode" };
    case "file.readFile":
      return { success: false, error: "File operations not available in demo mode" };
    case "file.editFile":
      return { success: false, error: "File operations not available in demo mode" };
    case "file.listDir":
      return {
        success: true,
        contents: [
          { name: "src", isDirectory: true },
          { name: "public", isDirectory: true },
          { name: "package.json", isDirectory: false },
          { name: "tsconfig.json", isDirectory: false },
        ],
      };
    case "file.searchDir":
      return { success: true, results: [] };
    case "log.saveSessionLog":
      return { success: false, error: "Logging not available in demo mode" };
    case "sessions.read":
      return null;
    case "sessions.write":
      return true;
    case "config.read":
      return null;
    case "config.write":
      return true;
    case "config.getSystemPaths":
      return { home: "/home/demo-user", temp: "/tmp" };
    case "system.selectFolder":
      return null;
    case "shell.openExternal":
      return;
    case "shell.openPath":
      return "";
    case "shell.showItemInFolder":
      return;
    case "system.flushStorage":
      return;
    default:
      console.warn(`[Demo Bridge] Unhandled channel: ${channel}`);
      return null;
  }
}

/**
 * Replace the window.electron shim with demo mock handlers.
 * Called from ws-bridge when the WS server is unreachable.
 */
export function installDemoBridge() {
  console.log("[Demo Bridge] Installing mock IPC handlers");

  const invoke = (channel: string, data?: any) => handleInvoke(channel, data);
  const send = (_channel: string, _data: any) => { /* no-op */ };
  const on = (channel: string, func: Listener): (() => void) => {
    if (!eventListeners.has(channel)) {
      eventListeners.set(channel, new Set());
    }
    eventListeners.get(channel)!.add(func);
    return () => { eventListeners.get(channel)?.delete(func); };
  };
  const once = (channel: string, func: Listener) => {
    const wrapper: Listener = (...args) => {
      eventListeners.get(channel)?.delete(wrapper);
      func(...args);
    };
    on(channel, wrapper);
  };
  const removeListener = (channel: string, func: Listener) => {
    eventListeners.get(channel)?.delete(func);
  };

  (window as any).electron = {
    ipcRenderer: {
      invoke,
      send,
      on,
      once,
      removeListener,
      checkCommand: () => Promise.resolve(true),
      getCwd: () => Promise.resolve("/home/demo-user/my-app"),
      getCompletions: () => Promise.resolve(["ls", "cd", "cat"]),
      getHistory: (sessionId: string) => invoke("terminal.getHistory", sessionId),
      scanCommands: () => invoke("terminal.scanCommands") as Promise<string[]>,
      exec: (sessionId: string, command: string) =>
        invoke("terminal.exec", { sessionId, command }),
      testAIConnection: (config: any) => invoke("ai.testConnection", config),
      getSystemInfo: (sessionId?: string) =>
        invoke("terminal.getSystemInfo", sessionId),
      execInTerminal: (sessionId: string, command: string) =>
        invoke("terminal.execInTerminal", { sessionId, command }),
      readConfig: () => invoke("config.read"),
      writeConfig: (data: Record<string, unknown>) => invoke("config.write", data),
      readSessions: () => invoke("sessions.read"),
      writeSessions: (data: Record<string, unknown>) => invoke("sessions.write", data),
      getSystemPaths: () => invoke("config.getSystemPaths"),
      selectFolder: () => Promise.resolve(null),
      openExternal: (url: string) => { window.open(url, "_blank"); },
      openPath: () => Promise.resolve(""),
      showItemInFolder: () => Promise.resolve(),
      flushStorage: () => Promise.resolve(),
      listDir: (dirPath: string) => invoke("file.listDir", { dirPath }),
      searchDir: (dirPath: string, query: string) => invoke("file.searchDir", { dirPath, query }),
      saveSessionLog: (data: any) => invoke("log.saveSessionLog", data),
      connectSSH: (config: any) => invoke("ssh.connect", config),
      testSSHConnection: (config: any) => invoke("ssh.testConnection", config),
      disconnectSSH: (sessionId: string) => invoke("ssh.disconnect", sessionId),
      readSSHProfiles: () => invoke("ssh.profiles.read"),
      writeSSHProfiles: (profiles: any[]) => invoke("ssh.profiles.write", profiles),
    },
  };
}
