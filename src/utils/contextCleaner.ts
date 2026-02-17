// ---------------------------------------------------------------------------
// Context Cleaner — sanitize terminal output before sending to AI
// ---------------------------------------------------------------------------

/**
 * Clean ANSI codes and control characters, resolving backspaces and overwrites.
 * This is now a wrapper around the terminal emulator for better results.
 */
export function stripAnsi(text: string): string {
  return emulateTerminal(text);
}

/**
 * Lightweight Terminal Emulator
 * Reconstructs the visual state of the terminal by processing a stream of text
 * and control codes, handling overwrites (\r), backspaces (\b), and basic cursor movement.
 */
function emulateTerminal(text: string): string {
  const lines: string[][] = [[]]; // 2D character buffer
  let cursorX = 0;
  let cursorY = 0;

  // Helper to ensure line exists
  const ensureLine = (y: number) => {
    while (lines.length <= y) lines.push([]);
  };

  // Regex to tokenize input:
  // 1. CSI sequences: \x1b[ ... char
  // 2. OSC sequences: \x1b] ... \x07 or \x1b\
  // 3. Control chars: \r, \n, \b, \t
  // 4. Regular text (one or more chars)
  const tokenRegex =
    /(\x1b\[[0-9;?]*[a-zA-Z])|(\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))|([\r\n\b\t])|([^\x1b\r\n\b\t]+)/g;

  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    const [_, csi, osc, control, literal] = match;

    if (csi) {
      // Handle CSI Sequences
      const type = csi.slice(-1);
      const params = csi.slice(2, -1).split(";").map(Number);

      if (type === "K") {
        // Erase Line (0=end, 1=start, 2=all) - default 0
        const mode = params[0] || 0;
        ensureLine(cursorY);
        if (mode === 0) {
          lines[cursorY] = lines[cursorY].slice(0, cursorX);
        } else if (mode === 1) {
          // Fill start to cursor with spaces
          for (let i = 0; i < cursorX; i++) lines[cursorY][i] = " ";
        } else if (mode === 2) {
          lines[cursorY] = [];
        }
      } else if (type === "C") {
        // Cursor Forward
        const count = params[0] || 1;
        cursorX += count;
      } else if (type === "D") {
        // Cursor Back
        const count = params[0] || 1;
        cursorX = Math.max(0, cursorX - count);
      } else if (type === "A") {
        // Cursor Up
        const count = params[0] || 1;
        cursorY = Math.max(0, cursorY - count);
      } else if (type === "B") {
        // Cursor Down
        cursorY += params[0] || 1;
      } else if (type === "H" || type === "f") {
        // Cursor Position
        cursorY = Math.max(0, (params[0] || 1) - 1);
        cursorX = Math.max(0, (params[1] || 1) - 1);
      }
      // Ignore colors (m) and other modes
    } else if (osc) {
      // Ignore OSC sequences (window titles, etc.)
    } else if (control) {
      if (control === "\r") {
        cursorX = 0;
      } else if (control === "\n") {
        cursorY++;
        // x usually resets on newline in unix terminals unless strictly raw, but let's assume CR+LF or just LF
        // In raw data often \r\n is used. If we have \n without \r, x typically stays?
        // Let's assume standard behavior: \n moves down, \r moves left.
        // If text has \n but no \r, we shouldn't reset X?
        // Actually for cleaning purpose assuming x=0 on \n is safer to avoid jagged text if \r is missing.
        // But `ls` output often has `\n` without `\r`? No, PTY sends `\r\n`.
        // Let's keep X as is for \n, relying on \r to reset it.
      } else if (control === "\b") {
        cursorX = Math.max(0, cursorX - 1);
      } else if (control === "\t") {
        const tabSize = 8; // Standard terminal tab width
        const nextTab = Math.ceil((cursorX + 1) / tabSize) * tabSize;
        // Fill properly with spaces
        ensureLine(cursorY);
        while (cursorX < nextTab) {
          lines[cursorY][cursorX] = " ";
          cursorX++;
        }
      }
    } else if (literal) {
      ensureLine(cursorY);
      for (const char of literal) {
        lines[cursorY][cursorX] = char;
        cursorX++;
      }
    }
  }

  // Render lines to string
  return lines
    .map((line) => line.join("").trimEnd()) // Trim trailing spaces
    .join("\n");
}

/** Detect and collapse repeated/garbled lines */
function collapseRepeats(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let repeatCount = 0;
  let lastLine = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === lastLine && trimmed.length > 0) {
      repeatCount++;
      if (repeatCount <= 1) {
        result.push(line); // Keep first repeat
      }
      // Skip further repeats
    } else {
      if (repeatCount > 1) {
        result.push(`  ... (${repeatCount} identical lines omitted)`);
      }
      repeatCount = 0;
      lastLine = trimmed;
      result.push(line);
    }
  }
  if (repeatCount > 1) {
    result.push(`  ... (${repeatCount} identical lines omitted)`);
  }

  return result.join("\n");
}

/** Detect garbled/corrupted output */
function isGarbledLine(line: string): boolean {
  if (line.length < 10) return false;
  const specialCount = (line.match(/[<>{}\\|[\]]/g) || []).length;
  if (specialCount / line.length > 0.3) return true;
  if (line.includes("heredoc>") && line.length > 100) return true;
  return false;
}

/** Collapse garbled/corrupted sections */
function collapseGarbled(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let garbledCount = 0;

  for (const line of lines) {
    if (isGarbledLine(line)) {
      garbledCount++;
    } else {
      if (garbledCount > 3) {
        result.push(
          `  ... (${garbledCount} lines of garbled/binary output omitted)`,
        );
      } else if (garbledCount > 0) {
        // Small garbled sections — keep them
      }
      garbledCount = 0;
      result.push(line);
    }
  }
  if (garbledCount > 3) {
    result.push(
      `  ... (${garbledCount} lines of garbled/binary output omitted)`,
    );
  }

  return result.join("\n");
}

/** Truncate individual command outputs */
function truncateLongOutputs(
  text: string,
  maxLinesPerBlock: number = 30,
): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let blockLines: string[] = [];
  let inOutput = false;

  const flushBlock = () => {
    if (blockLines.length > maxLinesPerBlock) {
      const kept = Math.floor(maxLinesPerBlock / 2);
      result.push(...blockLines.slice(0, kept));
      result.push(
        `  ... (${blockLines.length - maxLinesPerBlock} lines truncated)`,
      );
      result.push(...blockLines.slice(-kept));
    } else {
      result.push(...blockLines);
    }
    blockLines = [];
  };

  for (const line of lines) {
    const isPrompt = /^[^\s]*[@$%#>]\s/.test(line) || /^\s*\$\s/.test(line);

    if (isPrompt) {
      if (inOutput) {
        flushBlock();
        inOutput = false;
      }
      result.push(line);
    } else {
      inOutput = true;
      blockLines.push(line);
    }
  }
  if (blockLines.length > 0) flushBlock();

  return result.join("\n");
}

/**
 * Clean terminal output for AI context.
 * Uses a lightweight terminal emulator to resolve backspaces, overwrites,
 * and cursor movements, producing a clean "visual" history.
 */
export function cleanContextForAI(rawHistory: string): string {
  // 1. Emulate terminal to handle \r, \b, and cursor moves
  let cleaned = emulateTerminal(rawHistory);

  // 2. Collapse visual repeats and garbled text
  cleaned = collapseRepeats(cleaned);
  cleaned = collapseGarbled(cleaned);
  cleaned = truncateLongOutputs(cleaned);

  // 3. Strip common prompt prefixes to reduce context noise
  cleaned = cleaned.replace(/^➜\s+/gm, "");
  cleaned = cleaned.replace(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+.*[%$#]\s*/gm, "");
  cleaned = cleaned.replace(/^[%$#>]\s*/gm, "");

  // 4. Collapse excessive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}
