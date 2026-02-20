/**
 * Pure functions for terminal state classification and keystroke description.
 * Extracted from ai/index.ts for testability.
 */

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
  return cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
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
    return `cd ${lastWriteDir} && ${cmd}`;
  }
  return cmd;
}
