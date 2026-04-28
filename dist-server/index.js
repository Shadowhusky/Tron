import "dotenv/config";
import express from "express";
import compression from "compression";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { pipeline } from "stream";
import { execSync } from "child_process";
import { createProxyMiddleware } from "http-proxy-middleware";
import * as terminal from "./handlers/terminal.js";
import * as ai from "./handlers/ai.js";
import * as ssh from "./handlers/ssh.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.TRON_PORT) || 3888;
const HOST = process.env.TRON_HOST || "0.0.0.0";
const DEV_VITE_PORT = Number(process.env.PORT) || 5173;
const isDev = process.argv.includes("--dev") || process.env.TRON_DEV === "true";
const serverMode = process.env.TRON_MODE ||
    (process.argv.includes("--gateway") ? "gateway" : "local");
// SSH-only restriction: blocks local terminal, file ops, server shell access.
// Gateway defaults to true; explicit env var overrides either way.
const sshOnly = (() => {
    const env = process.env.TRON_SSH_ONLY?.toLowerCase();
    if (env === "true" || env === "1")
        return true;
    if (env === "false" || env === "0")
        return false;
    if (process.argv.includes("--ssh-only"))
        return true;
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
    try {
        fs.mkdirSync(tronDataDir, { recursive: true });
    }
    catch { /* exists */ }
}
function loadJsonMap(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const obj = JSON.parse(raw);
        return new Map(Object.entries(obj));
    }
    catch {
        return new Map();
    }
}
function saveJsonMap(filePath, map) {
    ensureDataDir();
    const obj = {};
    for (const [k, v] of map)
        obj[k] = v;
    // Atomic write: tmp file + rename to avoid corruption on crash
    const tmpPath = filePath + ".tmp";
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(obj), "utf-8");
        fs.renameSync(tmpPath, filePath);
    }
    catch { /* best effort */ }
}
const savedTabsFile = path.join(tronDataDir, "saved-tabs.json");
const remoteProfilesFile = path.join(tronDataDir, "remote-servers.json");
ensureDataDir();
const clientSessions = loadJsonMap(sessionsFile);
const clientConfigs = loadJsonMap(configsFile);
const app = express();
// Gzip compression — dramatically reduces JS/CSS bundle transfer size
// Skip compression for AI proxy routes (already streamed from upstream)
app.use(compression({
    filter: (req, res) => {
        if (req.path.startsWith("/api/ai-proxy"))
            return false;
        return compression.filter(req, res);
    },
}));
const server = http.createServer(app);
// ---------------------------------------------------------------------------
// Frame-check endpoint — HEAD request to detect X-Frame-Options / CSP
// frame-ancestors. Used by BrowserPane to avoid CSP console errors.
// ---------------------------------------------------------------------------
app.get("/api/frame-check", async (req, res) => {
    // Allow cross-origin requests (Electron embedded server on localhost)
    res.set("Access-Control-Allow-Origin", "*");
    const url = req.query.url;
    if (!url) {
        res.json({ embeddable: false });
        return;
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            res.json({ embeddable: false });
            return;
        }
        const resp = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            signal: AbortSignal.timeout(5000),
        });
        const xfo = (resp.headers.get("x-frame-options") || "").toLowerCase();
        if (xfo === "deny" || xfo === "sameorigin") {
            res.json({ embeddable: false });
            return;
        }
        const csp = resp.headers.get("content-security-policy") || "";
        const fa = csp.match(/frame-ancestors\s+([^;]+)/i);
        if (fa) {
            const val = fa[1].trim().toLowerCase();
            if (val === "'none'" || val === "'self'") {
                res.json({ embeddable: false });
                return;
            }
        }
        res.json({ embeddable: true });
    }
    catch {
        // Can't reach or timeout — let iframe try
        res.json({ embeddable: true });
    }
});
const _stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
// ── Skills (Anthropic Agent Skills format) ──────────────────────────────
//
// Mirrors electron/ipc/skills.ts. Walks .tron/skills, .agents/skills,
// .claude/skills, etc. under cwd + ~ for SKILL.md files; parses YAML
// front-matter (name, description) so the agent gets a discoverable
// list of available skills. Source-of-truth lives in electron/ipc/skills.ts;
// keep these in sync. Tested by hand — no shared module because the
// server lives in a separate tsconfig.
const SKILL_PARENT_DIRS = [
    ".tron/skills",
    ".agents/skills",
    ".claude/skills",
    ".codex/skills",
    ".cursor/skills",
    ".warp/skills",
    ".github/skills",
];
function _parseSkillFrontMatter(text) {
    if (!text.startsWith("---"))
        return {};
    const end = text.indexOf("\n---", 3);
    if (end < 0)
        return {};
    const body = text.slice(3, end).trim();
    const out = {};
    let collecting = null;
    let collected = "";
    for (const rawLine of body.split(/\r?\n/)) {
        const indented = /^\s+\S/.test(rawLine);
        if (indented && collecting) {
            collected += " " + rawLine.trim();
            continue;
        }
        if (collecting) {
            out[collecting] = collected.replace(/\s+/g, " ").trim();
            collecting = null;
            collected = "";
        }
        const m = rawLine.match(/^(\w+)\s*:\s*(.*)$/);
        if (!m)
            continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key !== "name" && key !== "description")
            continue;
        if (value === "" || value === ">" || value === "|") {
            collecting = key;
            collected = "";
            continue;
        }
        out[key] = value.replace(/^["']|["']$/g, "");
    }
    if (collecting)
        out[collecting] = collected.replace(/\s+/g, " ").trim();
    return out;
}
function _discoverInParent(parent, source) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const skillDir = path.join(parent, entry.name);
        const skillFile = ["SKILL.md", "skill.md", "Skill.md"]
            .map((n) => path.join(skillDir, n))
            .find((p) => fs.existsSync(p));
        if (!skillFile)
            continue;
        let content;
        try {
            content = fs.readFileSync(skillFile, "utf-8");
        }
        catch {
            continue;
        }
        const fm = _parseSkillFrontMatter(content);
        out.push({
            name: fm.name || entry.name,
            description: fm.description || "",
            path: skillFile,
            source,
        });
    }
    return out;
}
function discoverSkills(cwd) {
    const home = os.homedir();
    const projectRoot = cwd || process.cwd();
    const seen = new Map();
    for (const sub of SKILL_PARENT_DIRS) {
        for (const skill of _discoverInParent(path.join(projectRoot, sub), sub)) {
            if (!seen.has(skill.name))
                seen.set(skill.name, skill);
        }
    }
    for (const sub of SKILL_PARENT_DIRS) {
        for (const skill of _discoverInParent(path.join(home, sub), `~/${sub}`)) {
            if (!seen.has(skill.name))
                seen.set(skill.name, skill);
        }
    }
    return [...seen.values()];
}
function readSkill(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size > 256 * 1024) {
            return { success: false, error: `Skill file too large (${stat.size} bytes; max 256KB)` };
        }
        return { success: true, content: fs.readFileSync(filePath, "utf-8") };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
async function webSearchImpl(q) {
    if (!q)
        return { results: [] };
    // Try Brave Search first
    try {
        const resp = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(q)}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            signal: AbortSignal.timeout(8000),
            redirect: "follow",
        });
        const html = await resp.text();
        if (!html.includes("PoW Captcha") && !html.includes("captcha")) {
            const results = [];
            const blocks = html.split(/class="snippet\s+svelte/);
            for (const block of blocks.slice(1, 10)) {
                const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
                const titleMatch = block.match(/class="[^"]*snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/)
                    || block.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
                const descMatch = block.match(/class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/)
                    || block.match(/class="content[^"]*line-clamp[^"]*"[^>]*>([\s\S]*?)<\/div>/);
                if (urlMatch && titleMatch) {
                    const url = urlMatch[1];
                    const title = _stripTags(titleMatch[1]);
                    const snippet = descMatch ? _stripTags(descMatch[1]).slice(0, 300) : "";
                    if (title && !url.includes("brave.com") && !url.includes("imgs.search")) {
                        results.push({ title, url, snippet });
                    }
                }
                if (results.length >= 7)
                    break;
            }
            if (results.length > 0)
                return { results };
        }
    }
    catch { /* fall through to DDG */ }
    // Fallback: duck-duck-scrape
    try {
        const DDG = await import("duck-duck-scrape");
        const searchFn = DDG.search || DDG.default?.search;
        if (searchFn) {
            const data = await searchFn(q, { safeSearch: DDG.SafeSearchType?.MODERATE ?? 0 });
            const results = (data.results || []).slice(0, 7).map((r) => ({
                title: r.title || "", url: r.url || r.href || "",
                snippet: (r.description || r.body || "").slice(0, 300),
            }));
            if (results.length > 0)
                return { results };
        }
    }
    catch { /* fall through */ }
    // Fallback: Startpage (Google proxy)
    try {
        const spResp = await fetch("https://www.startpage.com/sp/search", {
            method: "POST",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `query=${encodeURIComponent(q)}&cat=web`,
            signal: AbortSignal.timeout(8000),
            redirect: "follow",
        });
        const spHtml = await spResp.text();
        const spResults = [];
        const spBlocks = spHtml.split(/class="result\s+css/);
        for (const block of spBlocks.slice(1, 10)) {
            const titleMatch = block.match(/class="result-title result-link[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
            const descMatch = block.match(/<p[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/p>/);
            if (titleMatch) {
                const url = titleMatch[1];
                const title = _stripTags(titleMatch[2]).replace(/\.css-[a-z0-9]+\{[^}]*\}(@media[^{]*\{[^}]*\})?\s*/g, "").replace(/^[{}]\s*/g, "").trim();
                const snippet = descMatch ? _stripTags(descMatch[1]).slice(0, 300) : "";
                if (title && !url.includes("startpage.com")) {
                    spResults.push({ title, url, snippet });
                }
            }
            if (spResults.length >= 7)
                break;
        }
        if (spResults.length > 0)
            return { results: spResults };
    }
    catch { /* fall through */ }
    return { results: [], error: "All search providers failed (rate limited). Try again later." };
}
async function webFetchImpl(url) {
    if (!url)
        return { content: "", error: "No URL provided" };
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return { content: "", error: "Only http/https URLs allowed" };
        }
        const resp = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,text/plain,application/json,*/*",
            },
            signal: AbortSignal.timeout(10000),
            redirect: "follow",
        });
        const contentType = resp.headers.get("content-type") || "";
        let text;
        if (contentType.includes("json")) {
            const json = await resp.json();
            text = JSON.stringify(json, null, 2);
        }
        else if (contentType.includes("html")) {
            const html = await resp.text();
            text = html
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/<style[\s\S]*?<\/style>/gi, "")
                .replace(/<nav[\s\S]*?<\/nav>/gi, "")
                .replace(/<header[\s\S]*?<\/header>/gi, "")
                .replace(/<footer[\s\S]*?<\/footer>/gi, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/&nbsp;/g, " ")
                .replace(/&amp;/g, "&")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, " ")
                .trim();
        }
        else {
            text = await resp.text();
        }
        const MAX_LEN = 15000;
        const isTruncated = text.length > MAX_LEN;
        return {
            content: isTruncated ? text.slice(0, MAX_LEN) + "\n...(truncated)" : text,
            url: resp.url,
            truncated: isTruncated,
        };
    }
    catch (err) {
        return { content: "", error: err.message };
    }
}
// HTTP endpoints (kept for backward compatibility / direct HTTP access)
app.get("/api/web-search", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(await webSearchImpl(req.query.q));
});
app.get("/api/web-fetch", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(await webFetchImpl(req.query.url));
});
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
    const targetBase = req.headers["x-target-base"];
    if (!targetBase) {
        res.status(400).json({ error: "Missing X-Target-Base header" });
        return;
    }
    let parsedBase;
    try {
        parsedBase = new URL(targetBase);
    }
    catch {
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
        const skipHeaders = new Set(["host", "connection", "keep-alive", "transfer-encoding", "x-target-base", "origin", "referer", "accept-encoding"]);
        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (!skipHeaders.has(key) && typeof value === "string") {
                headers[key] = value;
            }
        }
        const init = { method: req.method, headers };
        if (req.method !== "GET" && req.method !== "HEAD" && req.body && req.body.length > 0) {
            init.body = req.body.toString();
        }
        const response = await fetch(targetUrl, init);
        res.status(response.status);
        // Forward response headers
        for (const [key, value] of response.headers.entries()) {
            if (key !== "transfer-encoding" && key !== "connection" && key !== "content-encoding") {
                res.setHeader(key, value);
            }
        }
        // For streaming responses (SSE), flush headers immediately so the client
        // receives chunks in real-time instead of buffering until stream ends.
        const isStreaming = response.headers.get("content-type")?.includes("text/event-stream") ||
            response.headers.get("transfer-encoding") === "chunked";
        if (isStreaming) {
            res.flushHeaders();
        }
        if (response.body) {
            let readable;
            try {
                readable = Readable.fromWeb(response.body);
            }
            catch (err) {
                if (!res.headersSent) {
                    res.status(502).json({ error: "Stream conversion error" });
                }
                else if (!res.writableEnded) {
                    res.end();
                }
                return;
            }
            // Use pipeline() instead of pipe() for proper stream cleanup and error handling.
            // pipe() leaves streams in broken state on error; pipeline() destroys both ends.
            // This prevents server crashes when clients disconnect mid-stream (SSE/chunked).
            pipeline(readable, res, (err) => {
                if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                    console.error("[AI Proxy] Stream pipeline error:", err.message);
                }
            });
        }
        else {
            res.end();
        }
    }
    catch (e) {
        if (!res.headersSent) {
            res.status(502).json({ error: e.message || "Proxy error" });
        }
        else if (!res.writableEnded) {
            res.end();
        }
    }
});
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
    // In production, serve built React assets with caching
    const staticPath = path.join(__dirname, "../dist-react");
    // Hashed assets (JS/CSS) — immutable, cache for 1 year
    app.use("/assets", express.static(path.join(staticPath, "assets"), {
        maxAge: "1y",
        immutable: true,
    }));
    // Other static files (favicons, icons) — cache for 1 day
    app.use(express.static(staticPath, {
        maxAge: "1d",
        index: false, // Don't serve index.html from express.static (we handle it below)
    }));
    // SPA fallback — no cache for index.html so updates take effect immediately
    app.get("/{*path}", (_req, res) => {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.sendFile(path.join(staticPath, "index.html"));
    });
}
// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });
// Delayed cleanup map — cancel if client reconnects within grace period
const pendingCleanups = new Map();
// Track the current active WS per client so stale close events don't start cleanup
const activeConnections = new Map();
wss.on("connection", (ws, req) => {
    // Use persistent client token from URL query (survives reconnects) or fall back to random
    const wsUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const clientId = wsUrl.searchParams.get("token") || randomUUID();
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
    const pushEvent = (channel, data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "event", channel, data }));
        }
    };
    // Update pushEvent for all existing sessions owned by this client
    // (handles WS reconnect without page reload — e.g., mobile sleep/wake)
    terminal.updateClientPushEvent(clientId, pushEvent);
    ws.on("message", async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        const { type, id, channel, data } = msg;
        if (type === "ping") {
            // Heartbeat response — remote-bridge.ts sends these to detect zombie connections
            ws.send(JSON.stringify({ type: "pong" }));
        }
        else if (type === "invoke") {
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
        // If this client already has a newer active connection (page refresh race),
        // this is a stale close event — skip cleanup entirely.
        if (activeConnections.get(clientId) !== ws)
            return;
        activeConnections.delete(clientId);
        // Delay cleanup to allow page reload / reconnection within grace period
        pendingCleanups.set(clientId, setTimeout(() => {
            ssh.cleanupClientSSHSessions(clientId, terminal.getSessionOwners());
            terminal.cleanupClientSessions(clientId);
            pendingCleanups.delete(clientId);
            console.log(`[Tron Web] Cleaned up sessions for disconnected client ${clientId.slice(0, 8)}…`);
        }, 86400000)); // 24 hour grace period — keeps PTY alive for overnight disconnects
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
    "terminal.setHistory",
    "terminal.execInTerminal",
    "terminal.sessionExists",
    "terminal.checkCommand",
]);
/** Extract sessionId from invoke data for SSH-only validation. */
function extractSessionId(channel, data) {
    if (!data)
        return undefined;
    if (typeof data === "string")
        return data; // many channels pass sessionId as plain string
    if (data.sessionId)
        return data.sessionId;
    // terminal.checkCommand passes { command, sessionId? }
    if (channel === "terminal.checkCommand" && typeof data === "object")
        return data.sessionId;
    return undefined;
}
async function handleInvoke(channel, data, clientId, pushEvent) {
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
            return ssh.createSSHSession(data, clientId, pushEvent, terminal.getSessions(), terminal.getSessionHistory(), terminal.getSessionOwners());
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
                if (!fs.existsSync(savedTabsFile))
                    return [];
                return JSON.parse(fs.readFileSync(savedTabsFile, "utf-8"));
            }
            catch {
                return [];
            }
        case "savedTabs.write":
            try {
                ensureDataDir();
                fs.writeFileSync(savedTabsFile, JSON.stringify(data, null, 2), "utf-8");
                return true;
            }
            catch {
                return false;
            }
        case "remote.profiles.read":
            try {
                if (!fs.existsSync(remoteProfilesFile))
                    return [];
                return JSON.parse(fs.readFileSync(remoteProfilesFile, "utf-8"));
            }
            catch {
                return [];
            }
        case "remote.profiles.write":
            try {
                ensureDataDir();
                fs.writeFileSync(remoteProfilesFile, JSON.stringify(data, null, 2), "utf-8");
                return true;
            }
            catch {
                return false;
            }
        case "terminal.history.getStats":
            return terminal.getPersistedHistoryStats();
        case "terminal.history.clearAll":
            return terminal.clearAllPersistedHistory();
        case "terminal.readHistory":
            return terminal.readHistory(data?.sessionId || data, data?.lines);
        case "terminal.clearHistory":
            return terminal.clearHistory(typeof data === "string" ? data : data?.sessionId);
        case "terminal.setHistory":
            return terminal.setHistory(data?.sessionId, data?.history);
        case "terminal.execInTerminal":
            return terminal.execInTerminal(data.sessionId, data.command, pushEvent);
        case "terminal.scanCommands":
            return terminal.scanCommands();
        case "terminal.getShellHistory":
            return terminal.getShellHistory();
        case "web.search":
            return webSearchImpl(data?.query || "");
        case "web.fetch":
            return webFetchImpl(data?.url || "");
        case "skills.discover":
            return discoverSkills(data?.cwd);
        case "skills.read":
            return readSkill(data?.path || "");
        case "file.saveTempImage": {
            const tmpDir = path.join(os.tmpdir(), "tron-images");
            if (!fs.existsSync(tmpDir))
                fs.mkdirSync(tmpDir, { recursive: true });
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
            return terminal.listDir(data.dirPath, data.sessionId);
        case "file.searchDir":
            return terminal.searchDir(data.dirPath, data.query);
        case "log.saveSessionLog":
            return terminal.saveSessionLog(data);
        case "sessions.read":
            return clientSessions.get(clientId) || null;
        case "sessions.write": {
            // Merge top-level keys (allows multiple contexts to coexist: _layout, _agent, etc.)
            const existing = (clientSessions.get(clientId) || {});
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
        case "clipboard.readText": {
            // Server-side clipboard read — bypasses browser secure context requirement
            try {
                const platform = process.platform;
                if (platform === "darwin")
                    return execSync("pbpaste", { encoding: "utf-8", timeout: 2000 });
                if (platform === "linux")
                    return execSync("xclip -selection clipboard -o", { encoding: "utf-8", timeout: 2000 });
                if (platform === "win32")
                    return execSync("powershell -command Get-Clipboard", { encoding: "utf-8", timeout: 2000 });
                return "";
            }
            catch {
                return "";
            }
        }
        case "clipboard.readImage": {
            // Read image from system clipboard as base64 PNG
            try {
                const platform = process.platform;
                if (platform === "darwin") {
                    // osascript: write clipboard image to temp file, read as base64
                    const tmp = path.join(os.tmpdir(), `tron-clip-${Date.now()}.png`);
                    try {
                        execSync(`osascript -e 'set img to the clipboard as «class PNGf»' -e 'set fp to open for access POSIX file "${tmp}" with write permission' -e 'write img to fp' -e 'close access fp'`, { timeout: 3000 });
                        const buf = fs.readFileSync(tmp);
                        fs.unlinkSync(tmp);
                        return buf.toString("base64");
                    }
                    catch {
                        try {
                            fs.unlinkSync(tmp);
                        }
                        catch { }
                        return null;
                    }
                }
                if (platform === "linux") {
                    const buf = execSync("xclip -selection clipboard -t image/png -o", { timeout: 2000, encoding: "buffer" });
                    return buf.toString("base64");
                }
                if (platform === "win32") {
                    const buf = execSync('powershell -command "[Convert]::ToBase64String([System.Windows.Forms.Clipboard]::GetImage().Save([System.IO.MemoryStream]::new(), [System.Drawing.Imaging.ImageFormat]::Png).ToArray())"', { encoding: "utf-8", timeout: 3000 });
                    return buf.trim() || null;
                }
                return null;
            }
            catch {
                return null;
            }
        }
        case "clipboard.writeText": {
            try {
                const text = typeof data === "string" ? data : data?.text || "";
                const platform = process.platform;
                if (platform === "darwin")
                    execSync("pbcopy", { input: text, timeout: 2000 });
                else if (platform === "linux")
                    execSync("xclip -selection clipboard", { input: text, timeout: 2000 });
                else if (platform === "win32")
                    execSync("powershell -command Set-Clipboard", { input: text, timeout: 2000 });
                return true;
            }
            catch {
                return false;
            }
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
function handleSend(channel, data) {
    // SSH-only mode: only allow send channels for SSH sessions
    if (sshOnly) {
        const sid = data?.id || (typeof data === "string" ? data : undefined);
        if (!sid || !ssh.sshSessionIds.has(sid))
            return; // silently drop
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
server.listen(PORT, HOST, () => {
    console.log(`[Tron Web] Server running on http://${HOST}:${PORT}`);
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
// Prevent server crashes from unhandled stream/network errors — log and continue.
// Fatal startup errors (e.g. EADDRINUSE) should still crash.
let serverStarted = false;
server.on("listening", () => { serverStarted = true; });
process.on("uncaughtException", (err) => {
    if (!serverStarted) {
        console.error("[Tron Web] Fatal startup error:", err.message);
        process.exit(1);
    }
    console.error("[Tron Web] Uncaught exception (keeping server alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
    console.error("[Tron Web] Unhandled rejection:", reason);
});
//# sourceMappingURL=index.js.map