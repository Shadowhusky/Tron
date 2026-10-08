/**
 * Claude Code / Codex CLIs as agent backends — process side.
 *
 * Drives the user's installed `claude` / `codex` in headless mode so a pane can
 * use their Pro/Max or ChatGPT plan. The CLI keeps its own login; Tron never
 * reads or forwards OAuth tokens. Mirrored byte-for-byte in server/handlers/.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildClaudeArgs,
  buildClaudeUserMessage,
  buildCodexArgs,
  buildCompleteArgs,
  extractCompletion,
  IMAGE_TYPES,
  JsonLineSplitter,
  MAX_PROMPT_CHARS,
  parseClaudeAuth,
  parseCodexLogin,
  parseVersion,
  validateControlResponse,
  validateStartOptions,
  type CliKind,
  type Json,
} from "./cliAgentProtocol.js";

// ---- Process management -----------------------------------------------------

export interface CliRunEvent {
  runId: string;
  message?: unknown;
  exit?: number | null;
  stderrTail?: string;
}

export interface CliDetection {
  path: string;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
}

interface Run {
  kind: CliKind;
  child: ChildProcess;
  owner?: string;
  tempFiles: string[];
}

let loginEnvPromise: Promise<{ path: string; bins: Record<CliKind, string | null> }> | null = null;

/** GUI-launched Electron has a truncated PATH; ask the user's login+interactive
 *  shell once (stdin closed, so rc-file prompts can't hang it). */
function loginEnv() {
  if (!loginEnvPromise) {
    loginEnvPromise = (async () => {
      if (process.platform === "win32") return { path: process.env.PATH || "", bins: { claude: "claude", codex: "codex" } };
      const script =
        `printf '\\n__TRON_PATH__%s\\n' "$PATH"; ` +
        `printf '__TRON_BIN_claude__%s\\n' "$(command -v claude 2>/dev/null)"; ` +
        `printf '__TRON_BIN_codex__%s\\n' "$(command -v codex 2>/dev/null)"`;
      const { stdout } = await run(process.env.SHELL || "/bin/bash", ["-lic", script], { timeoutMs: 10_000 });
      const pick = (marker: string) => stdout.match(new RegExp(`${marker}(.*)`))?.[1]?.trim() || null;
      const bin = (k: CliKind) => {
        const p = pick(`__TRON_BIN_${k}__`);
        return p && path.isAbsolute(p) ? p : null;
      };
      return { path: pick("__TRON_PATH__") || process.env.PATH || "", bins: { claude: bin("claude"), codex: bin("codex") } };
    })().catch(() => {
      loginEnvPromise = null;
      return { path: process.env.PATH || "", bins: { claude: null, codex: null } };
    });
  }
  return loginEnvPromise;
}

function childEnv(loginPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: loginPath };
  // Nested-session markers (Tron launched from a Claude Code shell) and the
  // web server's node-mode flag must not leak into the CLI.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string; input?: string },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export class CliAgentManager {
  private runs = new Map<string, Run>();

  async detect(): Promise<Record<CliKind, CliDetection | null>> {
    const env = await loginEnv();
    const one = async (kind: CliKind): Promise<CliDetection | null> => {
      const bin = env.bins[kind];
      if (!bin) return null;
      const childenv = childEnv(env.path);
      const ver = await run(bin, ["--version"], { timeoutMs: 10_000, env: childenv });
      if (ver.code === null) return null;
      const auth = kind === "claude"
        ? await run(bin, ["auth", "status"], { timeoutMs: 10_000, env: childenv })
        : await run(bin, ["login", "status"], { timeoutMs: 10_000, env: childenv });
      const status = kind === "claude"
        ? parseClaudeAuth(auth.stdout)
        : parseCodexLogin(auth.stdout + auth.stderr, auth.code);
      return { path: bin, version: parseVersion(ver.stdout), ...status };
    };
    const [claude, codex] = await Promise.all([one("claude"), one("codex")]);
    return { claude, codex };
  }

  async start(raw: unknown, emit: (ev: CliRunEvent) => void, owner?: string): Promise<{ ok: true }> {
    const o = validateStartOptions(raw);
    if (this.runs.has(o.runId)) throw new Error("Run already exists");
    const env = await loginEnv();
    const bin = env.bins[o.kind];
    if (!bin) {
      throw new Error(
        o.kind === "claude"
          ? "Claude Code CLI not found. Install it, then run `claude` once to sign in."
          : "Codex CLI not found. Install it, then run `codex login`.",
      );
    }

    const tempFiles: string[] = [];
    if (o.kind === "codex" && o.images?.length) {
      const dir = path.join(os.tmpdir(), "tron-cli-images");
      await fsp.mkdir(dir, { recursive: true });
      for (const [i, img] of o.images.entries()) {
        const file = path.join(dir, `${o.runId}-${i}.${IMAGE_TYPES[img.mediaType]}`);
        await fsp.writeFile(file, Buffer.from(img.base64, "base64"));
        tempFiles.push(file);
      }
    }

    const args = o.kind === "claude"
      ? buildClaudeArgs(o)
      : buildCodexArgs({ ...o, imagePaths: tempFiles });
    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: childEnv(env.path),
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const entry: Run = { kind: o.kind, child, owner, tempFiles };
    this.runs.set(o.runId, entry);

    const splitter = new JsonLineSplitter();
    let stderrTail = "";
    const write = (obj: unknown) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(JSON.stringify(obj) + "\n");
    };
    const handle = (msg: Json) => {
      if (o.kind === "claude" && msg?.type === "control_request" && msg.request?.subtype !== "can_use_tool") {
        // We register no hooks / MCP servers, so nothing else should ask —
        // answer anyway so the CLI never waits on us.
        write({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "Not supported by Tron" } });
        return;
      }
      emit({ runId: o.runId, message: msg });
      if (o.kind === "claude" && msg?.type === "result") child.stdin?.end();
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => splitter.push(d).forEach(handle));
    child.stderr?.on("data", (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });
    child.stdin?.on("error", () => { /* child exited first */ });
    child.on("error", (err) => {
      stderrTail = (stderrTail + "\n" + err.message).slice(-2000);
    });
    child.on("close", (code) => {
      splitter.flush().forEach(handle);
      this.runs.delete(o.runId);
      for (const f of tempFiles) fsp.unlink(f).catch(() => {});
      emit({ runId: o.runId, exit: code, stderrTail: stderrTail.trim() });
    });

    if (o.kind === "claude") {
      write({ type: "control_request", request_id: `init-${o.runId}`, request: { subtype: "initialize" } });
      write(buildClaudeUserMessage(o.prompt, o.images));
    } else {
      child.stdin?.end(o.prompt);
    }
    return { ok: true };
  }

  respond(raw: unknown): boolean {
    const o = (raw ?? {}) as { runId?: unknown; response?: unknown };
    const entry = typeof o.runId === "string" ? this.runs.get(o.runId) : undefined;
    if (!entry || entry.kind !== "claude") return false;
    const clean = validateControlResponse(o.response);
    if (!clean || !entry.child.stdin || entry.child.stdin.destroyed) return false;
    entry.child.stdin.write(JSON.stringify(clean) + "\n");
    return true;
  }

  stop(runId: unknown): boolean {
    const entry = typeof runId === "string" ? this.runs.get(runId) : undefined;
    if (!entry) return false;
    entry.child.kill("SIGINT");
    setTimeout(() => {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGTERM");
    }, 2000);
    return true;
  }

  /** Kill every run, or only those started by one web client. */
  stopAll(owner?: string) {
    for (const [id, entry] of this.runs) {
      if (owner === undefined || entry.owner === owner) {
        entry.child.kill("SIGTERM");
        this.runs.delete(id);
      }
    }
  }

  async complete(raw: unknown): Promise<string | null> {
    const o = (raw ?? {}) as { kind?: unknown; prompt?: unknown };
    if ((o.kind !== "claude" && o.kind !== "codex") || typeof o.prompt !== "string" || o.prompt.length > MAX_PROMPT_CHARS) {
      return null;
    }
    const env = await loginEnv();
    const bin = env.bins[o.kind];
    if (!bin) return null;
    const res = await run(bin, buildCompleteArgs(o.kind), {
      timeoutMs: 60_000,
      env: childEnv(env.path),
      cwd: os.tmpdir(),
      input: o.prompt,
    });
    return extractCompletion(o.kind, res.stdout);
  }
}
