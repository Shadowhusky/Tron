import express from "express";
import http from "http";
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
const app = express();
const server = http.createServer(app);
// Static files or proxy in dev
if (isDev) {
    // In dev mode, proxy HTTP requests to Vite dev server
    app.use(createProxyMiddleware({
        target: `http://localhost:${DEV_VITE_PORT}`,
        changeOrigin: true,
        ws: false, // We handle WS ourselves
    }));
}
else {
    // In production, serve built React assets
    const staticPath = path.join(__dirname, "../dist-react");
    app.use(express.static(staticPath));
    app.get("/{*path}", (_req, res) => {
        res.sendFile(path.join(staticPath, "index.html"));
    });
}
// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
    const clientId = randomUUID();
    console.log(`[WS] Client connected: ${clientId}`);
    // Push events to this specific client
    const pushEvent = (channel, data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "event", channel, data }));
        }
    };
    ws.on("message", async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        const { type, id, channel, data } = msg;
        if (type === "invoke") {
            try {
                const result = await handleInvoke(channel, data, clientId, pushEvent);
                ws.send(JSON.stringify({ type: "invoke-response", id, result }));
            }
            catch (err) {
                ws.send(JSON.stringify({ type: "invoke-response", id, error: err.message }));
            }
        }
        else if (type === "send") {
            handleSend(channel, data);
        }
    });
    ws.on("close", () => {
        console.log(`[WS] Client disconnected: ${clientId}`);
        ssh.cleanupClientSSHSessions(clientId, terminal.getSessionOwners());
        terminal.cleanupClientSessions(clientId);
    });
});
async function handleInvoke(channel, data, clientId, pushEvent) {
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
            return ssh.createSSHSession(data, clientId, pushEvent, terminal.getSessions(), terminal.getSessionHistory(), terminal.getSessionOwners());
        case "ssh.testConnection":
            return ssh.testConnection(data);
        case "ssh.disconnect":
            return ssh.disconnectSession(data);
        case "ssh.profiles.read":
            return ssh.readProfiles();
        case "ssh.profiles.write":
            return ssh.writeProfiles(data);
        default:
            throw new Error(`Unknown channel: ${channel}`);
    }
}
function handleSend(channel, data) {
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
//# sourceMappingURL=index.js.map