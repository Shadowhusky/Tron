// ---------------------------------------------------------------------------
// Context Cleaner — sanitize terminal output before sending to AI
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences and terminal control codes */
export function stripAnsi(text: string): string {
  return text
    // Standard ANSI escape codes (colors, cursor, etc.)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    // OSC sequences (title, etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Character set switching
    .replace(/\x1b[()][AB012]/g, "")
    // DEC private modes like [?2004h, [?2004l
    .replace(/\[?\?[0-9;]*[a-zA-Z]/g, "")
    // Remaining non-printable control chars (keep \n and \r)
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "")
    // Carriage return cleanup (overwrite sequences)
    .replace(/\r/g, "\n")
    .trim();
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

/**
 * Detect garbled/corrupted output — high ratio of non-alphanumeric chars,
 * or very long lines with no spaces (binary-like content).
 */
function isGarbledLine(line: string): boolean {
  if (line.length < 10) return false;
  // High ratio of special chars (brackets, backslashes, control-like)
  const specialCount = (line.match(/[<>{}\\|[\]]/g) || []).length;
  if (specialCount / line.length > 0.3) return true;
  // Very long with many "heredoc>" prefixes
  if (line.includes("heredoc>") && line.length > 100) return true;
  return false;
}

/** Collapse garbled/corrupted sections into a summary */
function collapseGarbled(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let garbledCount = 0;

  for (const line of lines) {
    if (isGarbledLine(line)) {
      garbledCount++;
    } else {
      if (garbledCount > 3) {
        result.push(`  ... (${garbledCount} lines of garbled/binary output omitted)`);
      } else if (garbledCount > 0) {
        // Small garbled sections — keep them
        // (already pushed to result by being skipped over)
      }
      garbledCount = 0;
      result.push(line);
    }
  }
  if (garbledCount > 3) {
    result.push(`  ... (${garbledCount} lines of garbled/binary output omitted)`);
  }

  return result.join("\n");
}

/**
 * Truncate individual command outputs that are very long.
 * Keeps the first and last few lines of each output block.
 */
function truncateLongOutputs(text: string, maxLinesPerBlock: number = 30): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let blockLines: string[] = [];
  let inOutput = false;

  const flushBlock = () => {
    if (blockLines.length > maxLinesPerBlock) {
      const kept = Math.floor(maxLinesPerBlock / 2);
      result.push(...blockLines.slice(0, kept));
      result.push(`  ... (${blockLines.length - maxLinesPerBlock} lines truncated)`);
      result.push(...blockLines.slice(-kept));
    } else {
      result.push(...blockLines);
    }
    blockLines = [];
  };

  for (const line of lines) {
    // Detect prompt lines (common patterns like `user@host`, `$`, `%`)
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
  // Flush any remaining block
  if (blockLines.length > 0) flushBlock();

  return result.join("\n");
}

/**
 * Clean terminal output for AI context.
 * Strips ANSI, collapses repeats/garbled content, truncates long outputs.
 */
export function cleanContextForAI(rawHistory: string): string {
  let cleaned = stripAnsi(rawHistory);
  cleaned = collapseRepeats(cleaned);
  cleaned = collapseGarbled(cleaned);
  cleaned = truncateLongOutputs(cleaned);
  // Collapse excessive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}
