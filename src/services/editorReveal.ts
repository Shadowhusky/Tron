/**
 * "Jump to line" requests for editor panes. Clicking `src/a.ts:12` opens or
 * focuses an editor; a pane that isn't mounted yet consumes the request when
 * CodeMirror is created, an open one reacts to the event immediately.
 */
export const EDITOR_REVEAL_EVENT = "tron:editorReveal";

const pending = new Map<string, number>();

export function requestEditorReveal(filePath: string, line: number) {
  pending.set(filePath, line);
  window.dispatchEvent(new CustomEvent(EDITOR_REVEAL_EVENT, { detail: { filePath, line } }));
}

export function takeEditorReveal(filePath: string): number | undefined {
  const line = pending.get(filePath);
  pending.delete(filePath);
  return line;
}
