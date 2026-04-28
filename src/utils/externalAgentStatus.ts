/**
 * Detect the status of an *external* AI agent CLI (primarily Claude Code,
 * also Aider/Codex/Cursor) running inside a Tron terminal session.
 *
 * Tron's own agent is authoritative — its status comes from the React store.
 * For external agents we have to read the terminal output and infer.
 *
 * The strongest signals come from Claude Code's spinner line, which always
 * contains "(esc to interrupt)" while the agent is working. The moment that
 * marker disappears, Claude is idle (waiting for the user). That gives us a
 * definitive working/idle transition that the previous heuristic-only
 * detection couldn't see — it relied on stale "last seen tool name" with
 * multi-second stickiness, leading to laggy and stuck-on-green status.
 *
 * Pure (no IO / state) so it can be unit-tested and the bridge can compose
 * multiple chunks worth of signals.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[a-zA-Z]|\x1B\].*?(?:\x07|\x1B\\)|\x1B[()][0-2]|\x1B[>=<]|\x1B\x1B|\x0F|\x0E/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const SPINNER_GLYPHS = "·✢✳✶✻✽*";
const SPINNER_GLYPH_CLASS = `[${SPINNER_GLYPHS}]`;

/**
 * Parse a Claude Code spinner line. Returns null if the line isn't one.
 * Canonical shape: `<glyph> <Verb>… (<Ns | NmNs> · ↑ <X[k]> tokens · esc to interrupt)`
 */
export function parseSpinnerLine(line: string): {
  working: true;
  elapsedSeconds?: number;
  tokens?: number;
} | null {
  const stripped = stripAnsi(line);
  if (!stripped) return null;
  // Must contain "esc to interrupt" — that's the load-bearing signal that
  // Claude is actually still busy. Verbs and glyphs alone leak across into
  // idle frames (the last spinner frame sometimes lingers in scrollback).
  if (!/esc to interrupt/i.test(stripped)) return null;
  // And must look like a spinner (glyph + verb + ellipsis), not just a
  // random message that happens to contain "esc to interrupt".
  const spinnerRe = new RegExp(`${SPINNER_GLYPH_CLASS}\\s+[A-Z][a-z]+[…\\.]`);
  if (!spinnerRe.test(stripped)) return null;

  // Extract elapsed time. Tolerant of seconds (`5s`), minutes+seconds
  // (`1m20s`), and hours (`2h5m10s`). Always returned as total seconds.
  let elapsedSeconds: number | undefined;
  const elapsedMatch = stripped.match(/(?:(\d+)h)?(?:(\d+)m)?(\d+)s\b/);
  if (elapsedMatch) {
    const h = parseInt(elapsedMatch[1] || "0", 10);
    const m = parseInt(elapsedMatch[2] || "0", 10);
    const s = parseInt(elapsedMatch[3] || "0", 10);
    elapsedSeconds = h * 3600 + m * 60 + s;
  }

  // Token count: `↑ 2.3k tokens` or `↑ 800 tokens`. Also accept plain
  // `2.3k tokens` without the ↑ in case the glyph ever changes.
  let tokens: number | undefined;
  const tokenMatch = stripped.match(/(?:↑\s*)?(\d+(?:\.\d+)?)([kKmM]?)\s*tokens/);
  if (tokenMatch) {
    const num = parseFloat(tokenMatch[1]);
    const suffix = tokenMatch[2].toLowerCase();
    const mult = suffix === "k" ? 1000 : suffix === "m" ? 1_000_000 : 1;
    tokens = Math.round(num * mult);
  }

  return { working: true, elapsedSeconds, tokens };
}

// =============================================================================
// Tool-call & permission patterns (separate from spinner — these are the
// stable lines that scroll past in Claude Code's transcript)
// =============================================================================

const TOOL_NAMES: Array<[string, string]> = [
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Edit", "edit_file"],
  ["MultiEdit", "edit_file"],
  ["NotebookEdit", "edit_file"],
  ["NotebookRead", "read_file"],
  ["TodoRead", "read_file"],
  ["TodoWrite", "write_file"],
  ["Glob", "list_dir"],
  ["LS", "list_dir"],
  ["Grep", "search_dir"],
  ["ToolSearch", "search_dir"],
  ["Explore", "search_dir"],
  ["Bash", "execute_command"],
  ["BashOutput", "execute_command"],
  ["KillShell", "execute_command"],
  ["Skill", "execute_command"],
  ["SlashCommand", "execute_command"],
  ["WebSearch", "web_search"],
  ["WebFetch", "web_search"],
  ["Search", "web_search"],
  ["Fetch", "web_search"],
  ["Agent", "agent"],
  ["Task", "agent"],
  ["TaskCreate", "agent"],
  ["TaskUpdate", "agent"],
  ["TaskList", "agent"],
  ["TaskGet", "agent"],
  ["TaskOutput", "agent"],
  ["TaskStop", "agent"],
  ["Plan", "thinking"],
  ["EnterPlanMode", "thinking"],
  ["ExitPlanMode", "thinking"],
  ["AskUser", "ask_question"],
  ["AskUserQuestion", "ask_question"],
];

const sortedToolNames = [...TOOL_NAMES].sort((a, b) => b[0].length - a[0].length);

const TOOL_CALL_RE: Array<[RegExp, string]> = sortedToolNames.map(([n, c]) => [
  new RegExp(`(?:^|\\n)\\s*[⏺⏵►▶●]\\s*${n}\\b`),
  c,
]);

const GERUND_RE: Array<[RegExp, string]> = [
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Reading\b/i, "read_file"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Writing\b/i, "write_file"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Editing\b/i, "edit_file"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Searching\b/i, "search_dir"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Listing\b/i, "list_dir"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Running\b/i, "execute_command"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Fetching\b/i, "web_search"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Launching\b/i, "agent"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Spawning\b/i, "agent"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Planning\b/i, "thinking"],
  [/(?:^|\n)\s*[⏺⏵►▶●]\s*Thinking\b/i, "thinking"],
];

const PERMISSION_RE = /Allow\s+(?:Bash|Read|Edit|MultiEdit|Write|Glob|Grep|Fetch|Search|WebFetch|WebSearch|Agent|Explore|Task|Skill|NotebookEdit|mcp__)\b/;

const GENERIC_PERMISSION_PATTERNS = [
  /do you want to proceed\??/i,
  /would you like to proceed\??/i,
  /do you want to continue\??/i,
  /are you sure\??/i,
  /\(y\/n\)\s*\??/i,
  /\[y\/n\]\s*\??/i,
  /\[yes\/no\]\s*\??/i,
  /allow this action\??/i,
  /[❯►]\s*\d+\.\s+(?:Yes|No|Cancel|Skip|Continue|Abort)/i,
];

/**
 * The Claude Code idle prompt frame uses these distinct box-drawing
 * characters together with the input cursor. Seeing them strongly suggests
 * Claude is showing its input box — i.e. it's idle, waiting for the user.
 */
const IDLE_PROMPT_FRAME_RE = /╭─{3,}.*\n[\s\S]{0,300}?[│|][\s\S]{0,80}?[>›]\s*_?/;

/**
 * Banners / brand markers that mean an agent CLI is running in this session.
 * Used to mark "agent is present" even before any spinner / tool line shows
 * up — covers Claude Code's startup splash, between-tool gaps, and the input
 * frame on terminals that render box drawing differently. Match is
 * intentionally conservative (word-boundary, plus a minimum-context
 * requirement) so plain shell output doesn't false-positive.
 *
 * Verified against Claude Code source (`src/components/LogoV2/WelcomeV2.tsx`
 * "Welcome to Claude Code v…", `src/components/LogoV2/CondensedLogo.tsx`
 * "claude-3-5-sonnet · …", "cwd: /…").
 */
const AGENT_BANNER_RE =
  /Welcome\s+to\s+Claude\s+Code|✻\s*Welcome\s+to\s+Claude|✻\s*Claude\s+Code\b|\bClaude\s+Code\s+v\d/i;
/** Brand-specific lines that show up *outside* the welcome banner —
 *  e.g. between turns, on auth flows, on /help, on `claude --version`. */
const AGENT_SECONDARY_RE =
  /\bcwd:\s+\/[\w/.\-]+|\b(?:claude-)?(?:sonnet|opus|haiku)-?\d|\bClaude\s+Code\b.*\bv\d/i;
const AIDER_BANNER_RE = /\baider\b\s*v?\d|^Aider\s/im;
const CODEX_BANNER_RE = /\bcodex\s+(?:cli|chat|repl)\b/i;
const CURSOR_BANNER_RE = /\bcursor\s+(?:cli|agent)\b/i;

// =============================================================================

export interface ExternalAgentSignal {
  /** Detected tool category (matches Tron's internal tool names). */
  tool?: string;
  /** True if the chunk contains a permission prompt. */
  permission?: boolean;
  /** True ONLY when an active spinner is in this chunk. */
  working?: true;
  /** True when the chunk shows Claude Code's input frame (idle). */
  idle?: true;
  /** True when an agent CLI banner / brand marker is present — used to
   *  mark "agent is here" even when no spinner or tool line is visible. */
  agentPresent?: true;
  /** Token count from the spinner suffix, if present. */
  tokens?: number;
  /** Elapsed seconds from the spinner suffix, if present. */
  elapsedSeconds?: number;
}

export function detectExternalAgentSignal(rawData: string): ExternalAgentSignal {
  const stripped = stripAnsi(rawData);
  if (!stripped) return {};
  const result: ExternalAgentSignal = {};

  // Spinner: line-level scan because each chunk usually contains exactly
  // one spinner repaint, but we still walk lines so trailing junk doesn't
  // veto the parse.
  for (const line of stripped.split(/\r?\n/)) {
    const sp = parseSpinnerLine(line);
    if (sp) {
      result.working = true;
      if (sp.elapsedSeconds != null) result.elapsedSeconds = sp.elapsedSeconds;
      if (sp.tokens != null) result.tokens = sp.tokens;
      // Spinner without a more specific tool implies thinking
      if (!result.tool) result.tool = "thinking";
      break;
    }
  }

  // Tool-call lines (⏺ Read, ⏺ Bash, ⏺ Editing 3 files…)
  if (!result.tool || result.tool === "thinking") {
    for (const [re, cat] of TOOL_CALL_RE) {
      if (re.test(stripped)) {
        result.tool = cat;
        break;
      }
    }
    if (!result.tool || result.tool === "thinking") {
      for (const [re, cat] of GERUND_RE) {
        if (re.test(stripped)) {
          result.tool = cat;
          break;
        }
      }
    }
  }

  // Permission prompt
  if (
    PERMISSION_RE.test(stripped) ||
    GENERIC_PERMISSION_PATTERNS.some((p) => p.test(stripped))
  ) {
    result.permission = true;
  }

  // Idle prompt frame — Claude is waiting for input.
  if (IDLE_PROMPT_FRAME_RE.test(stripped)) {
    result.idle = true;
  }

  // Agent banner / brand marker — mark presence even when the chunk has no
  // active spinner, tool line, or input frame. The idle-frame test above
  // implies presence; banners cover the gaps (startup splash, between
  // tool calls, alt-screen redraws that don't include the frame).
  if (
    result.idle ||
    result.working ||
    result.tool ||
    AGENT_BANNER_RE.test(stripped) ||
    AGENT_SECONDARY_RE.test(stripped) ||
    AIDER_BANNER_RE.test(stripped) ||
    CODEX_BANNER_RE.test(stripped) ||
    CURSOR_BANNER_RE.test(stripped)
  ) {
    result.agentPresent = true;
  }

  return result;
}
