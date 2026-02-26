/**
 * Pure functions for terminal state classification and keystroke description.
 * Extracted from ai/index.ts for testability.
 */

import { isWindows } from "./platform";

export type TerminalState = "idle" | "server" | "busy" | "input_needed";

/**
 * Patterns that indicate the terminal is waiting for user input.
 * Matches the last non-empty line of terminal output.
 */
const INPUT_PROMPT_PATTERNS = [
  /password\s*:/i,
  /passphrase\s*:/i,
  /username\s*:/i,
  /user\s*name\s*:/i,
  /login\s*:/i,
  /email\s*:/i,
  /token\s*:/i,
  /api.?key\s*:/i,
  /secret\s*:/i,
  /enter\s+(your\s+)?(password|passphrase|username|name|email|token|key|value|input)/i,
  /\(y\/n\)\s*\??$/i,
  /\[y\/n\]\s*\??$/i,
  /\[yes\/no\]\s*\??$/i,
  /continue\?\s*\(y\/n\)/i,
  /are you sure\?/i,
  /confirm\s*:/i,
  /press enter to continue/i,
  /waiting for input/i,
  /type .+ to continue/i,
];

/**
 * TUI menu patterns — detected across all last 5 lines (not just the last line).
 * These cover npm create, inquirer, prompts, clack, etc.
 *
 * IMPORTANT: Only match ACTIVE interactive elements. Avoid:
 * - ◇ (completed/in-progress step markers, NOT active prompts)
 * - Standalone │ (progress display borders, NOT interactive menus)
 * - > (too common — shell prompts, HTML, etc.)
 */
const TUI_MENU_PATTERNS = [
  /[●○]\s/,              // Radio button markers (clack, prompts) — most reliable signal
  /◆\s+\S/,             // Active prompt marker only (◆ = awaiting input, ◇ = completed — skip ◇)
  /[■□]\s+\S/,          // Checkbox markers
  /[❯►]\s+\S/,          // Selection cursor indicators (not > which is too common)
];

/**
 * Full-screen TUI program detection.
 * Each entry maps a program name to patterns found in its rendered output.
 * Patterns are checked across ALL lines (not just the last few) since TUI
 * programs fill the entire screen.
 */
const TUI_PROGRAM_PATTERNS: { name: string; patterns: RegExp[] }[] = [
  // vim / nvim: mode indicators, tilde empty-line markers, command line
  {
    name: "vim",
    patterns: [
      /-- INSERT --/,
      /-- VISUAL --/,
      /-- REPLACE --/,
      /-- NORMAL --/,
      // 3+ consecutive lines that are just "~" (vim empty buffer)
      /^~\s*\n~\s*\n~\s*$/m,
      // vim command-line prompt at bottom
      /^:[^/].*\s*$/m,
    ],
  },
  // nano: header line + bottom shortcut bar
  {
    name: "nano",
    patterns: [/GNU nano/i, /\^[GOXRWK]\s+\w/],
  },
  // htop / top / btop: process viewer indicators
  {
    name: "htop",
    patterns: [
      /PID\s+USER\s+PR/,  // top/htop header
      /Tasks:\s+\d+/,
      /%Cpu/i,
    ],
  },
  // less / man / pager: bottom status indicators
  {
    name: "less",
    patterns: [
      /^\(END\)\s*$/m,
      /Manual page\s+\S+/,
      /^lines \d+-\d+/m,
    ],
  },
  // lazygit: git TUI
  {
    name: "lazygit",
    patterns: [/Branches\s.*Local Branches/i, /lazygit/i],
  },
  // ranger / nnn / mc: file manager TUI
  {
    name: "file-manager",
    patterns: [/ranger\s+\d+\.\d+/i],
  },
  // AI CLI tools (Claude Code, aider, etc.) — full-screen Ink/React-based CLIs
  {
    name: "ai-cli",
    patterns: [
      /claude/i,                    // Claude Code CLI branding/prompt
      /[╭╰].*─{3,}/,               // Box-drawing message borders (Ink-based CLIs)
      /\b(sonnet|opus|haiku)\b/i,   // Claude model family names in output
      /aider/i,                     // Aider CLI
    ],
  },
];

/**
 * Return an ordered list of exit keystrokes to try for a TUI program.
 * Each entry has: keys to send, wait time (ms), and description.
 * Multi-key entries (e.g. rapid double Ctrl+C) send all keys in one write
 * so the program receives them without a readTerminal gap in between.
 */
export function getTuiExitSequence(tui: string): { keys: string; wait: number; desc: string }[] {
  switch (tui) {
    case "vim":
      return [
        { keys: "\x1b:q!\r", wait: 500, desc: "Esc + :q!" },
        { keys: "\x1b\x1b:q!\r", wait: 500, desc: "double-Esc + :q!" },
        { keys: "\x03\x03", wait: 500, desc: "Ctrl+C x2" },
      ];
    case "nano":
      return [
        { keys: "\x18", wait: 500, desc: "Ctrl+X" },
        { keys: "n", wait: 500, desc: "discard save prompt" },
      ];
    case "less": case "man":
      return [{ keys: "q", wait: 300, desc: "q" }];
    case "htop":
      return [{ keys: "q", wait: 300, desc: "q" }];
    case "lazygit":
      return [
        { keys: "q", wait: 300, desc: "q" },
        { keys: "q", wait: 300, desc: "q (sub-panel)" },
        { keys: "q", wait: 300, desc: "q (outer)" },
      ];
    default:
      // Adaptive sequence — covers AI CLIs (claude, aider), unknown TUIs.
      // Rapid double/triple Ctrl+C sent as a single write (no readTerminal gap).
      return [
        { keys: "\x03", wait: 1000, desc: "Ctrl+C" },
        { keys: "\x03\x03", wait: 1500, desc: "rapid Ctrl+C x2" },
        { keys: "\x04", wait: 1000, desc: "Ctrl+D (EOF)" },
        { keys: "/exit\r", wait: 1000, desc: "/exit command" },
        { keys: "exit\r", wait: 1000, desc: "exit command" },
        { keys: "\x03\x03\x03\x04", wait: 1500, desc: "rapid Ctrl+C x3 + Ctrl+D" },
        { keys: "q", wait: 500, desc: "q key" },
      ];
  }
}

/**
 * Check whether the TUI has exited by examining terminal output.
 * Prioritizes classifyTerminalOutput ("idle") over detectTuiProgram because
 * after a TUI exits, old TUI artifacts (text, box-drawing) may remain in the
 * terminal buffer above the shell prompt, causing false TUI detection.
 */
function isTuiExited(output: string): boolean {
  const state = classifyTerminalOutput(output);
  // If we see a shell prompt, trust it — TUI is gone even if old patterns linger
  if (state === "idle") return true;
  // If TUI patterns are gone from the buffer, it's exited
  if (!detectTuiProgram(output)) return true;
  return false;
}

/**
 * Programmatically attempt to exit a TUI program by trying exit sequences
 * in order, verifying after each attempt.
 * Returns { exited, attempts } — the caller can report what happened.
 */
export async function attemptTuiExit(
  tui: string,
  writeToTerminal: (text: string, isRaw?: boolean) => Promise<void> | void,
  readTerminal: (lines: number) => Promise<string>,
): Promise<{ exited: boolean; attempts: string[] }> {
  const seq = getTuiExitSequence(tui);
  const attempts: string[] = [];
  for (const step of seq) {
    await writeToTerminal(step.keys, true);
    attempts.push(step.desc);
    await new Promise(r => setTimeout(r, step.wait));
    const output = await readTerminal(30);
    if (isTuiExited(output || "")) {
      return { exited: true, attempts };
    }
  }
  return { exited: false, attempts };
}

/**
 * Detect if terminal output looks like a full-screen TUI program.
 * Returns the program name if detected, or null.
 */
export function detectTuiProgram(output: string): string | null {
  for (const { name, patterns } of TUI_PROGRAM_PATTERNS) {
    // Require at least 2 pattern matches for confidence (reduces false positives)
    let matches = 0;
    for (const p of patterns) {
      if (p.test(output)) matches++;
      if (matches >= 2) return name;
    }
    // Single-pattern entries with very distinctive markers are OK with 1 match
    if (matches >= 1 && patterns.length <= 2) return name;
  }
  return null;
}

/**
 * Classify terminal output into one of four states:
 * - "idle": shell prompt visible, ready for commands
 * - "server": dev server / listener running, safe to Ctrl+C
 * - "input_needed": process is waiting for user input (password, confirmation, etc.)
 * - "busy": process actively running (installing, building), should NOT interrupt
 */
export function classifyTerminalOutput(output: string): TerminalState {
  const lines = output.trim().split("\n");
  const lastLines = lines.slice(-3).join("\n");
  const lastLine = lines.filter(l => l.trim()).slice(-1)[0]?.trim() || "";
  // Shell prompt at end → process finished, terminal idle
  if (/[$%#>]\s*$/.test(lastLines) || /^\S+@\S+.*[%$#>]\s*$/m.test(lastLines)) return "idle";
  // Windows PowerShell prompt: PS C:\Users\foo>  or  PS>
  if (/^PS\s+[A-Z]:\\[^>]*>\s*$/m.test(lastLines)) return "idle";
  // Windows cmd.exe prompt: C:\Users\foo>
  if (/^[A-Z]:\\[^>]*>\s*$/m.test(lastLines)) return "idle";
  // Dev server / listener / daemon patterns → safe to Ctrl+C
  if (/localhost:\d+|127\.0\.0\.1:\d+|ready in|listening on|VITE.*ready|press h.*enter|Registered tunnel connection|tunnel.*running|Starting.*server/i.test(lastLines)) return "server";
  // Input prompt detection — process waiting for user to type something
  if (INPUT_PROMPT_PATTERNS.some((p) => p.test(lastLine))) return "input_needed";
  // TUI menu detection — interactive selection menus (npm create, inquirer, clack, etc.)
  // Check across the last 5 lines since TUI menus span multiple lines
  const tuiWindow = lines.slice(-5).join("\n");
  if (TUI_MENU_PATTERNS.some((p) => p.test(tuiWindow))) return "input_needed";
  // Otherwise still busy (installing, building, resolving, etc.)
  return "busy";
}

/**
 * Convert processed keystroke text to a human-readable description.
 * Handles control characters, arrow keys, text+Enter combos.
 */
export function describeKeys(processed: string): string {
  // Use actual control characters for matching (after escape processing)
  const map: Record<string, string> = {
    "\r": "Enter", "\n": "Enter", " ": "Space",
    "\x03": "Ctrl+C", "\x04": "Ctrl+D",
    "\x1a": "Ctrl+Z", "\x1B[A": "Up Arrow", "\x1B[B": "Down Arrow",
    "\x1B[C": "Right Arrow", "\x1B[D": "Left Arrow", "\t": "Tab",
    "\x15": "Ctrl+U", "\x0c": "Ctrl+L",
  };
  for (const [esc, label] of Object.entries(map)) {
    if (processed === esc) return `Pressed ${label}`;
  }
  // Sequences of arrow keys (e.g. Down Arrow x3 then Enter)
  const arrowMatch = processed.match(/^(\x1B\[[ABCD])+\r?$/);
  if (arrowMatch) {
    const arrows = processed.match(/\x1B\[([ABCD])/g) || [];
    const dirMap: Record<string, string> = { A: "Up", B: "Down", C: "Right", D: "Left" };
    const desc = arrows.map(a => dirMap[a.charAt(2)] || "Arrow").join(", ");
    return processed.endsWith("\r") ? `${desc} + Enter` : desc;
  }
  if (processed.endsWith("\r") || processed.endsWith("\n")) {
    const text = processed.slice(0, -1);
    return text ? `Typed "${text}" + Enter` : "Pressed Enter";
  }
  // Strip control chars for display
  const printable = processed.replace(/[\x00-\x1F\x7F]/g, "");
  if (printable && printable.length <= 30) return `Typed "${printable}"`;
  if (printable) return `Typed ${printable.length} characters`;
  return `Sent ${processed.length} keystrokes`;
}

/**
 * Scaffolding command prefixes — if a new command shares a prefix with an
 * already-executed command, it's likely the agent re-running project creation
 * with slightly different args (e.g. adding --template).
 */
const SCAFFOLD_PREFIXES = [
  "npm create", "npx create", "npm init", "yarn create", "pnpm create", "bun create",
  "npx degit", "npx giget",
  "cargo init", "cargo new",
  "django-admin startproject", "rails new", "dotnet new",
  "flutter create", "expo init",
];

/** Strip "cd /path && " prefix from a command for comparison. */
function stripCdPrefix(cmd: string): string {
  return cmd.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "");
}

/**
 * Returns true if `cmd` is a scaffolding command that was already run
 * (possibly with different args). Strips cd prefixes before comparing.
 */
export function isDuplicateScaffold(cmd: string, executedCommands: Set<string>): boolean {
  const trimmed = stripCdPrefix(cmd).trim().toLowerCase();
  for (const prefix of SCAFFOLD_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      // Check if any previously executed command shares this scaffold prefix
      for (const prev of executedCommands) {
        if (stripCdPrefix(prev).trim().toLowerCase().startsWith(prefix)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Regex for project-scoped commands that should auto-cd into lastWriteDir.
 */
export const PROJECT_CMD_RE = /^(npm|npx|yarn|pnpm|bun|pip|pip3|cargo|make|gradle|gradlew|mvn|dotnet|go\s+build|go\s+run|go\s+test)\b/;

/**
 * Returns the command with auto-cd prepended if applicable.
 * - lastWriteDir must be set (from previous write_file/mkdir)
 * - command must match PROJECT_CMD_RE
 * - command must not already contain "cd "
 */
export function autoCdCommand(cmd: string, lastWriteDir: string): string {
  if (lastWriteDir && PROJECT_CMD_RE.test(cmd.trim()) && !cmd.includes("cd ")) {
    // Don't auto-cd scaffold commands — they create their own directory
    const trimmedLower = cmd.trim().toLowerCase();
    if (SCAFFOLD_PREFIXES.some(p => trimmedLower.startsWith(p))) return cmd;
    const sep = isWindows() ? " ; " : " && ";
    return `cd ${lastWriteDir}${sep}${cmd}`;
  }
  return cmd;
}
