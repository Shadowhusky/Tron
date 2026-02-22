import express from "express";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { createProxyMiddleware } from "http-proxy-middleware";
import * as terminal from "./handlers/terminal.js";
import * as ai from "./handlers/ai.js";
import * as ssh from "./handlers/ssh.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3888;
const DEV_VITE_PORT = Number(process.env.PORT) || 5173;
const isDev = process.argv.includes("--dev");

// Deployment mode: "local" (default), "gateway" (SSH-only, no local PTY)
type ServerMode = "local" | "gateway";
const serverMode: ServerMode =
  (process.env.TRON_MODE as ServerMode) ||
  (process.argv.includes("--gateway") ? "gateway" : "local");

console.log(`[Tron Web] Mode: ${serverMode}`);

// In-memory persistence for web mode (per client)
const clientSessions = new Map<string, Record<string, unknown>>();
const clientConfigs = new Map<string, Record<string, unknown>>();

const app = express();
const server = http.createServer(app);

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

wss.on("connection", (ws: WebSocket) => {
  const clientId = randomUUID();
  console.log(`[WS] Client connected: ${clientId}`);

  // Immediately tell client which mode we're running in
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "mode", mode: serverMode }));
  }

  // Push events to this specific client
  const pushEvent = (channel: string, data: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "event", channel, data }));
    }
  };

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
    console.log(`[WS] Client disconnected: ${clientId}`);
    ssh.cleanupClientSSHSessions(clientId, terminal.getSessionOwners());
    terminal.cleanupClientSessions(clientId);
    clientSessions.delete(clientId);
    clientConfigs.delete(clientId);
  });
});

// Channels completely blocked in gateway mode (no local PTY or filesystem)
const GATEWAY_BLOCKED_CHANNELS = new Set([
  "terminal.create",
  "terminal.scanCommands",
  "file.writeFile",
  "file.readFile",
  "file.editFile",
  "file.listDir",
  "file.searchDir",
  "log.saveSessionLog",
  "config.getSystemPaths",  // leaks server home/temp paths
]);

// Terminal channels that take a sessionId — in gateway mode, only SSH sessions allowed
const GATEWAY_SESSION_CHANNELS = new Set([
  "terminal.exec",
  "terminal.getCwd",
  "terminal.getCompletions",
  "terminal.getHistory",
  "terminal.getSystemInfo",
  "terminal.readHistory",
  "terminal.clearHistory",
  "terminal.execInTerminal",
  "terminal.sessionExists",
]);

/** Extract sessionId from invoke data for gateway validation. */
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
  if (serverMode === "gateway") {
    // Block channels that should never run in gateway mode
    if (GATEWAY_BLOCKED_CHANNELS.has(channel)) {
      throw new Error(`Not available in gateway mode: ${channel}`);
    }

    // For terminal channels with a sessionId, verify it's an SSH session.
    // This prevents users from executing commands on the server's own shell.
    if (GATEWAY_SESSION_CHANNELS.has(channel)) {
      const sid = extractSessionId(channel, data);
      if (!sid || !ssh.sshSessionIds.has(sid)) {
        throw new Error("Only SSH sessions are available in gateway mode");
      }
    }

    // terminal.checkCommand without a sessionId would run `which` on the server
    if (channel === "terminal.checkCommand") {
      const sid = typeof data === "object" ? data.sessionId : undefined;
      if (!sid || !ssh.sshSessionIds.has(sid)) {
        throw new Error("Only SSH sessions are available in gateway mode");
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
    case "terminal.readHistory":
      return terminal.readHistory(data?.sessionId || data, data?.lines);
    case "terminal.clearHistory":
      return terminal.clearHistory(typeof data === "string" ? data : data?.sessionId);
    case "terminal.execInTerminal":
      return terminal.execInTerminal(data.sessionId, data.command, pushEvent);
    case "terminal.scanCommands":
      return terminal.scanCommands();
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
    case "sessions.write":
      clientSessions.set(clientId, data);
      return true;
    case "config.read":
      return clientConfigs.get(clientId) || null;
    case "config.write":
      clientConfigs.set(clientId, data);
      return true;
    case "config.getSystemPaths":
      return { home: process.env.HOME || os.homedir(), temp: os.tmpdir() };
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
  // Gateway mode: only allow send channels for SSH sessions
  if (serverMode === "gateway") {
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
});

// Cleanup on server shutdown
const shutdownHandler = () => {
  ssh.cleanupAllSSHSessions();
  terminal.cleanupAllServerSessions();
  process.exit(0);
};
process.on("SIGINT", shutdownHandler);
process.on("SIGTERM", shutdownHandler);
