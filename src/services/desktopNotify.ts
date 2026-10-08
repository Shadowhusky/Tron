// Synced from config by App — AgentStore (not React) can't read ConfigContext.
let enabled = true;

export function setDesktopNotificationsEnabled(on: boolean): void {
  enabled = on;
}

/**
 * OS notification while Tron isn't the focused window — in-app toasts go
 * unseen then. Clicking it brings the session's tab forward.
 */
export function notifyDesktop(body: string, sessionId: string): void {
  if (!enabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.hasFocus()) return;
  const n = new Notification("Tron", { body });
  n.onclick = () => {
    window.focus();
    window.dispatchEvent(new CustomEvent("tron:focusSession", { detail: { sessionId } }));
    n.close();
  };
}
