"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForwardManager = void 0;
exports.validateForwardSpec = validateForwardSpec;
exports.toPersistedSpec = toPersistedSpec;
exports.sameForwardSpec = sameForwardSpec;
exports.preserveProfileForwards = preserveProfileForwards;
exports.missingRememberedForwards = missingRememberedForwards;
exports.parseSocks5Greeting = parseSocks5Greeting;
exports.parseSocks5Request = parseSocks5Request;
exports.socks5Reply = socks5Reply;
exports.listenOnFreePort = listenOnFreePort;
// SSH port forwarding core (-L local, -R remote, -D dynamic/SOCKS5).
// server/handlers/sshForward.ts is an exact copy (the two tsconfigs can't share
// a file); src/__tests__/sshForwardCore.test.ts fails if they drift.
const net_1 = __importDefault(require("net"));
const LOOPBACK = "127.0.0.1";
const PORT_SEARCH_SPAN = 10;
const DEFAULT_SOCKS_PORT = 1080;
const FORWARD_TYPES = ["local", "remote", "dynamic"];
const HOST_RE = /^[A-Za-z0-9._:\-[\]]+$/;
function validPort(v, allowZero) {
    return typeof v === "number" && Number.isInteger(v) && v <= 65535 && (allowZero ? v >= 0 : v > 0);
}
/** Normalize untrusted IPC input into a ForwardSpec, or return an error message. */
function validateForwardSpec(input) {
    const raw = (input || {});
    const type = raw.type;
    if (!FORWARD_TYPES.includes(type))
        return `Unknown forward type: ${String(raw.type)}`;
    if (raw.localPort !== undefined && !validPort(raw.localPort, false))
        return "Local port must be 1–65535";
    if (raw.remoteHost !== undefined && (typeof raw.remoteHost !== "string" || !HOST_RE.test(raw.remoteHost))) {
        return "Invalid host";
    }
    const localPort = raw.localPort;
    if (type === "dynamic")
        return localPort ? { type, localPort } : { type };
    if (type === "local") {
        if (!validPort(raw.remotePort, false))
            return "Remote port must be 1–65535";
        const spec = { type, remoteHost: raw.remoteHost || "localhost", remotePort: raw.remotePort };
        if (localPort)
            spec.localPort = localPort;
        return spec;
    }
    if (!validPort(raw.remotePort ?? 0, true))
        return "Remote port must be 0–65535";
    if (!localPort)
        return "Local port must be 1–65535";
    return { type, remoteHost: raw.remoteHost || LOOPBACK, remotePort: raw.remotePort ?? 0, localPort };
}
/** What a profile stores to recreate a forward on the next connect. */
function toPersistedSpec(r) {
    if (r.type === "dynamic")
        return r.requestedLocalPort ? { type: "dynamic", localPort: r.requestedLocalPort } : { type: "dynamic" };
    if (r.type === "remote")
        return { type: "remote", localPort: r.localPort, remoteHost: r.remoteHost, remotePort: r.remotePort };
    const spec = { type: "local", remoteHost: r.remoteHost, remotePort: r.remotePort };
    if (r.requestedLocalPort)
        spec.localPort = r.requestedLocalPort;
    return spec;
}
function sameForwardSpec(a, b) {
    if (a.type !== b.type)
        return false;
    if (a.type === "dynamic")
        return a.localPort === b.localPort;
    if (a.type === "remote")
        return a.remotePort === b.remotePort && a.localPort === b.localPort;
    return a.remoteHost === b.remoteHost && a.remotePort === b.remotePort;
}
/**
 * Renderer profile saves rebuild each profile field by field and know nothing
 * about remembered forwards — carry them over unless the caller set the list.
 */
function preserveProfileForwards(existing, incoming) {
    const saved = new Map(existing.map((p) => [p.id, p.forwards]));
    return incoming.map((p) => (p.forwards !== undefined || !saved.get(p.id) ? p : { ...p, forwards: saved.get(p.id) }));
}
/** Remembered forwards no live session of the profile runs yet — each runs once per profile. */
function missingRememberedForwards(specs, live) {
    return specs.filter((s) => !live.some((r) => sameForwardSpec(s, toPersistedSpec(r))));
}
function parseSocks5Greeting(buf) {
    if (buf.length < 2)
        return { ok: false, need: true };
    if (buf[0] !== 0x05)
        return { ok: false, error: `unsupported SOCKS version ${buf[0]}` };
    const n = buf[1];
    if (buf.length < 2 + n)
        return { ok: false, need: true };
    return { ok: true, consumed: 2 + n, methods: [...buf.subarray(2, 2 + n)] };
}
function parseSocks5Request(buf) {
    if (buf.length < 4)
        return { ok: false, need: true };
    if (buf[0] !== 0x05)
        return { ok: false, error: `unsupported SOCKS version ${buf[0]}`, replyCode: 0x01 };
    const cmd = buf[1];
    const atyp = buf[3];
    let host;
    let offset;
    if (atyp === 0x01) {
        if (buf.length < 10)
            return { ok: false, need: true };
        host = [...buf.subarray(4, 8)].join(".");
        offset = 8;
    }
    else if (atyp === 0x03) {
        if (buf.length < 5)
            return { ok: false, need: true };
        const len = buf[4];
        if (buf.length < 5 + len + 2)
            return { ok: false, need: true };
        host = buf.subarray(5, 5 + len).toString("utf-8");
        offset = 5 + len;
    }
    else if (atyp === 0x04) {
        if (buf.length < 22)
            return { ok: false, need: true };
        const groups = [];
        for (let i = 0; i < 16; i += 2)
            groups.push(buf.readUInt16BE(4 + i).toString(16));
        host = groups.join(":");
        offset = 20;
    }
    else {
        return { ok: false, error: `unsupported address type ${atyp}`, replyCode: 0x08 };
    }
    return { ok: true, consumed: offset + 2, cmd, host, port: buf.readUInt16BE(offset) };
}
function socks5Reply(code) {
    return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}
// ---------------------------------------------------------------------------
function tryListen(server, port) {
    return new Promise((resolve) => {
        const onError = () => {
            server.off("listening", onListening);
            resolve(null);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve(server.address().port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, LOOPBACK);
    });
}
/** Whether something already answers on host:port. */
function answers(port, host) {
    return new Promise((resolve) => {
        const sock = net_1.default.connect({ port, host });
        const done = (v) => {
            sock.destroy();
            resolve(v);
        };
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
        sock.setTimeout(300, () => done(false));
    });
}
/**
 * Listen on loopback: the preferred port, else a nearby free one, else any.
 * A port some local server already answers on (over ::1, or a wildcard bind
 * SO_REUSEADDR would let us share) is skipped so a forward never shadows it.
 */
async function listenOnFreePort(server, preferred) {
    if (preferred && preferred > 0) {
        for (let p = preferred; p < preferred + PORT_SEARCH_SPAN && p <= 65535; p++) {
            if ((await answers(p, LOOPBACK)) || (await answers(p, "::1")))
                continue;
            const bound = await tryListen(server, p);
            if (bound !== null)
                return bound;
        }
    }
    const bound = await tryListen(server, 0);
    if (bound === null)
        throw new Error("no free local port");
    return bound;
}
function pipeBoth(sock, ch) {
    sock.pipe(ch).pipe(sock);
    sock.on("error", () => ch.close());
    ch.on("error", () => sock.destroy());
}
function specKey(spec) {
    return spec.type === "local" ? `local ${spec.remoteHost || "localhost"}:${spec.remotePort}` : JSON.stringify(spec);
}
class ForwardManager {
    constructor(onChange) {
        this.sessions = new Map();
        this.closedSessions = new Set();
        this.inflight = new Map();
        this.routedClients = new WeakSet();
        this.remoteSockets = new Map();
        this.nextId = 1;
        this.onChange = onChange;
    }
    list(sessionId) {
        return (this.sessions.get(sessionId) || []).map((e) => ({ ...e.record }));
    }
    async add(sessionId, client, spec, opts = {}) {
        // Identical requests in flight (a double click) share one listener.
        const key = `${sessionId} ${specKey(spec)}`;
        let pending = this.inflight.get(key);
        if (!pending) {
            pending = this.create(sessionId, client, spec, opts).finally(() => this.inflight.delete(key));
            this.inflight.set(key, pending);
        }
        const record = await pending;
        if (opts.persist)
            this.markPersisted(sessionId, record.id);
        return this.list(sessionId).find((r) => r.id === record.id) ?? record;
    }
    async create(sessionId, client, spec, opts) {
        if (spec.type === "local") {
            const host = spec.remoteHost || "localhost";
            const existing = this.sessions.get(sessionId)?.find((e) => e.record.type === "local" &&
                e.record.status === "active" &&
                e.record.remoteHost === host &&
                e.record.remotePort === spec.remotePort);
            if (existing)
                return { ...existing.record };
        }
        const entry = spec.type === "local"
            ? await this.startLocal(client, spec)
            : spec.type === "remote"
                ? await this.startRemote(client, spec)
                : await this.startDynamic(client, spec);
        if (this.closedSessions.has(sessionId)) {
            entry.close();
            return { ...entry.record, status: "error", error: "SSH session closed" };
        }
        entry.record.persist = opts.persist || undefined;
        if (spec.localPort)
            entry.record.requestedLocalPort = spec.localPort;
        // Re-read after the await: concurrent adds for one session must all land
        // in the same list, not overwrite each other's copy.
        const entries = this.sessions.get(sessionId) || [];
        entries.push(entry);
        this.sessions.set(sessionId, entries);
        this.emit(sessionId);
        return { ...entry.record };
    }
    markPersisted(sessionId, id) {
        const entry = this.sessions.get(sessionId)?.find((e) => e.record.id === id);
        if (!entry || entry.record.persist)
            return;
        entry.record.persist = true;
        this.emit(sessionId);
    }
    remove(sessionId, id) {
        const entries = this.sessions.get(sessionId);
        const idx = entries?.findIndex((e) => e.record.id === id) ?? -1;
        if (!entries || idx < 0)
            return false;
        const [entry] = entries.splice(idx, 1);
        entry.close();
        this.emit(sessionId);
        return true;
    }
    closeSession(sessionId) {
        this.closedSessions.add(sessionId);
        const entries = this.sessions.get(sessionId);
        if (!entries)
            return;
        this.sessions.delete(sessionId);
        for (const e of entries)
            e.close();
        this.emit(sessionId);
    }
    emit(sessionId) {
        this.onChange(sessionId, this.list(sessionId));
    }
    newRecord(partial) {
        return { id: `fwd-${this.nextId++}-${Math.random().toString(36).slice(2, 6)}`, ...partial };
    }
    async startLocal(client, spec) {
        const remoteHost = spec.remoteHost || "localhost";
        const remotePort = spec.remotePort ?? 0;
        const sockets = new Set();
        const server = net_1.default.createServer((sock) => {
            sockets.add(sock);
            sock.on("close", () => sockets.delete(sock));
            // Before forwardOut: a reset during the SSH round trip would otherwise be
            // an unhandled 'error' that takes down the Electron main process.
            sock.on("error", () => sock.destroy());
            client.forwardOut(sock.remoteAddress || LOOPBACK, sock.remotePort || 0, remoteHost, remotePort, (err, ch) => {
                if (err)
                    return sock.destroy();
                pipeBoth(sock, ch);
            });
        });
        const close = () => {
            server.close();
            for (const s of sockets)
                s.destroy();
        };
        try {
            const localPort = await listenOnFreePort(server, spec.localPort || remotePort);
            const record = this.newRecord({ type: "local", localHost: LOOPBACK, localPort, remoteHost, remotePort, status: "active" });
            return { record, client, close };
        }
        catch (e) {
            close();
            const record = this.newRecord({
                type: "local", localHost: LOOPBACK, localPort: spec.localPort || 0, remoteHost, remotePort,
                status: "error", error: e.message,
            });
            return { record, client, close: () => { } };
        }
    }
    async startDynamic(client, spec) {
        const sockets = new Set();
        const server = net_1.default.createServer((sock) => {
            sockets.add(sock);
            sock.on("close", () => sockets.delete(sock));
            sock.on("error", () => sock.destroy());
            let buf = Buffer.alloc(0);
            let phase = "greeting";
            const onData = (d) => {
                buf = Buffer.concat([buf, d]);
                if (phase === "greeting") {
                    const g = parseSocks5Greeting(buf);
                    if (!g.ok) {
                        if ("error" in g)
                            sock.destroy();
                        return;
                    }
                    buf = buf.subarray(g.consumed);
                    if (!g.methods.includes(0x00)) {
                        sock.end(Buffer.from([0x05, 0xff]));
                        return;
                    }
                    sock.write(Buffer.from([0x05, 0x00]));
                    phase = "request";
                }
                const r = parseSocks5Request(buf);
                if (!r.ok) {
                    if ("error" in r)
                        sock.end(socks5Reply(r.replyCode));
                    return;
                }
                sock.off("data", onData);
                // Removing the listener doesn't stop a flowing stream: pause so bytes
                // sent before the tunnel opens wait for the pipe instead of vanishing.
                sock.pause();
                if (r.cmd !== 0x01) {
                    sock.end(socks5Reply(0x07));
                    return;
                }
                const rest = buf.subarray(r.consumed);
                client.forwardOut(LOOPBACK, 0, r.host, r.port, (err, ch) => {
                    if (err) {
                        sock.end(socks5Reply(0x05));
                        return;
                    }
                    sock.write(socks5Reply(0x00));
                    if (rest.length)
                        ch.write(rest);
                    pipeBoth(sock, ch);
                });
            };
            sock.on("data", onData);
        });
        const close = () => {
            server.close();
            for (const s of sockets)
                s.destroy();
        };
        const localPort = await listenOnFreePort(server, spec.localPort || DEFAULT_SOCKS_PORT);
        const record = this.newRecord({ type: "dynamic", localHost: LOOPBACK, localPort, remoteHost: "", remotePort: 0, status: "active" });
        return { record, client, close };
    }
    async startRemote(client, spec) {
        const bindAddr = spec.remoteHost || LOOPBACK;
        const localPort = spec.localPort ?? 0;
        this.ensureRemoteRouting(client);
        const sockets = new Set();
        const result = await new Promise((resolve) => {
            client.forwardIn(bindAddr, spec.remotePort ?? 0, (err, port) => {
                if (err)
                    resolve({ error: err.message });
                else
                    resolve({ port: port || spec.remotePort || 0 });
            });
        });
        if ("error" in result) {
            const record = this.newRecord({
                type: "remote", localHost: LOOPBACK, localPort, remoteHost: bindAddr, remotePort: spec.remotePort ?? 0,
                status: "error", error: result.error,
            });
            return { record, client, close: () => { } };
        }
        const record = this.newRecord({
            type: "remote", localHost: LOOPBACK, localPort, remoteHost: bindAddr, remotePort: result.port, status: "active",
        });
        const close = () => {
            try {
                client.unforwardIn(bindAddr, result.port, () => { });
            }
            catch { /* connection already gone */ }
            for (const s of sockets)
                s.destroy();
            this.remoteSockets.delete(record.id);
        };
        this.remoteSockets.set(record.id, sockets);
        return { record, client, close };
    }
    /** One `tcp connection` listener per client routes -R traffic by bound port. */
    ensureRemoteRouting(client) {
        if (this.routedClients.has(client))
            return;
        this.routedClients.add(client);
        client.on("tcp connection", (info, accept, reject) => {
            const entry = [...this.sessions.values()]
                .flat()
                .find((e) => e.client === client && e.record.type === "remote" && e.record.status === "active" && e.record.remotePort === info.destPort);
            if (!entry) {
                reject();
                return;
            }
            const ch = accept();
            const sock = net_1.default.connect(entry.record.localPort, entry.record.localHost);
            this.remoteSockets.get(entry.record.id)?.add(sock);
            sock.on("close", () => this.remoteSockets.get(entry.record.id)?.delete(sock));
            pipeBoth(sock, ch);
        });
    }
}
exports.ForwardManager = ForwardManager;
//# sourceMappingURL=sshForward.js.map