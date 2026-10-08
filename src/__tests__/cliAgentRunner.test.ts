import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCliAgent, type CliPermissionRequest, type CliRunOptions } from "../services/ai/cliAgent/runner";
import type { CliAgentEvent } from "../services/ai/cliAgent/normalize";

type Payload = { runId?: string; message?: unknown; exit?: number | null; stderrTail?: string };

/** Stand-in for window.electron.ipcRenderer, recording what the runner sends. */
function fakeIpc() {
  const listeners = new Set<(p: Payload) => void>();
  const invokes: Array<{ channel: string; data: unknown }> = [];
  let runId = "";
  const ipcRenderer = {
    invoke: async (channel: string, data?: unknown) => {
      invokes.push({ channel, data });
      if (channel === "cliAgent.start") runId = (data as { runId: string }).runId;
      return { ok: true };
    },
    on: (_channel: string, cb: (p: Payload) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const send = (p: Payload) => listeners.forEach((l) => l({ runId, ...p }));
  const responses = () =>
    invokes
      .filter((i) => i.channel === "cliAgent.respond")
      .map((i) => (i.data as { response: { response: { request_id: string; response: { behavior: string } } } }).response.response);
  return { ipcRenderer, invokes, send, responses };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const permissionRequest = (id: string, tool = "Write", input: Record<string, unknown> = { file_path: `/${id}` }) => ({
  message: { type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input } },
});
const result = (text: string) => ({ message: { type: "result", subtype: "success", is_error: false, result: text, session_id: "s-1" } });

let ipc: ReturnType<typeof fakeIpc>;

function start(over: Partial<CliRunOptions> = {}) {
  const events: CliAgentEvent[] = [];
  const controller = new AbortController();
  const promise = runCliAgent({
    provider: "claude-code",
    prompt: "do it",
    cwd: "/tmp",
    mode: "default",
    signal: controller.signal,
    onEvent: (ev) => events.push(ev),
    requestPermission: async () => true,
    watchConnection: () => () => {},
    ...over,
  });
  return { events, controller, promise };
}

beforeEach(() => {
  ipc = fakeIpc();
  (globalThis as unknown as { window: unknown }).window = { electron: { ipcRenderer: ipc.ipcRenderer } };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("runCliAgent", () => {
  it("asks about concurrent permission requests one at a time and answers each", async () => {
    const asked: string[] = [];
    const answers: Array<(ok: boolean) => void> = [];
    const run = start({
      requestPermission: (req: CliPermissionRequest) => {
        asked.push(String(req.input.file_path));
        return new Promise<boolean>((resolve) => answers.push(resolve));
      },
    });
    ipc.send(permissionRequest("p1"));
    ipc.send(permissionRequest("p2"));
    await tick();
    expect(asked).toEqual(["/p1"]); // the second waits its turn
    answers[0](true);
    await tick();
    await tick();
    expect(asked).toEqual(["/p1", "/p2"]);
    answers[1](false);
    await tick();
    await tick();
    expect(ipc.responses().map((r) => [r.request_id, r.response.behavior])).toEqual([["p1", "allow"], ["p2", "deny"]]);
    ipc.send(result("ok"));
    ipc.send({ exit: 0 });
    await expect(run.promise).resolves.toMatchObject({ text: "ok", aborted: false });
  });

  it("drops a request the CLI cancels, including one already on screen", async () => {
    const asked: string[] = [];
    let shownSignal: AbortSignal | undefined;
    const run = start({
      requestPermission: (req, signal) => {
        asked.push(String(req.input.file_path));
        shownSignal = signal;
        return new Promise<boolean>((resolve) => signal?.addEventListener("abort", () => resolve(false)));
      },
    });
    ipc.send(permissionRequest("p1"));
    ipc.send(permissionRequest("p2"));
    await tick();
    ipc.send({ message: { type: "control_cancel_request", request_id: "p2" } }); // still queued
    ipc.send({ message: { type: "control_cancel_request", request_id: "p1" } }); // on screen
    await tick();
    await tick();
    expect(shownSignal?.aborted).toBe(true);
    expect(asked).toEqual(["/p1"]);
    expect(ipc.responses()).toEqual([]); // nothing answered for withdrawn requests
    ipc.send({ exit: 0 });
    await run.promise.catch(() => {});
  });

  it("ignores everything after Stop except the exit", async () => {
    let asked = 0;
    const run = start({ requestPermission: async () => { asked++; return true; } });
    ipc.send({ message: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } } });
    run.controller.abort();
    ipc.send({ message: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } } });
    ipc.send(permissionRequest("late"));
    await tick();
    expect(run.events).toEqual([{ type: "text_delta", text: "Hel" }]);
    expect(asked).toBe(0);
    expect(ipc.invokes.some((i) => i.channel === "cliAgent.stop")).toBe(true);
    ipc.send({ exit: null });
    await expect(run.promise).resolves.toMatchObject({ aborted: true });
  });

  it("rejects when the CLI exits without a result", async () => {
    const run = start();
    ipc.send({ exit: 1, stderrTail: "No conversation found with session ID x" });
    await expect(run.promise).rejects.toThrow(/exited \(code 1\) without finishing:\nNo conversation found/);
  });

  it("in plan mode, refuses to leave plan mode and answers with the plan", async () => {
    let asked = 0;
    const run = start({ mode: "plan", requestPermission: async () => { asked++; return true; } });
    ipc.send(permissionRequest("x1", "ExitPlanMode", { plan: "1. Do A\n2. Do B" }));
    await tick();
    await tick();
    expect(asked).toBe(0);
    expect(ipc.responses()[0]).toMatchObject({ request_id: "x1", response: { behavior: "deny" } });
    ipc.send(result("User declined"));
    ipc.send({ exit: 0 });
    await expect(run.promise).resolves.toMatchObject({ text: "1. Do A\n2. Do B", isError: false });
    expect(run.events.at(-1)).toMatchObject({ type: "result", text: "1. Do A\n2. Do B" });
  });

  it("outside plan mode, shows the plan before asking to approve it", async () => {
    const order: string[] = [];
    const run = start({
      onEvent: (ev) => { if (ev.type === "text") order.push(`text:${ev.text}`); },
      requestPermission: async (req) => { order.push(`ask:${req.tool}`); return true; },
    });
    ipc.send(permissionRequest("x2", "ExitPlanMode", { plan: "Refactor the parser" }));
    await tick();
    await tick();
    expect(order).toEqual(["text:**Proposed plan**\n\nRefactor the parser", "ask:ExitPlanMode"]);
    ipc.send({ exit: 0 });
    await run.promise.catch(() => {});
  });

  it("fails the run when the server connection drops", async () => {
    let report!: (connected: boolean) => void;
    const run = start({ watchConnection: (cb) => { report = cb; cb(true); return () => {}; } });
    report(false);
    await expect(run.promise).rejects.toThrow(/connection to the Tron server/);
  });

  it("does not treat an initially-disconnected report as a drop", async () => {
    const run = start({ watchConnection: (cb) => { cb(false); return () => {}; } });
    ipc.send(result("fine"));
    ipc.send({ exit: 0 });
    await expect(run.promise).resolves.toMatchObject({ text: "fine" });
  });
});
