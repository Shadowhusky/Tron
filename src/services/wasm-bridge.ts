/**
 * WASM bridge — routes terminal I/O through Wasmer SDK Bash (WASIX).
 * Provides a real shell experience in the browser with no backend.
 * Requires SharedArrayBuffer (COOP/COEP headers).
 */

type Listener = (...args: any[]) => void;

const eventListeners = new Map<string, Set<Listener>>();
let wasmSessionCounter = 0;

// In-memory filesystem for demo mode file operations (also synced to WASM FS)
const memFS = new Map<string, string>();

// Terminal history buffer per session (accumulates all output)
const sessionHistory = new Map<string, string>();

// Track active WASM instances per session
const sessions = new Map<
  string,
  {
    stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
    instance: any; // Wasmer Instance
  }
>();

function pushEvent(channel: string, data: any) {
  // Track terminal history for readHistory
  if (channel === "terminal.incomingData" && data?.id && data?.data) {
    const prev = sessionHistory.get(data.id) || "";
    sessionHistory.set(data.id, prev + data.data);
  }

  const listeners = eventListeners.get(channel);
  if (listeners) {
    for (const fn of listeners) {
      fn(data);
    }
  }
}

// Shared encoder/decoder
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Strip ANSI escape codes for clean text matching. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Get any active WASM session ID. Falls back to last known session for error messages. */
function getActiveSessionId(): string | undefined {
  for (const id of sessions.keys()) return id;
  return lastSessionId;
}

/** Track last session ID so file operations can report clearer errors after crash. */
let lastSessionId: string | undefined;

/**
 * Execute a command in the WASM bash and capture output via sentinel.
 * The command runs visibly in the terminal — output is captured from
 * the terminal.incomingData event stream.
 */
async function execInWasm(
  sessionId: string,
  command: string,
  timeoutMs = 30000,
): Promise<{ stdout: string; exitCode: number }> {
  const session = sessions.get(sessionId);
  if (!session) return { stdout: "", exitCode: 1 };

  const sentinelId = Math.random().toString(36).slice(2, 10);
  const sentinel = `__TRON_DONE_${sentinelId}__`;

  return new Promise((resolve) => {
    let captured = "";
    let resolved = false;

    const handler: Listener = (eventData: any) => {
      if (resolved || eventData.id !== sessionId) return;
      captured += eventData.data;

      // Check for sentinel in ANSI-stripped text
      const clean = stripAnsi(captured).replace(/\r/g, "");
      if (clean.includes(sentinel)) {
        resolved = true;
        eventListeners.get("terminal.incomingData")?.delete(handler);

        // Extract output between the echoed command and the sentinel
        const lines = clean.split("\n");
        const sentIdx = lines.findIndex((l) => l.includes(sentinel));
        // Skip first line (echoed command) and sentinel-echo line (line before sentinel)
        const outputLines = lines.slice(1, sentIdx > 1 ? sentIdx - 1 : sentIdx);
        const stdout = outputLines
          .filter((l) => l.trim() && !l.trim().match(/^\$\s*$/))
          .join("\n")
          .trim();
        resolve({ stdout, exitCode: 0 });
      }
    };

    if (!eventListeners.has("terminal.incomingData")) {
      eventListeners.set("terminal.incomingData", new Set());
    }
    eventListeners.get("terminal.incomingData")!.add(handler);

    // Send command followed by sentinel echo
    session.stdinWriter
      .write(encoder.encode(`${command}\necho "${sentinel}"\n`))
      .catch(() => {
        resolved = true;
        eventListeners.get("terminal.incomingData")?.delete(handler);
        resolve({ stdout: "", exitCode: 1 });
      });

    // Timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        eventListeners.get("terminal.incomingData")?.delete(handler);
        resolve({ stdout: captured.trim() || "(timeout)", exitCode: 1 });
      }
    }, timeoutMs);
  });
}

/**
 * Sync a file write to the WASM bash filesystem using line-by-line echo.
 * Avoids heredoc (crashes WASIX) and keeps content on simple lines.
 * The file will then be visible to ls, cat, chmod, etc.
 */
function syncFileToWasm(filePath: string, content: string): void {
  const sid = getActiveSessionId();
  if (!sid) return;
  const session = sessions.get(sid);
  if (!session) return;

  // Skip very large files — too many echo commands would flood the terminal
  if (content.length > 8000) return;

  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  const lines = content.split("\n");
  const cmds: string[] = [];

  if (dir) cmds.push(`mkdir -p '${dir}'`);

  for (let i = 0; i < lines.length; i++) {
    // Escape single quotes: ' → '\''
    const escaped = lines[i].replace(/'/g, "'\\''");
    // First line truncates, rest append
    cmds.push(`echo '${escaped}' ${i === 0 ? ">" : ">>"} '${filePath}'`);
  }

  // Join with ; so it's one logical command per line pair, then a final newline
  const cmd = cmds.join("\n") + "\n";
  session.stdinWriter.write(encoder.encode(cmd)).catch(() => {});
}

/**
 * Lazy-initialize Wasmer SDK and spawn an interactive Bash instance.
 * Pipes stdout/stderr → terminal.incomingData events.
 */
async function createWasmSession(sessionId: string): Promise<void> {
  const { init, Wasmer } = await import("@wasmer/sdk");

  await init();

  const bashPkg = await Wasmer.fromRegistry("sharrattj/bash");
  const instance = await bashPkg.entrypoint!.run({
    args: ["-i"],
    env: {
      TERM: "xterm-256color",
      HOME: "/home/demo",
      USER: "demo",
      PS1: "\\[\\033[32m\\]$\\[\\033[0m\\] ",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
  });

  if (!instance.stdin) {
    throw new Error("WASM Bash instance has no stdin");
  }

  const stdinWriter = instance.stdin.getWriter();
  sessions.set(sessionId, { stdinWriter, instance });

  // Pipe stdout → terminal.incomingData
  const readStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // WASIX Bash outputs bare \n — xterm.js needs \r\n
        const text = decoder.decode(value).replace(/\n/g, "\r\n");
        pushEvent("terminal.incomingData", {
          id: sessionId,
          data: text,
        });
      }
    } catch {
      // Stream closed
    }
  };

  // Welcome message before shell output starts
  pushEvent("terminal.incomingData", {
    id: sessionId,
    data:
      "\x1b[90m" +
      "Tron WASM Terminal — running Bash via WebAssembly in your browser\r\n" +
      "Supports coreutils: ls, cat, echo, mkdir, grep, and more\r\n" +
      "\r\n" +
      "For full power, download Tron and run it locally.\r\n" +
      "Configure AI in Settings — works with local LLMs (Ollama, LM Studio)\r\n" +
      "so your data and API keys never leave your machine.\r\n" +
      "\x1b[0m\r\n",
  });

  readStream(instance.stdout);
  readStream(instance.stderr);

  // Handle process exit
  instance.wait().then((result: { code: number }) => {
    pushEvent("terminal.incomingData", {
      id: sessionId,
      data: `\r\n[Process exited with code ${result.code}]\r\n`,
    });
    sessions.delete(sessionId);
  });
}

/** Mock invoke handler — terminal channels route through WASM, rest are mocked. */
async function handleInvoke(channel: string, data?: any): Promise<any> {
  switch (channel) {
    case "terminal.create": {
      const sessionId = `wasm-${++wasmSessionCounter}`;
      lastSessionId = sessionId;
      // Start WASM session async — caller gets sessionId immediately,
      // terminal.incomingData events start flowing once ready
      createWasmSession(sessionId).catch((err) => {
        console.error("[WASM Bridge] Failed to create session:", err);
        pushEvent("terminal.incomingData", {
          id: sessionId,
          data: `\r\n\x1b[31mFailed to start WASM terminal: ${err.message}\x1b[0m\r\n`,
        });
      });
      return sessionId;
    }
    case "terminal.sessionExists":
      return sessions.has(data);
    case "terminal.checkCommand": {
      // Only return true for commands that exist in WASIX Bash
      const WASM_COMMANDS = new Set([
        "ls", "cd", "cat", "echo", "mkdir", "pwd", "rm", "cp", "mv",
        "grep", "head", "tail", "touch", "wc", "sort", "uniq", "tr",
        "basename", "dirname", "env", "true", "false", "test", "expr",
        "sleep", "date", "uname", "whoami", "id", "printenv", "seq",
      ]);
      const cmd = typeof data === "string" ? data : data?.command;
      return WASM_COMMANDS.has(cmd?.split(/\s+/)?.[0]?.toLowerCase() ?? "");
    }
    case "terminal.exec": {
      const execSid = data?.sessionId || getActiveSessionId();
      if (!execSid || !sessions.has(execSid)) {
        // Session crashed or not yet created — return shell-like error
        return { stdout: "", stderr: "No active terminal session", exitCode: 127 };
      }
      const execResult = await execInWasm(execSid, data?.command || "");
      return { stdout: execResult.stdout, stderr: "", exitCode: execResult.exitCode };
    }
    case "terminal.getCwd":
      return "/home/demo";
    case "terminal.getCompletions":
      return ["ls", "cd", "cat", "echo", "mkdir", "pwd", "rm", "cp", "mv"];
    case "terminal.getHistory":
      return "";
    case "terminal.readHistory": {
      const rhSid = data?.sessionId || (typeof data === "string" ? data : undefined) || getActiveSessionId();
      if (!rhSid) return "";
      const history = sessionHistory.get(rhSid) || "";
      // Strip ANSI and return last N lines
      const lines = stripAnsi(history).replace(/\r/g, "").split("\n");
      const n = data?.lines || 50;
      return lines.slice(-n).join("\n");
    }
    case "terminal.clearHistory": {
      const chSid = typeof data === "string" ? data : data?.sessionId;
      if (chSid) sessionHistory.delete(chSid);
      return;
    }
    case "terminal.getSystemInfo":
      return { platform: "wasm", arch: "wasm32", shell: "bash", release: "wasix" };
    case "terminal.execInTerminal": {
      const eitSid = data?.sessionId || getActiveSessionId();
      if (!eitSid || !sessions.has(eitSid)) {
        return { stdout: "Terminal session not available — the WASM shell may have exited. Reopen the tab to restart.", exitCode: 127 };
      }
      return execInWasm(eitSid, data?.command || "");
    }
    case "terminal.scanCommands":
      return ["ls", "cd", "cat", "echo", "mkdir", "pwd", "rm", "cp", "mv", "grep", "head", "tail"];
    case "terminal.close": {
      const session = sessions.get(data);
      if (session) {
        try { session.stdinWriter.close(); } catch { /* already closed */ }
        sessions.delete(data);
        sessionHistory.delete(data);
      }
      return;
    }
    case "ai.testConnection": {
      // Cloud providers: validate config only (no network call), same as electron/ipc/ai.ts
      const CLOUD = new Set(["openai","anthropic","gemini","deepseek","kimi","qwen","glm","minimax"]);
      const { provider, model, apiKey, baseUrl } = data || {};
      if (CLOUD.has(provider)) {
        if (!apiKey) return { success: false, error: "API key is required" };
        if (!model) return { success: false, error: "Model name is required" };
        return { success: true };
      }
      if (provider === "openai-compat" || provider === "anthropic-compat") {
        if (!baseUrl) return { success: false, error: "Base URL is required" };
        if (!model) return { success: false, error: "Model name is required" };
        return { success: true };
      }
      // Local providers (ollama, lmstudio) — can't reach from browser without proxy
      if (provider === "ollama" || provider === "lmstudio") {
        if (!model) return { success: false, error: "Model name is required" };
        return { success: true };
      }
      return { success: false, error: `Unknown provider: ${provider}` };
    }
    case "ssh.connect":
      return { sessionId: `demo-ssh-${++wasmSessionCounter}` };
    case "ssh.testConnection":
      return { success: false, error: "SSH connections not available in demo mode" };
    case "ssh.disconnect":
      return true;
    case "ssh.profiles.read":
      return [];
    case "ssh.profiles.write":
      return true;
    case "file.writeFile": {
      const { filePath: wfPath, content: wfContent } = data || {};
      if (!wfPath || typeof wfContent !== "string")
        return { success: false, error: "writeFile requires filePath and content" };
      const existed = memFS.has(wfPath);
      memFS.set(wfPath, wfContent);
      // Also sync to the WASM bash virtual filesystem so ls/cat/chmod see it
      syncFileToWasm(wfPath, wfContent);
      return { success: true, existed };
    }
    case "file.readFile": {
      const { filePath: rfPath } = data || {};
      if (!rfPath) return { success: false, error: "readFile requires filePath" };
      if (!memFS.has(rfPath))
        return { success: false, error: `File not found: ${rfPath}` };
      return { success: true, content: memFS.get(rfPath) };
    }
    case "file.editFile": {
      const { filePath: efPath, search: efSearch, replace: efReplace } = data || {};
      if (!efPath || typeof efSearch !== "string" || typeof efReplace !== "string")
        return { success: false, error: "editFile requires filePath, search, and replace" };
      if (!memFS.has(efPath))
        return { success: false, error: `File not found: ${efPath}` };
      const efContent = memFS.get(efPath)!;
      if (!efContent.includes(efSearch))
        return { success: false, error: "Search string not found in file." };
      let count = 0;
      let idx = 0;
      while ((idx = efContent.indexOf(efSearch, idx)) !== -1) { count++; idx += efSearch.length; }
      memFS.set(efPath, efContent.split(efSearch).join(efReplace));
      return { success: true, replacements: count };
    }
    case "file.listDir": {
      const { dirPath: ldPath } = data || {};
      if (!ldPath) return { success: false, error: "listDir requires dirPath" };
      const prefix = ldPath.endsWith("/") ? ldPath : ldPath + "/";
      const contents: { name: string; isDirectory: boolean }[] = [];
      const seen = new Set<string>();
      for (const key of memFS.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split("/")[0];
        if (!name || seen.has(name)) continue;
        seen.add(name);
        contents.push({ name, isDirectory: rest.includes("/") });
      }
      contents.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
        return a.isDirectory ? -1 : 1;
      });
      return { success: true, contents };
    }
    case "file.searchDir": {
      const { dirPath: sdPath, query: sdQuery } = data || {};
      if (!sdPath || !sdQuery) return { success: true, results: [] };
      const sdPrefix = sdPath.endsWith("/") ? sdPath : sdPath + "/";
      const results: string[] = [];
      for (const [key, val] of memFS.entries()) {
        if (!key.startsWith(sdPrefix)) continue;
        if (val.includes(sdQuery)) {
          const lines = val.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(sdQuery)) {
              results.push(`${key}:${i + 1}:${lines[i]}`);
              if (results.length >= 100) break;
            }
          }
        }
        if (results.length >= 100) break;
      }
      return { success: true, results };
    }
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
      return { home: "/home/demo", temp: "/tmp" };
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
      console.warn(`[WASM Bridge] Unhandled channel: ${channel}`);
      return null;
  }
}

/**
 * Install the WASM bridge as window.electron shim.
 * Same shape as installDemoBridge() in demo-bridge.ts.
 */
export function installWasmBridge() {
  console.log("[WASM Bridge] Installing WASM IPC handlers");

  const invoke = (channel: string, data?: any) => handleInvoke(channel, data);

  const send = (channel: string, data: any) => {
    // Route terminal.write to WASM stdin
    if (channel === "terminal.write" && data?.id && data?.data) {
      const session = sessions.get(data.id);
      if (session) {
        session.stdinWriter.write(encoder.encode(data.data)).catch(() => {
          // stdin closed
        });
      }
    }
    // terminal.resize → no-op (WASIX doesn't support PTY resize)
    // terminal.close → handled via invoke
  };

  const on = (channel: string, func: Listener): (() => void) => {
    if (!eventListeners.has(channel)) {
      eventListeners.set(channel, new Set());
    }
    eventListeners.get(channel)!.add(func);
    return () => {
      eventListeners.get(channel)?.delete(func);
    };
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
      checkCommand: (cmd: string) => invoke("terminal.checkCommand", cmd),
      getCwd: () => Promise.resolve("/home/demo"),
      getCompletions: () =>
        Promise.resolve(["ls", "cd", "cat", "echo", "mkdir", "pwd"]),
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
      writeConfig: (data: Record<string, unknown>) =>
        invoke("config.write", data),
      readSessions: () => invoke("sessions.read"),
      writeSessions: (data: Record<string, unknown>) =>
        invoke("sessions.write", data),
      getSystemPaths: () => invoke("config.getSystemPaths"),
      selectFolder: () => Promise.resolve(null),
      openExternal: (url: string) => {
        window.open(url, "_blank");
      },
      openPath: () => Promise.resolve(""),
      showItemInFolder: () => Promise.resolve(),
      flushStorage: () => Promise.resolve(),
      listDir: (dirPath: string) => invoke("file.listDir", { dirPath }),
      searchDir: (dirPath: string, query: string) =>
        invoke("file.searchDir", { dirPath, query }),
      saveSessionLog: (data: any) => invoke("log.saveSessionLog", data),
      connectSSH: (config: any) => invoke("ssh.connect", config),
      testSSHConnection: (config: any) => invoke("ssh.testConnection", config),
      disconnectSSH: (sessionId: string) =>
        invoke("ssh.disconnect", sessionId),
      readSSHProfiles: () => invoke("ssh.profiles.read"),
      writeSSHProfiles: (profiles: any[]) =>
        invoke("ssh.profiles.write", profiles),
    },
  };
}
