/**
 * Auto-recovery of external AI CLI sessions (Claude Code, Codex) after an app
 * restart. PTY processes die with the app, but these CLIs persist their own
 * conversation state and can resume it: the restored shell starts back in the
 * session's old cwd, so re-running the CLI's resume command reopens the
 * conversation. Detection runs at restore time against the persisted history
 * tail — no live tracking needed, so it also works after a crash.
 *
 * The EXACT session is resolved by fingerprinting the pane's transcript
 * against the CLI's own session store (main process, `agent.findResumeSession`
 * in electron/ipc/agentSessions.ts) — never "most recent", which is wrong
 * with multiple panes in one cwd. No confident match → no resume.
 */
import { stripAnsi } from "./contextCleaner";
import { classifyTerminalOutput } from "./terminalState";
import {
  detectAgentBrand,
  hasLiveAgentFrame,
  type ExternalAgentBrand,
} from "./externalAgentStatus";

/** Only CLIs with a verified resume-by-session-id command. */
const RESUMABLE = new Set<ExternalAgentBrand>(["claude", "codex"]);

/** Build the resume command for an exact session id. The id is typed into the
 *  user's shell, so only uuid-shaped ids are accepted. */
export function buildResumeCommand(brand: ExternalAgentBrand, sessionId: string): string | null {
  if (!/^[0-9a-fA-F][0-9a-fA-F-]{15,63}$/.test(sessionId)) return null;
  switch (brand) {
    case "claude": return `claude --resume ${sessionId}`;
    case "codex": return `codex resume ${sessionId}`;
    default: return null;
  }
}

/** Chrome the TUIs keep on screen — never part of the conversation text. */
const NON_CONTENT_LINE_RE =
  /[╭╰│┌└┃■▌❯›⏵]|(^|\s)[─═]{3,}|\? for shortcuts|esc to interrupt|shift\+tab|bypass permissions|tokens used|context left/i;

/**
 * Extract distinctive transcript lines from a pane's restored history tail to
 * fingerprint against session files. Rendered lines are contiguous substrings
 * of the stored message text (word-wrap splits at spaces), so a line that
 * survives these filters should appear verbatim in the right session file.
 */
export function extractResumeFragments(rawTail: string): string[] {
  const stripped = stripAnsi(rawTail.slice(-16000));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of stripped.split("\n")) {
    const t = line.trim().replace(/^[●○⎿]\s+/, "");
    if (t.length < 20 || t.length > 120) continue;
    if (!/[a-zA-Z]{4}/.test(t)) continue;
    if (NON_CONTENT_LINE_RE.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(-12);
}

/**
 * Decide from a restored session's raw history whether an AI CLI was live at
 * quit and can be auto-resumed. Conservative on purpose — a false positive
 * types a command into the user's shell, so every gate must pass:
 * - the tail must NOT end at a shell prompt (CLI exited before quit);
 * - brand markers must appear in the recent region, not just deep scrollback;
 * - the bottom of the tail must show the CLI's live input frame / status.
 */
export function detectResumableAgent(rawHistory: string): ExternalAgentBrand | null {
  if (!rawHistory) return null;
  const stripped = stripAnsi(rawHistory.slice(-16000));
  const trimmed = stripped.trim();
  if (!trimmed) return null;
  if (classifyTerminalOutput(trimmed) === "idle") return null;
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  // Bare minimal prompts (starship/pure `❯`, PS2 `>`) that the generic idle
  // classifier misses. A live Claude/Codex frame always has footer content
  // below its input line, so a bare prompt as the LAST line means a shell.
  const lastLine = lines[lines.length - 1] || "";
  if (/^[❯›>$%#]$/.test(lastLine)) return null;
  const brand = detectAgentBrand(trimmed.slice(-6000));
  if (!brand || !RESUMABLE.has(brand)) return null;
  const tail = lines.slice(-25).join("\n");
  return hasLiveAgentFrame(tail, brand) ? brand : null;
}
