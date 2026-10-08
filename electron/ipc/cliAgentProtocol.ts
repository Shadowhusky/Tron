/**
 * Claude Code / Codex CLIs as agent backends — the pure protocol half:
 * validation, argument building, stream parsing. No imports at all, so vitest
 * covers it and server/handlers/ can mirror it byte-for-byte (rootDir
 * isolation prevents a shared import; a test asserts the copies stay equal).
 */
export type CliKind = "claude" | "codex";

/** Parsed CLI JSON — shapes are validated field by field where it matters. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export const CLAUDE_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
export const CODEX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

const MODEL_RE = /^[A-Za-z0-9][\w.:/[\]-]{0,99}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
export const MAX_PROMPT_CHARS = 400_000;
const MAX_IMAGES = 8;

export interface CliImage {
  base64: string;
  mediaType: string;
}

export interface CliStartOptions {
  runId: string;
  kind: CliKind;
  prompt: string;
  cwd: string;
  mode: string;
  model?: string;
  resumeId?: string;
  images?: CliImage[];
}

/** Validate untrusted renderer input. Nothing a renderer sends becomes a flag. */
export function validateStartOptions(raw: unknown): CliStartOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "claude" && kind !== "codex") throw new Error("Unknown CLI agent");
  if (typeof o.runId !== "string" || !/^[\w-]{1,64}$/.test(o.runId)) throw new Error("Invalid run id");
  if (typeof o.prompt !== "string" || o.prompt.length > MAX_PROMPT_CHARS) throw new Error("Invalid prompt");
  if (typeof o.cwd !== "string" || !/^(\/|[A-Za-z]:[\\/])/.test(o.cwd)) {
    throw new Error("Working directory must be an absolute path");
  }
  const modes: readonly string[] = kind === "claude" ? CLAUDE_MODES : CODEX_MODES;
  if (typeof o.mode !== "string" || !modes.includes(o.mode)) throw new Error(`Invalid mode for ${kind}`);
  const out: CliStartOptions = { runId: o.runId, kind, prompt: o.prompt, cwd: o.cwd, mode: o.mode };
  if (o.model !== undefined && o.model !== null && o.model !== "") {
    if (typeof o.model !== "string" || !MODEL_RE.test(o.model)) throw new Error("Invalid model name");
    out.model = o.model;
  }
  if (o.resumeId !== undefined && o.resumeId !== null && o.resumeId !== "") {
    if (typeof o.resumeId !== "string" || !UUID_RE.test(o.resumeId)) throw new Error("Invalid session id");
    out.resumeId = o.resumeId;
  }
  if (o.images !== undefined) {
    if (!Array.isArray(o.images) || o.images.length > MAX_IMAGES) throw new Error("Invalid images");
    out.images = o.images.map((img) => {
      const i = (img ?? {}) as Record<string, unknown>;
      if (typeof i.mediaType !== "string" || !IMAGE_TYPES[i.mediaType] || typeof i.base64 !== "string") {
        throw new Error("Unsupported image");
      }
      return { base64: i.base64, mediaType: i.mediaType };
    });
  }
  return out;
}

const withModel = (model?: string) => (model && model !== "default" ? ["--model", model] : []);

export function buildClaudeArgs(o: { mode: string; model?: string; resumeId?: string; trusted: boolean }): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    "--permission-mode", o.mode,
    // Tron can't render its questions; Claude asks in plain text instead.
    "--disallowedTools", "AskUserQuestion",
    // -p skips the trust dialog, so an untrusted folder's hooks would run
    // unprompted (verified on 2.1.294) — load only the user's own settings.
    ...(o.trusted ? [] : ["--setting-sources", "user"]),
    ...withModel(o.model),
    ...(o.resumeId ? ["--resume", o.resumeId] : []),
  ];
}

/** Claude Code trusts a folder once its trust dialog was accepted there or in a parent. */
export function isTrustedDir(projects: unknown, dir: string): boolean {
  if (!projects || typeof projects !== "object") return false;
  const p = projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
  let d = dir.replace(/[\\/]+$/, "");
  while (d) {
    if (p[d]?.hasTrustDialogAccepted === true) return true;
    const parent = d.replace(/[\\/][^\\/]*$/, "");
    if (parent === d) break;
    d = parent;
  }
  return false;
}

/** `command -v` output → an absolute binary path (handles the legacy `alias claude=…` install). */
export function parseCommandV(out: string, home: string): string | null {
  const line = out.trim().split("\n")[0]?.trim() ?? "";
  const alias = /^alias\s+[\w.-]+=(['"]?)(.+)\1$/.exec(line);
  const target = (alias ? alias[2].trim().split(/\s+/)[0] : line).replace(/^~(?=\/)/, home);
  return target.startsWith("/") ? target : null;
}

/** Pick a spawnable binary from `where` output: a real .exe, else a .cmd/.bat shim (needs cmd.exe). */
export function pickWindowsBinary(whereOut: string): { path: string; viaShell: boolean } | null {
  const lines = whereOut.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z]:[\\/]/.test(l));
  const exe = lines.find((l) => /\.exe$/i.test(l));
  if (exe) return { path: exe, viaShell: false };
  const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l));
  return shim ? { path: shim, viaShell: true } : null;
}

/** Quote one argument for a cmd.exe command line. `%` would expand even inside quotes, so refuse it. */
export function quoteCmdArg(arg: string): string {
  if (/[%\r\n]/.test(arg)) throw new Error("Argument can't be passed through cmd.exe safely");
  return `"${arg.replace(/"/g, '""')}"`;
}

export function buildCodexArgs(o: { mode: string; model?: string; resumeId?: string; imagePaths?: string[] }): string[] {
  const opts = [
    "--json",
    "--skip-git-repo-check",
    "-c", `sandbox_mode="${o.mode}"`,
    ...(o.model && o.model !== "default" ? ["-m", o.model] : []),
    ...(o.imagePaths ?? []).flatMap((p) => ["--image", p]),
  ];
  // `--` ends options so the multi-value --image can't swallow the positionals;
  // `-` makes codex read the prompt from stdin.
  return o.resumeId ? ["exec", "resume", ...opts, "--", o.resumeId, "-"] : ["exec", ...opts, "--", "-"];
}

export function buildClaudeUserMessage(prompt: string, images: CliImage[] = []) {
  return {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: [
        ...images.map((img) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
        })),
        { type: "text" as const, text: prompt },
      ],
    },
    parent_tool_use_id: null,
  };
}

/** Only a well-formed permission answer may reach a claude run's stdin. */
export function validateControlResponse(raw: unknown): Record<string, unknown> | null {
  const o = (raw ?? {}) as Json;
  if (o.type !== "control_response") return null;
  const r = o.response ?? {};
  if (r.subtype !== "success" || typeof r.request_id !== "string" || r.request_id.length > 200) return null;
  const answer = r.response ?? {};
  let clean: Record<string, unknown>;
  if (answer.behavior === "allow") {
    clean = { behavior: "allow" };
    if (answer.updatedInput && typeof answer.updatedInput === "object" && !Array.isArray(answer.updatedInput)) {
      clean.updatedInput = answer.updatedInput;
    }
  } else if (answer.behavior === "deny" && typeof answer.message === "string") {
    clean = { behavior: "deny", message: answer.message.slice(0, 2000) };
  } else {
    return null;
  }
  return { type: "control_response", response: { subtype: "success", request_id: r.request_id, response: clean } };
}

/** Splits a byte stream into JSON objects. Non-JSON lines (rc-file noise) are dropped. */
export class JsonLineSplitter {
  private buf = "";

  push(chunk: string): Json[] {
    this.buf += chunk;
    const out: Json[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const parsed = parseJsonLine(line);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }

  flush(): Json[] {
    const rest = this.buf;
    this.buf = "";
    const parsed = parseJsonLine(rest);
    return parsed === undefined ? [] : [parsed];
  }
}

function parseJsonLine(line: string): Json | undefined {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export function parseVersion(out: string): string | null {
  return out.match(/\b(\d+\.\d+\.\d+(?:[-.][\w.]+)?)\b/)?.[1] ?? null;
}

export function parseClaudeAuth(out: string): { loggedIn: boolean; authMethod: string | null } {
  try {
    const j = JSON.parse(out);
    return { loggedIn: !!j.loggedIn, authMethod: typeof j.authMethod === "string" ? j.authMethod : null };
  } catch {
    return { loggedIn: false, authMethod: null };
  }
}

export function parseCodexLogin(out: string, exitCode: number | null): { loggedIn: boolean; authMethod: string | null } {
  const m = out.match(/Logged in using (.+)/i);
  if (exitCode !== 0 || !m) return { loggedIn: false, authMethod: null };
  // "an API key - sk-…" must never reach the UI.
  const method = /api key/i.test(m[1]) ? "API key" : m[1].trim();
  return { loggedIn: true, authMethod: method };
}

/** One-shot, tool-less completion — advice mode, tab titles, summaries. */
export function buildCompleteArgs(kind: CliKind): string[] {
  return kind === "claude"
    ? ["-p", "--output-format", "json", "--model", "haiku", "--tools", "", "--restricted", "--strict-mcp-config", "--no-session-persistence"]
    : ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "--ephemeral", "--", "-"];
}

export function extractCompletion(kind: CliKind, stdout: string): string | null {
  const objs = new JsonLineSplitter().push(stdout + "\n");
  if (kind === "claude") {
    const r = objs.find((o) => o.type === "result");
    return r && !r.is_error && typeof r.result === "string" ? r.result.trim() : null;
  }
  let last: string | null = null;
  for (const o of objs) {
    if (o.type === "item.completed" && o.item?.type === "agent_message" && typeof o.item.text === "string") {
      last = o.item.text.trim();
    }
  }
  return last;
}
