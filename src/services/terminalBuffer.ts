/**
 * Global registry for reading the xterm.js active screen buffer.
 *
 * TUI programs (vim, htop, claude, etc.) use cursor positioning and alternate
 * screen buffers, so raw PTY history is garbled. Reading from xterm's
 * `buffer.active` gives us the rendered screen content instead.
 *
 * Terminal.tsx registers a reader on mount; useAgentRunner reads from it.
 */

export type ScreenBufferReader = (lines: number) => string;

const readers = new Map<string, ScreenBufferReader>();

export function registerScreenBufferReader(
  sessionId: string,
  reader: ScreenBufferReader,
) {
  readers.set(sessionId, reader);
}

export function unregisterScreenBufferReader(sessionId: string) {
  readers.delete(sessionId);
}

export function readScreenBuffer(
  sessionId: string,
  lines: number,
): string | null {
  const reader = readers.get(sessionId);
  if (!reader) return null;
  return reader(lines);
}
