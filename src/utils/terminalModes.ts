/**
 * Terminal input-report mode hygiene.
 *
 * Mouse tracking (DEC private modes 9/1000/1002/1003 + encodings 1005/1006/1015)
 * and focus reporting (1004) make the terminal emit escape sequences on every
 * mouse move / focus change, delivered to the PTY as if typed. A foreground
 * program enables them and is expected to disable them on exit — but when it
 * crashes or is killed (or its disable is lost across a reconnect), the mode
 * lingers. At the shell prompt this turns every mouse move into injected junk
 * like `<35;78;35M` on the command line. See xterm.js #443 and the SGR mouse
 * spec (ESC[<b;x;yM / ...m).
 *
 * These modes are ONLY ever wanted by a live foreground program, never by a
 * bare shell, so it's always safe to force them off when control returns to the
 * shell (alt→normal buffer transition, or a shell-integration prompt marker).
 * We deliberately do NOT touch bracketed-paste (2004) or cursor-key/keypad
 * application modes — shells manage those themselves.
 */

/** DEC private mode numbers that make the terminal report input events. */
const INPUT_REPORT_MODES = [9, 1000, 1002, 1003, 1004, 1005, 1006, 1015] as const;

/** Sequence that disables all mouse-tracking + focus-reporting modes. Write to
 *  xterm (not the PTY) to stop it emitting reports; harmless if already off. */
export const INPUT_REPORT_RESET = INPUT_REPORT_MODES.map((m) => `\x1b[?${m}l`).join("");

/**
 * Remove mouse-tracking / focus-reporting ENABLE sequences from replayed
 * terminal data (a serialized snapshot or raw scrollback). Restoring a shell
 * view must never silently re-arm these — a live TUI that still owns the PTY
 * re-enables them through its own live output, so stripping the replayed copy
 * only prevents dangling enables. Pure + unit-tested.
 */
export function stripInputReportEnables(data: string): string {
  if (!data) return data;
  // eslint-disable-next-line no-control-regex
  return data.replace(/\x1b\[\?(9|1000|1002|1003|1004|1005|1006|1015)h/g, "");
}
