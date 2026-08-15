/**
 * Pure output-capture cleaning for execInTerminal. No electron/node imports so
 * vitest (src/__tests__/execOutput.test.ts) can cover it directly.
 * server/handlers/terminal.ts mirrors the OSC handling (rootDir isolation
 * prevents a shared import).
 */

/** Remove COMPLETE OSC sequences (ESC ] ... BEL|ST), payload included. */
export function stripOscSequences(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
}

/**
 * Extract a command's real output from the raw PTY capture of a sentinel exec.
 *
 * Order matters: complete OSC sequences must go FIRST. The shell integration's
 * TronBlockStart marker embeds the URL-encoded command line, which contains the
 * sentinel VERBATIM (letters/underscores aren't %-encoded). The generic ESC
 * strip below only removes "ESC ]", so without the full-sequence strip the
 * marker payload leaks as plain text and the sentinel cut lands on the marker's
 * copy — before the real output, which is then thrown away entirely (log
 * f62ad06c2b: every quiet one-line command returned only "1337;TronBlockStart;…"
 * and the agent looped re-validating package.json until escalation; commands
 * with \r-progress output survived only because the \r-overwrite pass happened
 * to erase the leaked marker).
 *
 * The cut also requires the sentinel to be followed by exit-code DIGITS — the
 * command echo's copy is followed by "%d", so it can never be mistaken for the
 * printf'd sentinel output when zle redraws didn't erase the echo.
 */
export function cleanExecCapture(output: string, sentinel: string): string {
  let captured = stripOscSequences(output);
  // eslint-disable-next-line no-control-regex
  captured = captured.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  // Handle \r overwrites (keep only text after last \r on each segment)
  captured = captured.replace(/[^\n]*\r(?!\n)/g, "");

  const sentinelEscaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sentinelOut = captured.match(new RegExp(`${sentinelEscaped}\\d`));
  if (sentinelOut?.index !== undefined) {
    captured = captured.slice(0, sentinelOut.index);
  }

  // Strip the command echo line (first line) which includes the sentinel printf
  const firstNewline = captured.indexOf("\n");
  if (firstNewline >= 0) {
    captured = captured.slice(firstNewline + 1);
  }

  // Strip any remaining sentinel fragments (Unix printf + Windows Write-Host)
  captured = captured.replace(/; printf '\\n__TRON_DONE_[^']*' \$\?/g, "");
  captured = captured.replace(/; printf [^\n]*$/m, "");
  captured = captured.replace(/; Write-Host ["']__TRON_DONE_[^"']*\$LASTEXITCODE["']/g, "");
  captured = captured.replace(/; Write-Host [^\n]*$/m, "");
  captured = captured.replace(/__TRON_DONE_[a-z0-9]+__(?:%d|\d+)?/g, "");
  // eslint-disable-next-line no-control-regex
  captured = captured.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  captured = captured.trim();

  if (captured.length > 8000) {
    captured = captured.slice(0, 4000) + "\n...(truncated)...\n" + captured.slice(-4000);
  }
  return captured;
}
