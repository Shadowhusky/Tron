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

// Spinner glyphs used by Claude Code (src/components/Spinner/utils.ts).
// Kept here as documentation — the parser no longer requires the glyph
// because Ink may wrap the spinner across lines and the unique phrase
// "esc to interrupt" is sufficient on its own.
// const SPINNER_GLYPHS = "·✢✳✶✻✽*";

/**
 * Parse Claude Code's spinner status from a chunk of text. The spinner is
 * rendered by Ink as a flex-row with three Box children (glyph / verb /
 * suffix), so on narrow terminals it wraps onto multiple lines and a
 * line-by-line scan misses it. We work on the WHOLE stripped chunk and
 * key off the load-bearing phrase "esc to interrupt", which only ever
 * appears in Claude Code's spinner suffix and is unique enough to act
 * as a positive identifier on its own.
 *
 * Canonical shape (single line): `<glyph> <Verb>… (<Ns> · ↑ <X[k]> tokens · esc to interrupt)`
 * Wrapped shape (narrow terminal):
 *   `<glyph> <Verb>…`
 *   `(<Ns> · ↑ <X[k]> tokens · esc`
 *   ` to interrupt)`
 */
/**
 * Claude Code ≥2.1 spinner (verified against a live 2.1.216 capture): the
 * suffix "(… esc to interrupt)" is GONE. The working state renders as
 * `<glyph> <Gerund>… ` with a whimsical gerund verb — e.g. `✢ Contemplating… `.
 * Completion renders past-tense (`✻ Crunched for 2s`), which must NOT match,
 * hence the required `ing` + ellipsis. Glyph set excludes `*` here to avoid
 * matching generic shell spinners; legacy versions still match via the
 * "esc to interrupt" phrase below.
 */
const GERUND_SPINNER_RE = /(?:^|\n)\s*[✢✳✶✻✽·]\s*[A-Z][a-zA-Z]*ing(?:…|\.\.\.)/;

export function parseSpinnerLine(input: string): {
  working: true;
  elapsedSeconds?: number;
  tokens?: number;
} | null {
  const stripped = stripAnsi(input);
  if (!stripped) return null;
  // Legacy (<2.1): the phrase "esc to interrupt" is unique to Claude Code's
  // spinner. Current (≥2.1): the gerund spinner shape. Either counts.
  // Allow the legacy phrase to span a wrap point (e.g. "esc\nto interrupt").
  const legacy = /esc\s+to\s+interrupt/i.test(stripped);
  if (!legacy && !GERUND_SPINNER_RE.test(stripped)) return null;

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
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Reading\b/i, "read_file"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Writing\b/i, "write_file"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Editing\b/i, "edit_file"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Searching\b/i, "search_dir"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Listing\b/i, "list_dir"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*(?:Running|Ran)\b/i, "execute_command"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Fetching\b/i, "web_search"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Launching\b/i, "agent"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Spawning\b/i, "agent"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Planning\b/i, "thinking"],
  [/(?:^|\n)\s*[⏺⏵►▶●•]\s*Thinking\b/i, "thinking"],
  [/(?:^|\n)\s*(?:exec|shell|command)\s*:/i, "execute_command"],
  [/(?:^|\n)\s*(?:apply_patch|patch)\s*:/i, "edit_file"],
];

const CLAUDE_PERMISSION_TOOL_RE =
  /\b(?:Allow|Approve)\s+(?:Bash|Read|Edit|MultiEdit|Write|Glob|Grep|Fetch|Search|WebFetch|WebSearch|Agent|Explore|Task|Skill|NotebookEdit|PowerShell|mcp__)\b/i;

const CONTEXTUAL_PERMISSION_PATTERNS = [
  // Claude Code's current permission UI renders this shared question plus
  // a Select with Yes/No options and an "Esc to cancel" footer.
  /do you want to proceed\??[\s\S]{0,900}(?:Esc to cancel|[❯►›>]\s*\d+\.\s*Yes|\bYes\b[\s\S]{0,300}\bNo\b)/i,
  /would you like to proceed\??[\s\S]{0,500}(?:\bYes\b[\s\S]{0,200}\bNo\b|\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\])/i,
  /do you want to continue\??[\s\S]{0,500}(?:\bYes\b[\s\S]{0,200}\bNo\b|\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\])/i,
  /are you sure\??[\s\S]{0,300}(?:\bYes\b[\s\S]{0,200}\bNo\b|\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\])/i,
  /\b(?:allow|approve)\s+(?:this\s+)?(?:command|execution|tool|edit|edits|change|changes|patch)\??[\s\S]{0,300}(?:\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|\bYes\b[\s\S]{0,200}\bNo\b)/i,
  /\b(?:waiting for|needs?)\s+(?:user\s+)?(?:approval|permission)\b/i,
  /allow this action\??/i,
  /[❯►]\s*\d+\.\s+(?:Yes|No|Cancel|Skip|Continue|Abort)/i,
];

const TERSE_PERMISSION_PATTERNS = [
  /\(y\/n\)\s*\??/i,
  /\[y\/n\]\s*\??/i,
  /\[Y\/n\]\s*\??/i,
  /\[y\/N\]\s*\??/i,
  /\[yes\/no\]\s*\??/i,
];

/**
 * Permission prompts are a LIVE bottom-of-screen UI state. An agent's prompt
 * box is always the bottommost interactive element; once answered, fresh
 * output / the spinner / the idle frame take its place at the bottom while the
 * answered question scrolls up. Scanning the whole buffer therefore re-matches
 * already-answered prompts still sitting in scrollback — the root cause of the
 * status dot latching on "needs approval" forever. We only scan the bottom
 * region. A permission box (incl. wrapped on a narrow terminal) is ~13 lines,
 * so 20 gives headroom without reaching into stale scrollback.
 */
const PERMISSION_SCAN_LINES = 20;

/** Return the last `n` lines of `s`, ignoring trailing blank lines (mirrors
 *  how the xterm screen-buffer reader trims trailing whitespace). */
function bottomLines(s: string, n: number): string {
  const lines = s.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/**
 * The Claude Code idle prompt frame. Legacy (<2.1): a `╭───` box with a
 * `│ >` input cursor. Current (≥2.1, verified live): a bare `❯` prompt line
 * between full-width `────` rules with a shortcut footer. The `❯` alone is
 * ambiguous (permission selects render `❯ 1. Yes`), so idle requires the ❯
 * NOT followed by a numbered option, plus a frame corroborator nearby.
 */
const IDLE_PROMPT_FRAME_RE = /╭─{3,}.*\n[\s\S]{0,300}?[│|][\s\S]{0,80}?[>›]\s*_?/;
const NEW_IDLE_PROMPT_RE = /(?:^|\n)\s*❯(?!\s*\d+\.)/;
// Deliberately does NOT accept a bare `────` rule: starship-style `❯` shells
// plus any long dash line in scrollback would false-positive. Only Claude
// Code's own footer hints corroborate the ❯ as ITS input frame.
const IDLE_FRAME_CORROBORATOR_RE =
  /shift\+tab to cycle|\?\s*for shortcuts|bypass\s?permissions|plan mode|accept edits/i;
/** Turn was stopped by the user — Claude renders `⎿ Interrupted …`. */
const INTERRUPTED_RE = /⎿\s*Interrupted\b/;
/** Codex ≥0.14x: ratatui status header states + `›` composer prompt. Only
 *  trusted when a Codex/agent marker is present (the words are too generic
 *  on their own). */
const CODEX_STATE_RE = /(?:^|\n)\s*[•▌]?\s*(?:Working|Thinking|Reviewing)\b[^\n]{0,60}$/m;
const CODEX_IDLE_PROMPT_RE = /(?:^|\n)\s*›\s/;

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
  /\bcwd:\s+\/[\w/.-]+|\b(?:claude-)?(?:sonnet|opus|haiku|fable)\s?-?\d|\bClaude\s+Code\b.*\bv\d|\bClaude\s+Max\b|shift\+tab to cycle|bypass\s?permissions\s?on/i;
const AIDER_BANNER_RE = /\baider\b\s*v?\d|^Aider\s/im;
const CODEX_BANNER_RE =
  /\bOpenAI\s+Codex(?:\s+(?:CLI|v?\d[\w.-]*))?\b|\bCodex\s+(?:CLI|v?\d[\w.-]*|agent|chat|repl)\b|chatgpt\.com\/codex|openai\/codex|\bcodex resume\b/i;
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

export interface ExternalAgentDetectionOptions {
  /** Allow terse yes/no permission prompts once the caller already knows
   *  this terminal is running an agent. Prevents ordinary shell prompts from
   *  bootstrapping a false-positive agent status. */
  allowTersePermission?: boolean;
}

export function detectExternalAgentSignal(
  rawData: string,
  options: ExternalAgentDetectionOptions = {},
): ExternalAgentSignal {
  const stripped = stripAnsi(rawData);
  if (!stripped) return {};
  const result: ExternalAgentSignal = {};
  const hasAgentMarker =
    AGENT_BANNER_RE.test(stripped) ||
    AGENT_SECONDARY_RE.test(stripped) ||
    AIDER_BANNER_RE.test(stripped) ||
    CODEX_BANNER_RE.test(stripped) ||
    CURSOR_BANNER_RE.test(stripped);

  // Spinner: pass the whole chunk to the parser. The spinner is rendered
  // as an Ink flex-row, so on narrow terminals the (esc to interrupt)
  // suffix wraps to its own line. A per-line scan would miss the working
  // state when wrapping happens.
  const sp = parseSpinnerLine(stripped);
  if (sp) {
    result.working = true;
    if (sp.elapsedSeconds != null) result.elapsedSeconds = sp.elapsedSeconds;
    if (sp.tokens != null) result.tokens = sp.tokens;
    // Spinner without a more specific tool implies thinking
    if (!result.tool) result.tool = "thinking";
  }

  // Codex status header ("Working"/"Thinking"/"Reviewing") — the words are
  // too generic to trust alone, so require a Codex/agent marker in the same
  // text (or a caller that already knows this session runs an agent).
  if (
    !result.working &&
    (hasAgentMarker || options.allowTersePermission) &&
    CODEX_STATE_RE.test(bottomLines(stripped, PERMISSION_SCAN_LINES))
  ) {
    result.working = true;
    if (!result.tool) result.tool = "thinking";
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

  // Permission prompt — mutually exclusive with the working spinner. Claude
  // Code hides the "esc to interrupt" spinner while it waits for approval, so
  // a live spinner means it is NOT waiting (the user already answered and work
  // resumed). Skipping permission detection when working=true is the load-
  // bearing fix for stale "needs approval": approval always brings the spinner
  // back. Scan only the bottom region so an answered prompt sitting in
  // scrollback can't re-trigger.
  if (!result.working) {
    const permScope = bottomLines(stripped, PERMISSION_SCAN_LINES);
    if (
      CLAUDE_PERMISSION_TOOL_RE.test(permScope) ||
      CONTEXTUAL_PERMISSION_PATTERNS.some((p) => p.test(permScope)) ||
      ((options.allowTersePermission || hasAgentMarker) &&
        TERSE_PERMISSION_PATTERNS.some((p) => p.test(permScope)))
    ) {
      result.permission = true;
    }
  }

  // Idle prompt frame — the agent is waiting for input. Legacy box frame,
  // or the current `❯` prompt (with a frame corroborator so a stray ❯ in
  // shell output doesn't false-positive), or Codex's `›` composer, or an
  // explicit interrupted marker. A live working spinner overrides idle —
  // both can appear in one buffer while the transcript scrolls.
  if (!result.working) {
    const bottom = bottomLines(stripped, PERMISSION_SCAN_LINES);
    if (
      IDLE_PROMPT_FRAME_RE.test(stripped) ||
      (NEW_IDLE_PROMPT_RE.test(bottom) && IDLE_FRAME_CORROBORATOR_RE.test(bottom)) ||
      ((hasAgentMarker || options.allowTersePermission) && CODEX_IDLE_PROMPT_RE.test(bottom)) ||
      INTERRUPTED_RE.test(bottom)
    ) {
      result.idle = true;
    }
  }

  // Agent banner / brand marker — mark presence even when the chunk has no
  // active spinner, tool line, or input frame. The idle-frame test above
  // implies presence; banners cover the gaps (startup splash, between
  // tool calls, alt-screen redraws that don't include the frame).
  if (
    result.idle ||
    result.working ||
    result.permission ||
    result.tool ||
    hasAgentMarker
  ) {
    result.agentPresent = true;
  }

  return result;
}
