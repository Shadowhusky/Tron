/**
 * Renderer side of a Claude Code / Codex run: starts it over IPC, normalizes
 * the stream, answers Claude's permission requests, and stops it on abort.
 */
import { IPC } from "../../../constants/ipc";
import { createClaudeNormalizer, createCodexNormalizer, type CliAgentEvent } from "./normalize";
import { CLI_AGENT_PROVIDERS, type CliAgentProvider, type CliKind } from "./providers";

export interface CliPermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  description?: string;
}

export interface CliRunOptions {
  provider: CliAgentProvider;
  prompt: string;
  cwd: string;
  mode: string;
  model?: string;
  resumeId?: string;
  images?: { base64: string; mediaType: string }[];
  signal: AbortSignal;
  onEvent: (ev: CliAgentEvent) => void;
  requestPermission: (req: CliPermissionRequest) => Promise<boolean>;
}

export interface CliRunResult {
  text: string;
  isError: boolean;
  aborted: boolean;
  sessionId?: string;
}

interface RunEventPayload {
  runId: string;
  message?: unknown;
  exit?: number | null;
  stderrTail?: string;
}

function ipc() {
  const r = window.electron?.ipcRenderer;
  if (!r?.invoke || !r?.on) throw new Error("CLI agents need the Tron app or its web server.");
  return r;
}

/** One-line description for Tron's permission prompt. */
export function describePermission(provider: CliAgentProvider, req: CliPermissionRequest): string {
  const who = CLI_AGENT_PROVIDERS[provider].shortLabel;
  const i = req.input;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (req.tool) {
    case "Bash": return s(i.command);
    case "Write": return `${who} wants to write ${s(i.file_path)}`;
    case "Edit": case "MultiEdit": return `${who} wants to edit ${s(i.file_path)}`;
    case "NotebookEdit": return `${who} wants to edit ${s(i.notebook_path)}`;
    case "WebFetch": return `${who} wants to fetch ${s(i.url)}`;
    default: return `${who} wants to use ${req.tool}${req.description ? `: ${req.description}` : ""}`;
  }
}

export function runCliAgent(o: CliRunOptions): Promise<CliRunResult> {
  const r = ipc();
  const kind: CliKind = CLI_AGENT_PROVIDERS[o.provider].kind;
  const normalize = kind === "claude" ? createClaudeNormalizer() : createCodexNormalizer();
  const runId = crypto.randomUUID();

  return new Promise<CliRunResult>((resolve, reject) => {
    let result: Extract<CliAgentEvent, { type: "result" }> | null = null;
    let sessionId: string | undefined;
    let aborted = false;

    const answer = async (requestId: string, req: CliPermissionRequest) => {
      let allowed = false;
      try {
        allowed = await o.requestPermission(req);
      } catch {
        allowed = false;
      }
      const response = allowed
        ? { behavior: "allow", updatedInput: req.input }
        : { behavior: "deny", message: "The user denied this action in Tron." };
      await r.invoke(IPC.CLI_AGENT_RESPOND, {
        runId,
        response: { type: "control_response", response: { subtype: "success", request_id: requestId, response } },
      }).catch(() => {});
    };

    const off = r.on(IPC.CLI_AGENT_EVENT, (payload: RunEventPayload) => {
      if (payload?.runId !== runId) return;
      if (payload.message !== undefined) {
        for (const ev of normalize(payload.message)) {
          if (ev.type === "session") sessionId = ev.id;
          if (ev.type === "result") {
            result = ev;
            sessionId = ev.sessionId ?? sessionId;
          }
          if (ev.type === "permission") void answer(ev.requestId, { tool: ev.tool, input: ev.input, description: ev.description });
          o.onEvent(ev);
        }
      }
      if (payload.exit !== undefined) {
        off?.();
        if (aborted) return resolve({ text: "", isError: false, aborted: true, sessionId });
        if (result) return resolve({ text: result.text, isError: result.isError, aborted: false, sessionId });
        const label = CLI_AGENT_PROVIDERS[o.provider].shortLabel;
        const detail = payload.stderrTail?.split("\n").filter(Boolean).slice(-3).join("\n");
        reject(new Error(`${label} exited (code ${payload.exit ?? "?"}) without finishing${detail ? `:\n${detail}` : ""}`));
      }
    });

    o.signal.addEventListener("abort", () => {
      aborted = true;
      r.invoke(IPC.CLI_AGENT_STOP, runId).catch(() => {});
    }, { once: true });

    r.invoke(IPC.CLI_AGENT_START, {
      runId,
      kind,
      prompt: o.prompt,
      cwd: o.cwd,
      mode: o.mode,
      model: o.model,
      resumeId: o.resumeId,
      images: o.images,
    }).catch((err: Error) => {
      off?.();
      reject(err);
    });
  });
}

export interface CliDetection {
  path: string;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
}

export async function detectCliAgents(): Promise<Record<CliKind, CliDetection | null>> {
  try {
    return await ipc().invoke(IPC.CLI_AGENT_DETECT);
  } catch {
    return { claude: null, codex: null };
  }
}

/** One-shot, tool-less answer (advice mode, titles, summaries). Null on failure. */
export async function cliComplete(provider: CliAgentProvider, prompt: string): Promise<string | null> {
  try {
    return await ipc().invoke(IPC.CLI_AGENT_COMPLETE, { kind: CLI_AGENT_PROVIDERS[provider].kind, prompt });
  } catch {
    return null;
  }
}
