/**
 * How prior conversation turns are summarised into the agent's context.
 *
 * The older-context block exists to keep a weak local model focused on the
 * CURRENT task without re-executing old ones, so it is deliberately terse.
 * But it used to clip every turn to 80 characters regardless of who said it,
 * which mangled the one thing the agent cannot reconstruct: the user's actual
 * instruction. In log ddb57d1bbd a ~195-character task was cut to
 * "Create a tui (terminal ui) program that shows the allocation of current
 * machine'…", so when the user later typed "continue" the agent had to guess
 * what it was continuing — and guessed wrong.
 *
 * A user turn is an instruction; an agent turn is a summary of work already
 * reported. The instruction is worth far more context budget than the summary.
 */

/** User instructions keep enough room for a real one-paragraph task. */
export const OLDER_USER_CHARS = 300;
/** Agent turns are already summaries — a headline is enough. */
export const OLDER_AGENT_CHARS = 100;

export function summarizeOlderInteraction(
  role: "user" | "agent",
  text: string,
): string {
  const limit = role === "user" ? OLDER_USER_CHARS : OLDER_AGENT_CHARS;
  const label = role === "user" ? "User" : "Agent";
  const clean = (text ?? "").trim();
  const body = clean.length > limit ? clean.slice(0, limit) + "…" : clean;
  return `${label}: ${body}`;
}

/**
 * Build the "older conversation" block, spending as much of the available
 * budget as the model can afford.
 *
 * Turns are added newest-first so that when the budget is tight the agent keeps
 * the turns most likely to explain a follow-up like "continue". A turn that
 * fits whole is included whole; the first one that doesn't fit is clipped by
 * role (a user instruction keeps more room than an agent summary) and the walk
 * stops there.
 */
export function buildOlderConversation(
  interactions: Array<{ role: string; content: unknown }>,
  budgetChars: number,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = interactions.length - 1; i >= 0; i--) {
    const turn = interactions[i];
    const role: "user" | "agent" = turn.role === "user" ? "user" : "agent";
    const text = typeof turn.content === "string" ? turn.content : "";
    if (!text.trim()) continue;

    const whole = `${role === "user" ? "User" : "Agent"}: ${text.trim()}`;
    if (used + whole.length <= budgetChars) {
      lines.unshift(whole);
      used += whole.length + 1;
      continue;
    }
    // Doesn't fit whole — include a clipped version if there's meaningful room,
    // then stop: anything older is even less relevant.
    const clipped = summarizeOlderInteraction(role, text);
    if (used + clipped.length <= budgetChars) {
      lines.unshift(clipped);
    }
    break;
  }
  return lines.join("\n");
}
