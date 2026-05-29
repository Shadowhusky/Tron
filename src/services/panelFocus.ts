/**
 * Tracks which terminal pane (sessionId) most recently had focus, so global
 * hotkeys (e.g. toggle panel chrome) can act on the pane the user is actually
 * looking at — important with split panes where several TerminalPanes are
 * mounted at once. Each TerminalPane reports focus via setFocusedSession on
 * pointerdown / focusin; hotkey handlers read getFocusedSession to decide
 * whether they own the keystroke.
 */

let focusedSessionId: string | null = null;

export function setFocusedSession(id: string | null): void {
  focusedSessionId = id;
}

export function getFocusedSession(): string | null {
  return focusedSessionId;
}
