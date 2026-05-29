/**
 * Pure helpers for the agent loop's repetition / progress heuristics.
 *
 * Background: the windowed loop detector + LLM arbiter catch exact and
 * near-exact repeats, but a "hard question" the agent can't answer produces
 * *death by a thousand variations* — many semantically-identical probes with
 * slightly different text (e.g. the same `docker exec … cat config | python3
 * -c "<different one-liner>"` run 50 times). Each looks distinct enough that
 * the arbiter keeps allowing it, and the 12-entry window gets cleared/softened
 * between checks, so nothing converges before `maxSteps`.
 *
 * The cumulative cap below is an arbiter-independent backstop: it counts how
 * many times a given coarse action shape has run across the WHOLE task and
 * forces a break once that crosses a hard ceiling — no LLM judgement, no
 * window to clear. Kept pure so it's unit-tested.
 */

/** Tools that legitimately repeat the same coarse shape and must NOT be capped:
 *  read_terminal (polling a long build), send_text (menu navigation / keystrokes). */
const UNCAPPED_TOOLS = new Set(["read_terminal", "send_text"]);

/**
 * Hard ceiling on how many times one coarse action shape may run across a task
 * before it's treated as an exhausted, looping approach. Returns Infinity for
 * tools that legitimately repeat. 12 is well above normal iterative work
 * (re-running tests, editing a few files) but far below the 50× pathological
 * loops seen in logs.
 */
export function cumulativeRepetitionCap(tool: string): number {
  if (UNCAPPED_TOOLS.has(tool)) return Infinity;
  return 12;
}

/** True when a coarse action shape has repeated to/past its cumulative cap. */
export function isHardRepetitionLoop(coarseTotal: number, tool: string): boolean {
  return coarseTotal >= cumulativeRepetitionCap(tool);
}

/** True the FIRST time the cap is crossed (so we bump the loop counter once). */
export function isFirstCapCross(coarseTotal: number, tool: string): boolean {
  return coarseTotal === cumulativeRepetitionCap(tool);
}

/**
 * Whether an action represents genuine forward progress for stagnation
 * tracking. Producing command output is NOT progress — a stuck agent produces
 * output every step. Progress = exploring a NOVEL action shape (first time this
 * coarse key has been seen). `coarseTotal` is the cumulative count INCLUDING
 * the current occurrence, so 1 means "never seen before".
 */
export function isNovelAction(coarseTotal: number): boolean {
  return coarseTotal === 1;
}
