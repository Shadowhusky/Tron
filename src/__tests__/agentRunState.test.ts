import { describe, it, expect, afterEach } from "vitest";
import { aiService } from "../services/ai/index";
import type { AIConfig } from "../types";

/**
 * End-to-end checks that the agent's run state — which used to be six mutable
 * locals written from ~43 places and is now a fold over an append-only log —
 * still drives the loop identically through a real `runAgent` call.
 *
 * These exercise the projection through its consumers (auto-cd's project root,
 * the completion guard's "did any work happen" test) rather than the fold
 * directly, so a regression in the wiring is caught, not just in the fold.
 */

type Msg = { role: string; content: unknown };
type Stubbable = {
  streamOpenAIChat: (...a: unknown[]) => Promise<{ content: string; thinking: string }>;
  arbitrateAgentLoop: () => Promise<{ stuck: boolean; suggestion: string }>;
};
const svc = aiService as unknown as Stubbable;

const CFG: AIConfig = {
  provider: "lmstudio",
  model: "fake",
  baseUrl: "http://localhost:1234",
  maxAgentSteps: 40,
};

const prevWindow = (globalThis as Record<string, unknown>).window;
afterEach(() => { (globalThis as Record<string, unknown>).window = prevWindow; });

/** Stub the IPC surface the SSH file path and web tools use. */
function stubWindow(overrides: Record<string, (arg: any) => any> = {}) {
  (globalThis as Record<string, unknown>).window = {
    dispatchEvent() {},
    electron: {
      ipcRenderer: {
        invoke: async (channel: string, arg: any) => {
          if (overrides[channel]) return overrides[channel](arg);
          if (channel === "terminal.exec") return { exitCode: 0, stdout: "", stderr: "" };
          if (channel === "terminal.getCwd") return "/proj";
          if (channel === "web.search") return { results: [{ title: "t", url: "u", snippet: "s" }] };
          if (channel === "web.fetch") return { content: "a".repeat(200) };
          return {};
        },
      },
    },
  };
}

/** Drive runAgent with a scripted model, capturing executed commands and steps. */
async function runScripted(
  replies: string[],
  opts: { task?: string; isSSH?: boolean } = {},
) {
  const executed: string[] = [];
  const pushed: string[] = [];
  let n = 0;
  svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
  svc.streamOpenAIChat = async (...a: unknown[]) => {
    for (const m of a[3] as Msg[]) if (m.role === "user") pushed.push(String(m.content));
    const r = replies[Math.min(n, replies.length - 1)];
    n++;
    return { content: r, thinking: "" };
  };
  const steps: Array<{ step: string; output: string }> = [];
  const result = await aiService.runAgent(
    opts.task ?? "build the thing",
    async (cmd: string) => { executed.push(cmd); return "ok"; },
    () => {},
    async () => "richardliao@mac ~ % ",
    (step, output) => steps.push({ step, output }),
    CFG,
    undefined,
    false,
    undefined,
    undefined,
    { rawUserTask: opts.task ?? "build the thing", sessionId: "s1", isSSH: opts.isSSH ?? true },
  );
  return { result, executed, pushed, steps, calls: () => n };
}

const write = (path: string) =>
  JSON.stringify({ tool: "write_file", path, content: "x" });
const exec = (command: string) => JSON.stringify({ tool: "execute_command", command });
const done = (content = "Finished.") => JSON.stringify({ tool: "final_answer", content });

describe("run state — project root is the SHALLOWEST directory written", () => {
  it("auto-cds a later command to the shallowest dir, not the most recent", async () => {
    stubWindow();
    const { executed, result } = await runScripted([
      write("/proj/src/deep/a.ts"),
      write("/proj/b.ts"),
      exec("npm test"),
      done(),
    ]);
    expect(result.success).toBe(true);
    // A nested write must not drag the project root deeper.
    expect(executed.some((c) => c === "cd /proj && npm test")).toBe(true);
    expect(executed.some((c) => c.includes("/proj/src/deep"))).toBe(false);
  });

  it("keeps the shallowest root even when the deep write comes last", async () => {
    stubWindow();
    const { executed, result } = await runScripted([
      write("/proj/b.ts"),
      write("/proj/src/deep/a.ts"),
      exec("npm test"),
      done(),
    ]);
    expect(result.success).toBe(true);
    expect(executed.some((c) => c === "cd /proj && npm test")).toBe(true);
  });

  it("lets an explicit mkdir override the shallowest-wins heuristic", async () => {
    stubWindow();
    const { executed, result } = await runScripted([
      write("/proj/b.ts"),
      exec("mkdir -p /other/app"),
      exec("npm run build"),
      done(),
    ]);
    expect(result.success).toBe(true);
    expect(executed.some((c) => c === "cd /other/app && npm run build")).toBe(true);
  });
});

describe("run state — work evidence gates completion", () => {
  it("accepts a final answer once a command has run", async () => {
    stubWindow();
    const { result } = await runScripted([exec("npm test"), done("Tests pass.")]);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Tests pass/);
  });

  it("accepts a final answer once a file has been written", async () => {
    stubWindow();
    const { result } = await runScripted([write("/proj/a.ts"), done("Wrote the file.")]);
    expect(result.success).toBe(true);
  });

  it("counts web tool use as work, so a research answer is not bounced as lazy", async () => {
    stubWindow();
    const { result } = await runScripted(
      [JSON.stringify({ tool: "web_search", query: "tron terminal" }), done("Found it.")],
      { task: "look up tron terminal" },
    );
    expect(result.success).toBe(true);
  });

  it("bounces an immediate 'Done.' when the run has produced nothing", async () => {
    stubWindow();
    const { pushed, calls } = await runScripted([done("Done."), exec("npm test"), done("Tests pass.")]);
    // The guard must have rejected the first answer and asked for real work.
    expect(calls()).toBeGreaterThan(1);
    expect(pushed.some((m) => /haven't|no.*(command|action|work)|actually/i.test(m))).toBe(true);
  });
});
