/**
 * Renderer side of a Claude Code / Codex run: starts it over IPC, normalizes
 * the stream, answers Claude's permission requests, and stops it on abort.
 */
import { IPC } from "../../../constants/ipc";
import { onConnectionChange } from "../../ws-bridge";
import { isElectronApp } from "../../../utils/platform";
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
  /** Asked one request at a time. `signal` aborts if the CLI withdraws it. */
  requestPermission: (req: CliPermissionRequest, signal?: AbortSignal) => Promise<boolean>;
  /** Web mode: the run lives on the server — a dropped socket loses it. */
  watchConnection?: (cb: (connected: boolean) => void) => () => void;
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
  notice?: string;
  exit?: number | null;
  stderrTail?: string;
}

function ipc() {
  const r = window.electron?.ipcRenderer;
  if (!r?.invoke || !r?.on) throw new Error("CLI agents need the Tron app or its web server.");
  return r;
}

const defaultWatchConnection = (cb: (connected: boolean) => void) =>
  isElectronApp() ? () => {} : onConnectionChange(cb);

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
    case "ExitPlanMode": return `${who}: approve the plan above and start implementing?`;
    default: return `${who} wants to use ${req.tool}${req.description ? `: ${req.description}` : ""}`;
  }
}

export function runCliAgent(o: CliRunOptions): Promise<CliRunResult> {
  const r = ipc();
  const kind: CliKind = CLI_AGENT_PROVIDERS[o.provider].kind;
  const normalize = kind === "claude" ? createClaudeNormalizer() : createCodexNormalizer();
  // randomUUID only exists in secure contexts — not for http://<LAN-ip> web clients.
  const runId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

  return new Promise<CliRunResult>((resolve, reject) => {
    let result: Extract<CliAgentEvent, { type: "result" }> | null = null;
    let sessionId: string | undefined;
    let aborted = false;
    let settled = false;
    /** Plan mode: the plan Claude tried to leave plan mode with — the answer. */
    let planText: string | null = null;
    // Permission prompts are shown one at a time (Tron has a single prompt slot).
    let queue: Promise<void> = Promise.resolve();
    const pending = new Map<string, AbortController>();

    const respond = (requestId: string, response: Record<string, unknown>) =>
      r.invoke(IPC.CLI_AGENT_RESPOND, {
        runId,
        response: { type: "control_response", response: { subtype: "success", request_id: requestId, response } },
      }).catch(() => {});

    const answer = async (requestId: string, req: CliPermissionRequest, cancel: AbortController) => {
      if (aborted || cancel.signal.aborted) return;
      if (req.tool === "ExitPlanMode") {
        const plan = typeof req.input.plan === "string" ? req.input.plan.trim() : "";
        if (o.mode === "plan") {
          // "Plan only" must never start implementing: keep the plan as the answer.
          planText = plan || planText;
          await respond(requestId, {
            behavior: "deny",
            message: "Tron is in plan-only mode: the user will review this plan. Do not implement anything; end your turn.",
          });
          return;
        }
        if (plan) o.onEvent({ type: "text", text: `**Proposed plan**\n\n${plan}` });
      }
      let allowed = false;
      try {
        allowed = await o.requestPermission(req, cancel.signal);
      } catch {
        allowed = false;
      }
      if (aborted || cancel.signal.aborted) return; // withdrawn or stopped — nobody is waiting
      await respond(
        requestId,
        allowed ? { behavior: "allow", updatedInput: req.input } : { behavior: "deny", message: "The user denied this action in Tron." },
      );
    };

    let unwatch: () => void = () => {};
    const cleanup = () => {
      settled = true;
      off?.();
      unwatch();
      for (const c of pending.values()) c.abort();
      pending.clear();
    };
    const fail = (err: Error) => {
      if (settled) return;
      cleanup();
      reject(err);
    };

    const off = r.on(IPC.CLI_AGENT_EVENT, (payload: RunEventPayload) => {
      if (payload?.runId !== runId || settled) return;
      // After Stop only the exit matters — late deltas or prompts would land
      // after the "Stopped" marker.
      if (!aborted && payload.notice) o.onEvent({ type: "notice", text: payload.notice });
      if (!aborted && payload.message !== undefined) {
        for (let ev of normalize(payload.message)) {
          if (ev.type === "session") sessionId = ev.id;
          if (ev.type === "result") {
            if (planText) ev = { ...ev, text: planText, isError: false };
            result = ev;
            sessionId = ev.sessionId ?? sessionId;
          }
          if (ev.type === "permission") {
            const cancel = new AbortController();
            pending.set(ev.requestId, cancel);
            const { requestId } = ev;
            const req = { tool: ev.tool, input: ev.input, description: ev.description };
            queue = queue.then(() => answer(requestId, req, cancel)).finally(() => pending.delete(requestId));
            continue;
          }
          if (ev.type === "permission_cancel") {
            pending.get(ev.requestId)?.abort();
            continue;
          }
          o.onEvent(ev);
        }
      }
      if (payload.exit !== undefined) {
        cleanup();
        if (aborted) return resolve({ text: "", isError: false, aborted: true, sessionId });
        if (result) return resolve({ text: result.text, isError: result.isError, aborted: false, sessionId });
        const label = CLI_AGENT_PROVIDERS[o.provider].shortLabel;
        const detail = payload.stderrTail?.split("\n").filter(Boolean).slice(-3).join("\n");
        reject(new Error(`${label} exited (code ${payload.exit ?? "?"}) without finishing${detail ? `:\n${detail}` : ""}`));
      }
    });

    let wasConnected = false;
    unwatch = (o.watchConnection ?? defaultWatchConnection)((connected) => {
      if (connected) wasConnected = true;
      else if (wasConnected) fail(new Error("Lost the connection to the Tron server, so this run was stopped."));
    });

    o.signal.addEventListener("abort", () => {
      aborted = true;
      for (const c of pending.values()) c.abort();
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
    }).catch((err: Error) => fail(err));
  });
}

export interface CliDetection {
  path: string;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
}

/** `force` re-resolves the CLIs (Settings "Check again" after installing one). */
export async function detectCliAgents(force = false): Promise<Record<CliKind, CliDetection | null>> {
  try {
    return await ipc().invoke(IPC.CLI_AGENT_DETECT, force);
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
