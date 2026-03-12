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

// --- Viewport text reader (returns only the currently visible lines) ---

export type ViewportTextReader = () => string;

const viewportTextReaders = new Map<string, ViewportTextReader>();

export function registerViewportTextReader(
  sessionId: string,
  reader: ViewportTextReader,
) {
  viewportTextReaders.set(sessionId, reader);
}

export function unregisterViewportTextReader(sessionId: string) {
  viewportTextReaders.delete(sessionId);
}

export function readViewportText(sessionId: string): string {
  const reader = viewportTextReaders.get(sessionId);
  if (!reader) return "";
  return reader();
}

// --- Alternate buffer state (for TUI detection) ---

export type AlternateBufferReader = () => boolean;

const alternateBufferReaders = new Map<string, AlternateBufferReader>();

export function registerAlternateBufferReader(
  sessionId: string,
  reader: AlternateBufferReader,
) {
  alternateBufferReaders.set(sessionId, reader);
}

export function unregisterAlternateBufferReader(sessionId: string) {
  alternateBufferReaders.delete(sessionId);
}

/** Returns true if the terminal is in alternate screen buffer (TUI app running) */
export function isAlternateBuffer(sessionId: string): boolean {
  const reader = alternateBufferReaders.get(sessionId);
  return reader ? reader() : false;
}

// --- Selection reader (for context menu Copy / Ask Agent / Add to Input) ---

export type SelectionReader = () => string;

const selectionReaders = new Map<string, SelectionReader>();

export function registerSelectionReader(
  sessionId: string,
  reader: SelectionReader,
) {
  selectionReaders.set(sessionId, reader);
}

export function unregisterSelectionReader(sessionId: string) {
  selectionReaders.delete(sessionId);
}

export function getTerminalSelection(sessionId: string): string {
  const reader = selectionReaders.get(sessionId);
  if (!reader) return "";
  return reader();
}
