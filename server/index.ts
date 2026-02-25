import "dotenv/config";
import express from "express";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import url from "url";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { createProxyMiddleware } from "http-proxy-middleware";
import * as terminal from "./handlers/terminal.js";
import * as ai from "./handlers/ai.js";
import * as ssh from "./handlers/ssh.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.TRON_PORT) || 3888;
const DEV_VITE_PORT = Number(process.env.PORT) || 5173;
const isDev = process.argv.includes("--dev") || process.env.TRON_DEV === "true";

// Deployment mode: "local" (default), "gateway" (cloud/hosted, node-pty optional)
type ServerMode = "local" | "gateway";
const serverMode: ServerMode =
  (process.env.TRON_MODE as ServerMode) ||
  (process.argv.includes("--gateway") ? "gateway" : "local");

// SSH-only restriction: blocks local terminal, file ops, server shell access.
// Gateway defaults to true; explicit env var overrides either way.
const sshOnly: boolean = (() => {
  const env = process.env.TRON_SSH_ONLY?.toLowerCase();
  if (env === "true" || env === "1") return true;
  if (env === "false" || env === "0") return false;
  if (process.argv.includes("--ssh-only")) return true;
  // Gateway defaults to SSH-only unless explicitly disabled
  return serverMode === "gateway";
})();

console.log(`[Tron Web] Mode: ${serverMode}${sshOnly ? " (SSH-only)" : ""}`);

// ---------------------------------------------------------------------------
// File-backed persistence for web mode (survives server restarts & reconnects)
// ---------------------------------------------------------------------------
const tronDataDir = path.join(os.homedir(), ".tron");
const sessionsFile = path.join(tronDataDir, "web-sessions.json");
const configsFile = path.join(tronDataDir, "web-configs.json");

function ensureDataDir() {
  try { fs.mkdirSync(tronDataDir, { recursive: true }); } catch { /* exists */ }
}

function loadJsonMap(filePath: string): Map<string, Record<string, unknown>> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveJsonMap(filePath: string, map: Map<string, Record<string, unknown>>) {
  ensureDataDir();
  const obj: Record<string, unknown> = {};
  for (const [k, v] of map) obj[k] = v;
  try { fs.writeFileSync(filePath, JSON.stringify(obj), "utf-8"); } catch { /* best effort */ }
}

const savedTabsFile = path.join(tronDataDir, "saved-tabs.json");

ensureDataDir();
const clientSessions = loadJsonMap(sessionsFile);
const clientConfigs = loadJsonMap(configsFile);

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// AI provider HTTP proxy — routes browser requests to AI providers through
// the server, avoiding CORS issues (cloud providers like Anthropic block
// browser-origin requests) and auth issues for local providers.
// Client sends: POST /api/ai-proxy/v1/chat/completions
//               Header X-Target-Base: http://127.0.0.1:1234
// Server fetches: http://127.0.0.1:1234/v1/chat/completions and pipes back.
// ---------------------------------------------------------------------------

import { Readable } from "stream";

// Use express.raw() to forward body bytes as-is — avoids JSON parse/re-serialize issues
app.all("/api/ai-proxy/{*path}", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
  const targetBase = req.headers["x-target-base"] as string;
  if (!targetBase) {
    res.status(400).json({ error: "Missing X-Target-Base header" });
    return;
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL(targetBase);
  } catch {
    res.status(400).json({ error: "Invalid X-Target-Base URL" });
    return;
  }

  // Only allow http/https schemes to prevent SSRF to internal protocols
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") {
    res.status(403).json({ error: "Proxy only allows http/https targets" });
    return;
  }

  const proxyPath = req.path.replace(/^\/api\/ai-proxy/, "") || "/";
  const targetUrl = `${targetBase.replace(/\/+$/, "")}${proxyPath}`;

  try {
    // Forward all headers except hop-by-hop and internal proxy headers
    const skipHeaders = new Set(["host", "connection", "keep-alive", "transfer-encoding", "x-target-base", "origin", "referer"]);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!skipHeaders.has(key) && typeof value === "string") {
        headers[key] = value;
      }
    }

    const init: RequestInit = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD" && req.body && (req.body as Buffer).length > 0) {
      init.body = (req.body as Buffer).toString();
    }

    const response = await fetch(targetUrl, init);
    res.status(response.status);

    // Forward response headers
    for (const [key, value] of response.headers.entries()) {
      if (key !== "transfer-encoding" && key !== "connection" && key !== "content-encoding") {
        res.setHeader(key, value);
      }
    }

    if (response.body) {
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (e: any) {
    if (!res.headersSent) {
      res.status(502).json({ error: e.message || "Proxy error" });
    }
  }
});

// Static files or proxy in dev
if (isDev) {
  // In dev mode, proxy HTTP requests to Vite dev server
  app.use(
    createProxyMiddleware({
      target: `http://localhost:${DEV_VITE_PORT}`,
      changeOrigin: true,
      ws: false, // We handle WS ourselves
    })
  );
} else {
  // In production, serve built React assets
  const staticPath = path.join(__dirname, "../dist-react");
  app.use(express.static(staticPath));
  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });
}

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

// Delayed cleanup map — cancel if client reconnects within grace period
const pendingCleanups = new Map<string, ReturnType<typeof setTimeout>>();
// Track the current active WS per client so stale close events don't start cleanup
const activeConnections = new Map<string, WebSocket>();

wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  // Use persistent client token from URL query (survives reconnects) or fall back to random
  const parsed = url.parse(req.url || "", true);
  const clientId = (parsed.query.token as string) || randomUUID();

  // Cancel any pending cleanup for this client (reconnected before grace period expired)
  const pendingCleanup = pendingCleanups.get(clientId);
  if (pendingCleanup) {
    clearTimeout(pendingCleanup);
    pendingCleanups.delete(clientId);
    console.log(`[Tron Web] Client ${clientId.slice(0, 8)}… reconnected, cancelled cleanup`);
  }

  // Mark this as the active connection for this client
  activeConnections.set(clientId, ws);

  // Immediately tell client which mode and restrictions we're running with
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "mode", mode: serverMode, sshOnly }));
  }

  // Push events to this specific client
  const pushEvent = (channel: string, data: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "event", channel, data }));
    }
  };

  // Update pushEvent for all existing sessions owned by this client
  // (handles WS reconnect without page reload — e.g., mobile sleep/wake)
  terminal.updateClientPushEvent(clientId, pushEvent);

  ws.on("message", async (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, id, channel, data } = msg;

    if (type === "invoke") {
      try {
        const result = await handleInvoke(channel, data, clientId, pushEvent);
        ws.send(JSON.stringify({ type: "invoke-response", id, result }));
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "invoke-response", id, error: err.message }));
      }
    } else if (type === "send") {
      handleSend(channel, data);
    }
  });

  ws.on("close", () => {
    // If this client already has a newer active connection (page refresh race),
    // this is a stale close event — skip cleanup entirely.
    if (activeConnections.get(clientId) !== ws) return;

    activeConnections.delete(clientId);

    // Delay cleanup to allow page reload / reconnection within grace period
    pendingCleanups.set(clientId, setTimeout(() => {
      ssh.cleanupClientSSHSessions(clientId, terminal.getSessionOwners());
      terminal.cleanupClientSessions(clientId);
      pendingCleanups.delete(clientId);
      console.log(`[Tron Web] Cleaned up sessions for disconnected client ${clientId.slice(0, 8)}…`);
    }, 300_000)); // 5 minute grace period (mobile browsers kill pages aggressively)
  });
});

// Channels completely blocked in SSH-only mode (no local PTY or filesystem)
const SSH_ONLY_BLOCKED_CHANNELS = new Set([
  "terminal.create",
  "terminal.scanCommands",
  "file.writeFile",
  "file.readFile",
  "file.editFile",
  "file.listDir",
  "file.searchDir",
  "log.saveSessionLog",
]);

// Terminal channels that take a sessionId — in SSH-only mode, must be an SSH session
const SSH_ONLY_SESSION_CHANNELS = new Set([
  "terminal.exec",
  "terminal.getCwd",
  "terminal.getCompletions",
  "terminal.getHistory",
  "terminal.getSystemInfo",
  "terminal.readHistory",
  "terminal.clearHistory",
  "terminal.execInTerminal",
  "terminal.sessionExists",
  "terminal.checkCommand",
]);

/** Extract sessionId from invoke data for SSH-only validation. */
function extractSessionId(channel: string, data: any): string | undefined {
  if (!data) return undefined;
  if (typeof data === "string") return data; // many channels pass sessionId as plain string
  if (data.sessionId) return data.sessionId;
  // terminal.checkCommand passes { command, sessionId? }
  if (channel === "terminal.checkCommand" && typeof data === "object") return data.sessionId;
  return undefined;
}

async function handleInvoke(
  channel: string,
  data: any,
  clientId: string,
  pushEvent: terminal.EventPusher
): Promise<any> {
  if (sshOnly) {
    // Block channels that expose the server's local shell / filesystem
    if (SSH_ONLY_BLOCKED_CHANNELS.has(channel)) {
      throw new Error(`Not available in SSH-only mode: ${channel}`);
    }

    // For terminal channels with a sessionId, verify it's an SSH session.
    // This prevents users from executing commands on the server's own shell.
    if (SSH_ONLY_SESSION_CHANNELS.has(channel)) {
      const sid = extractSessionId(channel, data);
      if (!sid || !ssh.sshSessionIds.has(sid)) {
        throw new Error("Only SSH sessions are available in SSH-only mode");
      }
    }
  }

  switch (channel) {
    case "terminal.create":
      return terminal.createSession(data || {}, clientId, pushEvent);
    case "terminal.sessionExists":
      return terminal.sessionExists(data);
    case "terminal.checkCommand":
      return terminal.checkCommand(typeof data === "string" ? data : data.command, typeof data === "object" ? data.sessionId : undefined);
    case "terminal.exec":
      return terminal.execCommand(data.sessionId, data.command);
    case "terminal.getCwd":
      return terminal.getCwd(data);
    case "terminal.getCompletions":
      return terminal.getCompletions(data);
    case "terminal.getHistory":
      return terminal.getHistory(data);
    case "terminal.getSystemInfo":
      return terminal.getSystemInfo(data);
    case "ai.testConnection":
      return ai.testConnection(data);
    case "ai.getModels":
      return ai.getModels(data);
    case "ai.getModelCapabilities":
      return ai.getModelCapabilities(data);
    case "ssh.connect":
      return ssh.createSSHSession(
        data,
        clientId,
        pushEvent,
        terminal.getSessions(),
        terminal.getSessionHistory(),
        terminal.getSessionOwners(),
      );
    case "ssh.testConnection":
      return ssh.testConnection(data);
    case "ssh.disconnect":
      return ssh.disconnectSession(data);
    case "ssh.profiles.read":
      return ssh.readProfiles();
    case "ssh.profiles.write":
      return ssh.writeProfiles(data);
    case "savedTabs.read":
      try {
        if (!fs.existsSync(savedTabsFile)) return [];
        return JSON.parse(fs.readFileSync(savedTabsFile, "utf-8"));
      } catch { return []; }
    case "savedTabs.write":
      try {
        ensureDataDir();
        fs.writeFileSync(savedTabsFile, JSON.stringify(data, null, 2), "utf-8");
        return true;
      } catch { return false; }
    case "terminal.readHistory":
      return terminal.readHistory(data?.sessionId || data, data?.lines);
    case "terminal.clearHistory":
      return terminal.clearHistory(typeof data === "string" ? data : data?.sessionId);
    case "terminal.execInTerminal":
      return terminal.execInTerminal(data.sessionId, data.command, pushEvent);
    case "terminal.scanCommands":
      return terminal.scanCommands();
    case "file.saveTempImage": {
      const tmpDir = path.join(os.tmpdir(), "tron-images");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const name = `paste-${Date.now()}.${data.ext || "png"}`;
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, Buffer.from(data.base64, "base64"));
      return filePath;
    }
    case "file.writeFile":
      return terminal.writeFile(data.filePath, data.content);
    case "file.readFile":
      return terminal.readFile(data.filePath);
    case "file.editFile":
      return terminal.editFile(data.filePath, data.search, data.replace);
    case "file.listDir":
      return terminal.listDir(data.dirPath);
    case "file.searchDir":
      return terminal.searchDir(data.dirPath, data.query);
    case "log.saveSessionLog":
      return terminal.saveSessionLog(data);
    case "sessions.read":
      return clientSessions.get(clientId) || null;
    case "sessions.write": {
      // Merge top-level keys (allows multiple contexts to coexist: _layout, _agent, etc.)
      const existing = (clientSessions.get(clientId) || {}) as Record<string, unknown>;
      clientSessions.set(clientId, { ...existing, ...data });
      saveJsonMap(sessionsFile, clientSessions);
      return true;
    }
    case "config.read":
      return clientConfigs.get(clientId) || null;
    case "config.write":
      clientConfigs.set(clientId, data);
      saveJsonMap(configsFile, clientConfigs);
      return true;
    case "config.getSystemPaths": {
      const home = process.env.HOME || os.homedir();
      return {
        home,
        desktop: path.join(home, "Desktop"),
        documents: path.join(home, "Documents"),
        downloads: path.join(home, "Downloads"),
        temp: os.tmpdir(),
      };
    }
    case "system.selectFolder":
      return null; // Not available in web mode
    case "shell.openExternal":
      return; // No-op in web mode
    case "shell.openPath":
      return ""; // No-op in web mode
    case "shell.showItemInFolder":
      return; // No-op in web mode
    case "system.flushStorage":
      return; // No-op in web mode
    default:
      throw new Error(`Unknown channel: ${channel}`);
  }
}

function handleSend(channel: string, data: any) {
  // SSH-only mode: only allow send channels for SSH sessions
  if (sshOnly) {
    const sid = data?.id || (typeof data === "string" ? data : undefined);
    if (!sid || !ssh.sshSessionIds.has(sid)) return; // silently drop
  }

  switch (channel) {
    case "terminal.write":
      terminal.writeToSession(data.id, data.data);
      break;
    case "terminal.resize":
      terminal.resizeSession(data.id, data.cols, data.rows);
      break;
    case "terminal.close":
      terminal.closeSession(data);
      break;
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Tron Web] Server running on http://0.0.0.0:${PORT}`);
  if (isDev) {
    console.log(`[Tron Web] Proxying to Vite at http://localhost:${DEV_VITE_PORT}`);
  }
  // Notify parent process (Electron fork) that we're ready
  if (typeof process.send === "function") {
    process.send({ type: "ready", port: PORT });
  }
});

// Cleanup on server shutdown
const shutdownHandler = () => {
  ssh.cleanupAllSSHSessions();
  terminal.cleanupAllServerSessions();
  process.exit(0);
};
process.on("SIGINT", shutdownHandler);
process.on("SIGTERM", shutdownHandler);
