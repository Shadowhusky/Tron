/**
 * Clipboard write with a fallback that works in insecure contexts.
 * navigator.clipboard is undefined on plain-http origins (remote/web mode
 * served over http://<lan-ip>), so fall back to a hidden textarea +
 * execCommand("copy"), which still works there for user-triggered events.
 */
export function writeClipboardText(text: string): void {
  const deviceCopy = (t: string) => {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    try { document.execCommand("copy"); } catch { /* ignored */ }
    ta.remove();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => deviceCopy(text));
  } else {
    deviceCopy(text);
  }
}
