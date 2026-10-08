"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliAgentManager = void 0;
/**
 * Claude Code / Codex CLIs as agent backends — process side.
 *
 * Drives the user's installed `claude` / `codex` in headless mode so a pane can
 * use their Pro/Max or ChatGPT plan. The CLI keeps its own login; Tron never
 * reads or forwards OAuth tokens. Mirrored byte-for-byte in server/handlers/.
 */
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const cliAgentProtocol_js_1 = require("./cliAgentProtocol.js");
const isWin = process.platform === "win32";
const RESOLVE_TTL_MS = 30000;
/** Install locations to try when the login shell's PATH doesn't have the CLI. */
function fallbackPaths(kind) {
    const home = node_os_1.default.homedir();
    const common = [
        node_path_1.default.join(home, ".local/bin", kind),
        `/opt/homebrew/bin/${kind}`,
        `/usr/local/bin/${kind}`,
        node_path_1.default.join(home, ".npm-global/bin", kind),
        node_path_1.default.join(home, ".bun/bin", kind),
    ];
    return kind === "claude"
        ? [node_path_1.default.join(home, ".claude/local/claude"), ...common]
        : [...common, node_path_1.default.join(home, ".codex/packages/standalone/current/bin/codex")];
}
async function firstExecutable(paths) {
    for (const p of paths) {
        try {
            await node_fs_1.promises.access(p, node_fs_1.constants.X_OK);
            return p;
        }
        catch { /* try the next one */ }
    }
    return null;
}
/** GUI-launched Electron has a truncated PATH; ask the user's login+interactive
 *  shell (stdin closed, so rc-file prompts can't hang it). */
async function resolveLoginEnv() {
    if (isWin) {
        const pick = async (kind) => (0, cliAgentProtocol_js_1.pickWindowsBinary)((await run("where", [kind], { timeoutMs: 10000 })).stdout);
        const [claude, codex] = await Promise.all([pick("claude"), pick("codex")]);
        return { path: process.env.PATH || "", bins: { claude, codex } };
    }
    const script = `printf '\\n__TRON_PATH__%s\\n' "$PATH"; ` +
        `printf '__TRON_BIN_claude__%s\\n' "$(command -v claude 2>/dev/null)"; ` +
        `printf '__TRON_BIN_codex__%s\\n' "$(command -v codex 2>/dev/null)"`;
    const { stdout } = await run(process.env.SHELL || "/bin/bash", ["-lic", script], { timeoutMs: 10000 });
    const pick = (marker) => stdout.match(new RegExp(`${marker}(.*)`))?.[1]?.trim() || "";
    const bin = async (k) => {
        const found = (0, cliAgentProtocol_js_1.parseCommandV)(pick(`__TRON_BIN_${k}__`), node_os_1.default.homedir()) ?? (await firstExecutable(fallbackPaths(k)));
        return found ? { path: found, viaShell: false } : null;
    };
    const [claude, codex] = await Promise.all([bin("claude"), bin("codex")]);
    return { path: pick("__TRON_PATH__") || process.env.PATH || "", bins: { claude, codex } };
}
function childEnv(loginPath) {
    const env = { ...process.env, PATH: loginPath };
    // Nested-session markers (Tron launched from a Claude Code shell) and the
    // web server's node-mode flag must not leak into the CLI.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.ELECTRON_RUN_AS_NODE;
    // An API key in Tron's environment would bill usage to the API instead of
    // the user's subscription plan — the whole point of these providers.
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return env;
}
function spawnCli(bin, args, opts) {
    const stdio = [opts.stdin, "pipe", "pipe"];
    if (bin.viaShell) {
        // windowsVerbatimArguments: we quoted every argument for cmd.exe ourselves.
        const line = [bin.path, ...args].map(cliAgentProtocol_js_1.quoteCmdArg).join(" ");
        return (0, node_child_process_1.spawn)(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
            cwd: opts.cwd, env: opts.env, stdio, windowsVerbatimArguments: true,
        });
    }
    return (0, node_child_process_1.spawn)(bin.path, args, { cwd: opts.cwd, env: opts.env, stdio });
}
/** Signal the CLI and everything it started (Windows: taskkill /T /F). */
function killTree(child, signal) {
    if (isWin && child.pid) {
        (0, node_child_process_1.spawn)("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => { });
        return;
    }
    try {
        child.kill(signal);
    }
    catch { /* already gone */ }
}
const isRunning = (child) => child.exitCode === null && child.signalCode === null;
function run(cmd, args, opts, bin) {
    return new Promise((resolve) => {
        let settled = false;
        let stdout = "";
        let stderr = "";
        const done = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code });
        };
        const env = opts.env ?? process.env;
        const stdin = opts.input === undefined ? "ignore" : "pipe";
        const child = bin
            ? spawnCli(bin, args, { cwd: opts.cwd, env, stdin })
            : (0, node_child_process_1.spawn)(cmd, args, { cwd: opts.cwd, env, stdio: [stdin, "pipe", "pipe"] });
        // Interactive shells ignore SIGTERM, and a grandchild can hold stdout open
        // — settle on the timer instead of waiting for "close".
        const timer = setTimeout(() => {
            killTree(child, "SIGKILL");
            done(null);
        }, opts.timeoutMs);
        child.stdout?.on("data", (d) => (stdout += d));
        child.stderr?.on("data", (d) => (stderr += d));
        child.stdin?.on("error", () => { });
        child.on("error", () => done(null));
        child.on("close", (code) => done(code));
        if (opts.input !== undefined)
            child.stdin?.end(opts.input);
    });
}
function removeTempDir(dir) {
    if (!dir)
        return;
    try {
        (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
    }
    catch { /* best effort */ }
}
async function readClaudeProjects() {
    const file = node_path_1.default.join(process.env.CLAUDE_CONFIG_DIR || node_os_1.default.homedir(), ".claude.json");
    try {
        return JSON.parse(await node_fs_1.promises.readFile(file, "utf8"))?.projects;
    }
    catch {
        return undefined;
    }
}
class CliAgentManager {
    constructor(resolveEnv = resolveLoginEnv) {
        this.runs = new Map();
        this.cached = null;
        this.inflight = null;
        this.resolveEnv = resolveEnv;
    }
    /** Cached, but a missing CLI is re-checked (it may have been installed since). */
    async loginEnv(force = false) {
        const c = this.cached;
        const complete = c && c.env.bins.claude && c.env.bins.codex;
        if (!force && c && (complete || Date.now() - c.at < RESOLVE_TTL_MS))
            return c.env;
        if (!this.inflight) {
            this.inflight = this.resolveEnv()
                .catch(() => ({ path: process.env.PATH || "", bins: { claude: null, codex: null } }))
                .then((env) => {
                this.cached = { env, at: Date.now() };
                this.inflight = null;
                return env;
            });
        }
        return this.inflight;
    }
    async detect(force = false) {
        const env = await this.loginEnv(force);
        const one = async (kind) => {
            const bin = env.bins[kind];
            if (!bin)
                return null;
            const childenv = childEnv(env.path);
            const ver = await run(bin.path, ["--version"], { timeoutMs: 10000, env: childenv }, bin);
            if (ver.code !== 0)
                return null;
            const auth = kind === "claude"
                ? await run(bin.path, ["auth", "status"], { timeoutMs: 10000, env: childenv }, bin)
                : await run(bin.path, ["login", "status"], { timeoutMs: 10000, env: childenv }, bin);
            const status = kind === "claude"
                ? (0, cliAgentProtocol_js_1.parseClaudeAuth)(auth.stdout)
                : (0, cliAgentProtocol_js_1.parseCodexLogin)(auth.stdout + auth.stderr, auth.code);
            return { path: bin.path, version: (0, cliAgentProtocol_js_1.parseVersion)(ver.stdout), ...status };
        };
        const [claude, codex] = await Promise.all([one("claude"), one("codex")]);
        return { claude, codex };
    }
    async start(raw, emit, owner) {
        const o = (0, cliAgentProtocol_js_1.validateStartOptions)(raw);
        if (this.runs.has(o.runId))
            throw new Error("Run already exists");
        // Registered before any await so a Stop that arrives while we resolve the
        // binary or write images cancels the run instead of being lost.
        const entry = { kind: o.kind, owner, child: null, cancelled: false, tempDir: null };
        this.runs.set(o.runId, entry);
        const abandon = () => {
            this.runs.delete(o.runId);
            removeTempDir(entry.tempDir);
        };
        let bin;
        let env;
        let trusted = true;
        try {
            env = await this.loginEnv();
            if (!env.bins[o.kind])
                env = await this.loginEnv(true);
            const found = env.bins[o.kind];
            if (!found) {
                throw new Error(o.kind === "claude"
                    ? "Claude Code CLI not found. Install it, then run `claude` once to sign in."
                    : "Codex CLI not found. Install it, then run `codex login`.");
            }
            bin = found;
            try {
                if (!(await node_fs_1.promises.stat(o.cwd)).isDirectory())
                    throw new Error();
            }
            catch {
                throw new Error(`The pane's folder doesn't exist: ${o.cwd}`);
            }
            if (o.kind === "claude")
                trusted = (0, cliAgentProtocol_js_1.isTrustedDir)(await readClaudeProjects(), o.cwd);
            if (o.kind === "codex" && o.images?.length) {
                entry.tempDir = await node_fs_1.promises.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "tron-cli-"));
                await node_fs_1.promises.chmod(entry.tempDir, 0o700);
            }
            const imagePaths = [];
            for (const [i, img] of (o.kind === "codex" ? o.images ?? [] : []).entries()) {
                const file = node_path_1.default.join(entry.tempDir, `${i}.${cliAgentProtocol_js_1.IMAGE_TYPES[img.mediaType]}`);
                await node_fs_1.promises.writeFile(file, Buffer.from(img.base64, "base64"), { mode: 0o600 });
                imagePaths.push(file);
            }
            if (entry.cancelled) {
                abandon();
                emit({ runId: o.runId, exit: null, stderrTail: "" });
                return { ok: true };
            }
            const args = o.kind === "claude"
                ? (0, cliAgentProtocol_js_1.buildClaudeArgs)({ ...o, trusted })
                : (0, cliAgentProtocol_js_1.buildCodexArgs)({ ...o, imagePaths });
            entry.child = spawnCli(bin, args, { cwd: o.cwd, env: childEnv(env.path), stdin: "pipe" });
        }
        catch (err) {
            abandon();
            throw err;
        }
        const child = entry.child;
        if (!trusted && !o.resumeId) {
            emit({
                runId: o.runId,
                notice: "This folder isn't trusted in Claude Code yet, so its project settings and hooks were skipped. Run `claude` there once and accept the trust prompt to enable them.",
            });
        }
        const splitter = new cliAgentProtocol_js_1.JsonLineSplitter();
        let stderrTail = "";
        const write = (obj) => {
            if (child.stdin && !child.stdin.destroyed)
                child.stdin.write(JSON.stringify(obj) + "\n");
        };
        const handle = (msg) => {
            if (o.kind === "claude" &&
                msg?.type === "control_request" &&
                msg.request?.subtype !== "can_use_tool") {
                // We register no hooks / MCP servers, so nothing else should ask —
                // answer anyway so the CLI never waits on us.
                write({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "Not supported by Tron" } });
                return;
            }
            emit({ runId: o.runId, message: msg });
            if (o.kind === "claude" && msg?.type === "result")
                child.stdin?.end();
        };
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (d) => splitter.push(d).forEach(handle));
        child.stderr?.on("data", (d) => {
            stderrTail = (stderrTail + d).slice(-2000);
        });
        child.stdin?.on("error", () => { });
        child.on("error", (err) => {
            stderrTail = (stderrTail + "\n" + err.message).slice(-2000);
        });
        child.on("close", (code) => {
            splitter.flush().forEach(handle);
            if (this.runs.get(o.runId) === entry)
                this.runs.delete(o.runId);
            removeTempDir(entry.tempDir);
            emit({ runId: o.runId, exit: code, stderrTail: stderrTail.trim() });
        });
        if (o.kind === "claude") {
            write({ type: "control_request", request_id: `init-${o.runId}`, request: { subtype: "initialize" } });
            write((0, cliAgentProtocol_js_1.buildClaudeUserMessage)(o.prompt, o.images));
        }
        else {
            child.stdin?.end(o.prompt);
        }
        return { ok: true };
    }
    respond(raw) {
        const o = (raw ?? {});
        const entry = typeof o.runId === "string" ? this.runs.get(o.runId) : undefined;
        if (!entry?.child || entry.kind !== "claude")
            return false;
        const clean = (0, cliAgentProtocol_js_1.validateControlResponse)(o.response);
        const stdin = entry.child.stdin;
        if (!clean || !stdin || stdin.destroyed)
            return false;
        stdin.write(JSON.stringify(clean) + "\n");
        return true;
    }
    stop(runId) {
        const entry = typeof runId === "string" ? this.runs.get(runId) : undefined;
        if (!entry)
            return false;
        entry.cancelled = true;
        const child = entry.child;
        if (!child)
            return true; // start() sees the flag and never spawns
        killTree(child, "SIGINT");
        setTimeout(() => { if (isRunning(child))
            killTree(child, "SIGTERM"); }, 2000);
        setTimeout(() => { if (isRunning(child))
            killTree(child, "SIGKILL"); }, 5000);
        return true;
    }
    /** Kill every run, or only those started by one renderer / web client. */
    stopAll(owner) {
        for (const [id, entry] of this.runs) {
            if (owner !== undefined && entry.owner !== owner)
                continue;
            entry.cancelled = true;
            const child = entry.child;
            if (child) {
                killTree(child, "SIGTERM");
                setTimeout(() => { if (isRunning(child))
                    killTree(child, "SIGKILL"); }, 2000);
            }
            removeTempDir(entry.tempDir);
            this.runs.delete(id);
        }
    }
    async complete(raw) {
        const o = (raw ?? {});
        if ((o.kind !== "claude" && o.kind !== "codex") || typeof o.prompt !== "string" || o.prompt.length > cliAgentProtocol_js_1.MAX_PROMPT_CHARS) {
            return null;
        }
        const env = await this.loginEnv();
        const bin = env.bins[o.kind];
        if (!bin)
            return null;
        const res = await run(bin.path, (0, cliAgentProtocol_js_1.buildCompleteArgs)(o.kind), {
            timeoutMs: 60000,
            env: childEnv(env.path),
            cwd: node_os_1.default.tmpdir(),
            input: o.prompt,
        }, bin);
        return (0, cliAgentProtocol_js_1.extractCompletion)(o.kind, res.stdout);
    }
}
exports.CliAgentManager = CliAgentManager;
//# sourceMappingURL=cliAgentCore.js.map