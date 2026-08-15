import { describe, it, expect } from "vitest";
import { aiService } from "../services/ai/index";
import type { AIConfig } from "../types";
import { AGENT_TOOLS } from "../services/ai/toolSchemas";

const AGENT_TOOL_COUNT = AGENT_TOOLS.length;

/**
 * End-to-end harness for `runAgent` with a scripted fake model. Stubs the
 * OpenAI-compatible stream (lmstudio provider) and the loop arbiter so the
 * whole guard/loop machinery runs for real against deterministic replies.
 * Every scenario here previously spun to `maxSteps` (fd5977963a.json).
 */
type Reply = string | Error;
type Msg = { role: string; content: unknown };
/** The two private LLM round-trips runAgent makes; stubbed per scenario. */
type OnToken = (token: string, thinking?: string) => void;
type Stubbable = {
  streamOpenAIChat: (
    provider: string, model: string, apiKey: string, messages: Msg[], onToken?: OnToken,
  ) => Promise<{ content: string; thinking: string }>;
  arbitrateAgentLoop: () => Promise<{ stuck: boolean; suggestion: string }>;
  markModelAsThinking: (provider: string, model: string) => void;
};
const svc = aiService as unknown as Stubbable;

const MAX_STEPS = 80;
const CFG: AIConfig = {
  provider: "lmstudio",
  model: "fake",
  baseUrl: "http://localhost:1234",
  maxAgentSteps: MAX_STEPS,
};

const TASK = "Create a flappy bird game on desktop and run it";
const FA_ECHO = '{"tool":"final_answer","content":"(API error)"}';
const FA_LAZY = '{"tool":"final_answer","content":"Done."}';
const LS = '{"tool":"execute_command","command":"ls"}';
const API_ERR = () => new Error("API Error: Engine protocol predict failed");
const exec = (cmd: string) => `{"tool":"execute_command","command":"${cmd}"}`;

let arbiterCalls = 0;

function scriptModel(replies: Reply[], arbiterStuck = true) {
  let calls = 0;
  svc.streamOpenAIChat = async () => {
    const r = replies[Math.min(calls, replies.length - 1)];
    calls++;
    if (r instanceof Error) throw r;
    return { content: r, thinking: "" };
  };
  arbiterCalls = 0;
  svc.arbitrateAgentLoop = async () => {
    arbiterCalls++;
    return { stuck: arbiterStuck, suggestion: "Try something else." };
  };
  return () => calls;
}

async function run(
  prompt = TASK,
  execImpl: (cmd: string) => Promise<string> = async () => "",
  thinkingEnabled = false,
) {
  const steps: Array<{ step: string; output: string }> = [];
  const result = await aiService.runAgent(
    prompt,
    execImpl,
    () => {},
    async () => "richardliao@mac ~ % ",
    (step, output) => steps.push({ step, output }),
    CFG,
    undefined,
    thinkingEnabled,
    undefined,
    undefined,
    { rawUserTask: prompt },
  );
  return { result, steps };
}

describe("runAgent — API errors", () => {
  it("replays log fd5977963a: fails fast with the provider error instead of spinning BLOCKED", async () => {
    // Two engine errors, echoed final_answer, error, echo, error, echo forever.
    const calls = scriptModel([
      API_ERR(), API_ERR(), FA_ECHO,
      API_ERR(), FA_ECHO,
      API_ERR(), FA_ECHO,
      FA_ECHO,
    ]);
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Engine protocol predict/);
    // err, err, echo(rejected), err → 3rd API error terminates.
    expect(calls()).toBe(4);
  });

  it("switches a model to native tool declarations on the first peg-native error, then retries with tools", async () => {
    const peg = () => new Error('API Error: Engine protocol predict stream returned an error: {"code":500,"message":"The model produced output that does not match the expected peg-native format","type":"server_error"}');
    const toolsSeen: Array<number | undefined> = [];
    const marked: string[] = [];
    const svcX = svc as unknown as { markModelNeedsNativeTools: (p: string, m: string) => void; isNativeToolsModel: (p: string, m: string) => boolean };
    const origMark = svcX.markModelNeedsNativeTools, origIs = svcX.isNativeToolsModel;
    svcX.markModelNeedsNativeTools = (p, m) => { marked.push(`${p}:${m}`); };
    svcX.isNativeToolsModel = () => false;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    let n = 0;
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat = async (...a: unknown[]) => {
      toolsSeen.push((a[9] as unknown[] | undefined)?.length);
      n++;
      if (n === 1) throw peg(); // native call rejected: no tools declared yet
      // With tools declared the server hands back the call as agent JSON.
      if (n === 2) return { content: exec("echo hi"), thinking: "" };
      return { content: '{"tool":"final_answer","content":"Printed hi."}', thinking: "" };
    };
    const { result, steps } = await run("print hi", async () => "hi");
    expect(result.success).toBe(true);
    expect(toolsSeen).toEqual([undefined, AGENT_TOOL_COUNT, AGENT_TOOL_COUNT]);
    expect(marked).toEqual(["lmstudio:fake"]);
    expect(steps.some((s) => s.step === "failed" && /switching to native tool declarations/.test(s.output))).toBe(true);
    svcX.markModelNeedsNativeTools = origMark; svcX.isNativeToolsModel = origIs;
  });

  it("still gives up (with a hint) when the parse error persists even with tools declared", async () => {
    const peg = () => new Error('API Error: Engine protocol predict stream returned an error: {"code":500,"message":"The model produced output that does not match the expected peg-native format","type":"server_error"}');
    const svcX = svc as unknown as { markModelNeedsNativeTools: (p: string, m: string) => void; isNativeToolsModel: (p: string, m: string) => boolean };
    const origMark = svcX.markModelNeedsNativeTools, origIs = svcX.isNativeToolsModel;
    svcX.markModelNeedsNativeTools = () => {}; svcX.isNativeToolsModel = () => false;
    const calls = scriptModel([peg(), peg(), peg(), peg()]);
    const { result, steps } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/even with tools declared/);
    // 1 mode-switch attempt (not counted) + 3 counted API errors.
    expect(calls()).toBe(4);
    const retries = steps.filter((s) => s.step === "failed" && /retrying \(\d\/3\)/.test(s.output));
    expect(retries.length).toBe(2);
    svcX.markModelNeedsNativeTools = origMark; svcX.isNativeToolsModel = origIs;
  });

  it("does not let a bogus echoed parse reset the API-error counter", async () => {
    const calls = scriptModel([
      API_ERR(), FA_ECHO, API_ERR(), FA_ECHO, API_ERR(), FA_ECHO,
      API_ERR(), FA_ECHO, API_ERR(), FA_ECHO, API_ERR(), FA_ECHO,
    ]);
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Engine protocol predict/);
    expect(calls()).toBe(5);
  });

  it("never pushes an '(API error)' turn into history for the model to echo", async () => {
    let seenPlaceholder = false;
    let n = 0;
    let done = false;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    // Two errors, then a real command, then a final answer.
    svc.streamOpenAIChat = async (_p, _m, _k, messages) => {
      if (messages.some((m) => m.content === "(API error)" || /Error from API/.test(String(m.content)))) {
        seenPlaceholder = true;
      }
      n++;
      if (n <= 2) throw API_ERR();
      if (!done) { done = true; return { content: exec("echo hi"), thinking: "" }; }
      return { content: '{"tool":"final_answer","content":"Printed hi."}', thinking: "" };
    };
    const { result } = await run("print hi", async () => "hi");
    expect(seenPlaceholder).toBe(false);
    expect(result.success).toBe(true);
  });

  it("fails immediately on a context-overflow error instead of retrying it 3×", async () => {
    const calls = scriptModel([
      new Error('API Error: Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded."}'),
    ]);
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/context window/);
    expect(calls()).toBe(1);
  });

  it("intermittent API errors in a productive run do not accumulate to a failure", async () => {
    // err, cmd, err, cmd, err, cmd, err, cmd, final — 4 errors total but never 3 in a row.
    scriptModel([
      API_ERR(), exec("echo 1"),
      API_ERR(), exec("echo 2"),
      API_ERR(), exec("echo 3"),
      API_ERR(), exec("echo 4"),
      '{"tool":"final_answer","content":"Ran echo 1 through 4; all printed."}',
    ], false);
    const { result } = await run("run echo 1..4", async (c) => c.replace("echo ", ""));
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/echo 1 through 4/);
  });
});

describe("runAgent — final_answer / ask_question bounced by guards", () => {
  it("stops after the rejection cap and reports failure when no work was done", async () => {
    const calls = scriptModel([FA_LAZY]);
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/without doing any work/);
    expect(result.message).toContain("Done.");
    // 3 rejected attempts, 4th force-resolves.
    expect(calls()).toBe(4);
  });

  it("surfaces the model's answer after the cap when real work WAS done", async () => {
    // Runs a command, then keeps giving an answer the guards dislike
    // ("run X yourself" → REJECTED "Do NOT tell the user to run commands").
    const stubborn = '{"tool":"final_answer","content":"Please run npm start to launch it."}';
    const calls = scriptModel([exec("ls"), stubborn], false);
    const { result } = await run(TASK, async () => "index.html");
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/npm start/);
    expect(calls()).toBeLessThanOrEqual(6);
  });

  it("lets a repeatedly-rejected ask_question through after the cap", async () => {
    const ask = '{"tool":"ask_question","question":"Where should the game live?"}';
    const calls = scriptModel([ask]);
    const { result } = await run();
    expect(result.type).toBe("question");
    expect(calls()).toBe(4);
  });

  it("never runs loop detection (arbiter) for a repeated final_answer", async () => {
    scriptModel([FA_LAZY]);
    await run();
    expect(arbiterCalls).toBe(0);
  });
});

describe("runAgent — loop-blocked action re-emitted forever", () => {
  it("escalates to the user after 3 BLOCKED repeats instead of spinning to maxSteps", async () => {
    const calls = scriptModel([LS]);
    const { result } = await run(TASK, async () => "a b c");
    // 1: runs; 2: arbiter → LOOP DETECTED; 3,4: BLOCKED; 5: bounded → escalate.
    expect(result.type).toBe("question");
    expect(result.message).toMatch(/stuck repeating/);
    expect(calls()).toBe(5);
    expect(calls()).toBeLessThan(MAX_STEPS);
  });
});

describe("runAgent — circuit breaker", () => {
  it("escalates after repeated trips with no successful action in between", async () => {
    // Ten distinct guard-blocked commands (recursive ls without a target) — no
    // exact repetition, so only the guard counter can bound this.
    const cmds = ["ls -R .", "ls -R ..", "ls -R ~", "ls -R /", "ls -Ra .",
      "ls -Rl .", "ls -Rla .", "ls -Ral ..", "ls -Rl ~", "ls -Rl /"];
    const calls = scriptModel(cmds.map(exec), false);
    const { result } = await run(TASK);
    expect(result.type).toBe("question");
    expect(result.message).toMatch(/blocked actions/);
    // 3 blocks → trip 1 (reset), 3 → trip 2, 3 → trip 3 → escalate.
    expect(calls()).toBe(9);
  });

  it("a successful action between trips resets the trip count", async () => {
    const blocked = ["ls -R .", "ls -R ..", "ls -R ~", "ls -R /", "ls -Ra .", "ls -Rl ."];
    const replies = [
      ...blocked.slice(0, 3).map(exec), exec("echo ok"),
      ...blocked.slice(3, 6).map(exec), exec("echo ok2"),
      ...["ls -Rla .", "ls -Ral ..", "ls -Rl ~"].map(exec),
      '{"tool":"final_answer","content":"Listed what I could; done."}',
    ];
    scriptModel(replies, false);
    const { result } = await run(TASK, async () => "ok");
    // Never 3 consecutive trips → reaches the final answer normally.
    expect(result.type).toBe("success");
    expect(result.message).toMatch(/Listed what I could/);
  });
});

describe("runAgent — exhausted action shape re-tried with variations", () => {
  it("escalates instead of re-emitting STOP forever once the cumulative cap is crossed", async () => {
    // 40 distinct commands sharing a >50-char prefix → same coarse shape,
    // different exact keys, all succeed. Only the cumulative cap sees this.
    const prefix = "echo " + "a".repeat(60);
    const cmds = Array.from({ length: 40 }, (_, i) => exec(`${prefix}${i}`));
    const calls = scriptModel(cmds, false);
    const { result } = await run("print some a's", async () => "aaa");
    expect(result.type).toBe("question");
    // cap (12) + a few post-cap repeats — far short of the 40 the model would emit.
    expect(calls()).toBeLessThanOrEqual(16);
  });
});

describe("runAgent — reasoning models the app didn't know about", () => {
  it("streams reasoning_content live and marks the model as thinking even with the toggle off (log 52e887da4e)", async () => {
    const marked: string[] = [];
    const origMark = svc.markModelAsThinking;
    svc.markModelAsThinking = (p, m) => { marked.push(`${p}:${m}`); };
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    let n = 0;
    svc.streamOpenAIChat = async (_p, _m, _k, _msgs, onToken) => {
      n++;
      if (n === 1) {
        // Harmony-style model: a long analysis phase before any content.
        for (const piece of ["We need", " a plan.", " Use write_file."]) onToken?.("", piece);
        onToken?.(exec("echo hi"));
        return { content: exec("echo hi"), thinking: "We need a plan. Use write_file." };
      }
      return { content: '{"tool":"final_answer","content":"Printed hi."}', thinking: "" };
    };
    const { result, steps } = await run("print hi", async () => "hi", false);
    expect(result.success).toBe(true);
    const thinkingStreams = steps.filter((s) => s.step === "streaming_thinking").map((s) => s.output);
    expect(thinkingStreams.length).toBeGreaterThan(0);
    expect(thinkingStreams.at(-1)).toBe("We need a plan. Use write_file.");
    // Reasoning is also captured/logged, not dropped, when the toggle is off.
    expect(steps.some((s) => s.step === "thinking_complete")).toBe(true);
    expect(marked).toEqual(["lmstudio:fake"]);
    svc.markModelAsThinking = origMark;
  });

  it("retracts a half-finished thinking entry when the attempt dies mid-stream — and only then", async () => {
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    let n = 0;
    svc.streamOpenAIChat = async (_p, _m, _k, _msgs, onToken) => {
      n++;
      if (n === 1) { onToken?.("", "Let me think"); throw API_ERR(); } // reasoning, then engine error
      if (n === 2) throw API_ERR(); // error before any token
      return { content: '{"tool":"final_answer","content":"Nothing to do."}', thinking: "" };
    };
    const { steps } = await run("say hi", async () => "", false);
    const kinds = steps.map((s) => s.step).filter((k) => ["streaming_thinking", "retract_thought", "failed"].includes(k));
    // attempt 1: streamed → retracted → failed(retry 1); attempt 2: no stream → no retract → failed(retry 2)
    expect(kinds).toEqual(["streaming_thinking", "retract_thought", "failed", "failed"]);
  });
});

describe("runAgent — bare tool arguments from tool-trained models (qwen live 2026-08-15)", () => {
  // qwen3.8-27b streams its native function-call ARGUMENTS as the message text,
  // with no {"tool":...} wrapper. Previously: {"todos":[...]} was unparseable
  // (5 silent retries per step) and a lone todo item was coerced into a bogus
  // final_answer that the completion guards rejected forever.
  const BARE_TODOS =
    '{"todos":[{"content":"Create a self-contained HTML Flappy Bird game","status":"in_progress"},' +
    '{"content":"Verify the file was written correctly","status":"pending"},' +
    '{"content":"Open it in the default browser","status":"pending"}]}';

  it("dispatches a bare {todos:[...]} as todo_write with zero parse retries", async () => {
    const calls = scriptModel([
      BARE_TODOS,
      exec("touch /tmp/flappy.html"),
      '{"tool":"final_answer","content":"Created the game and opened it."}',
    ], false);
    const { result, steps } = await run(TASK, async () => "");
    expect(result.success).toBe(true);
    const plan = steps.find((s) => s.step === "plan");
    expect(plan?.output).toContain("Create a self-contained HTML Flappy Bird game");
    // One call per scripted reply — a parse failure would have re-called the model.
    expect(calls()).toBe(3);
    expect(steps.filter((s) => s.step === "retract_thought")).toHaveLength(0);
  });

  it("treats a lone todo ITEM as a plan fragment, not a bogus final_answer", async () => {
    // Old behavior: {"content":...,"status":"in_progress"} → final_answer with
    // no work done → rejected 3× → run fails. New: 1-item todo_write (the
    // dispatcher rejects it as noise with guidance) and the run recovers.
    const calls = scriptModel([
      '{"content":"Create flappy bird HTML game file","status":"in_progress"}',
      exec("touch /tmp/flappy.html"),
      '{"tool":"final_answer","content":"Created the file."}',
    ], false);
    const { result } = await run(TASK, async () => "");
    expect(result.success).toBe(true);
    expect(calls()).toBe(3);
  });

  it("still lets a bare {content} object surface as an answer", async () => {
    const calls = scriptModel([
      exec("echo hi"),
      '{"content":"Ran echo; it printed hi."}',
    ], false);
    const { result } = await run("print hi", async () => "hi");
    expect(result.success).toBe(true);
    expect(result.message).toBe("Ran echo; it printed hi.");
    expect(calls()).toBe(2);
  });
});
