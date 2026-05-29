import { useMemo } from "react";
import { marked } from "marked";

// Minimal, GitHub-flavored markdown with line breaks. Matches the agent
// overlay's configuration so rendered output is consistent app-wide.
marked.setOptions({ breaks: true, gfm: true });

/** Open http(s) links externally instead of navigating the Electron window. */
function handleMarkdownLinkClick(e: React.MouseEvent) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  if (/^https?:\/\//.test(href)) {
    window.electron?.ipcRenderer
      ?.invoke?.("shell.openExternal", href)
      ?.catch?.(() => {});
  }
}

/**
 * Renders a markdown string as styled HTML using the shared `.markdown-content`
 * CSS (headings, lists, code, links, blockquotes). Memoized so identical
 * content isn't re-parsed. Used by the agent overlay and the update modals.
 */
export function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const html = useMemo(() => {
    try {
      return marked.parse(content, { async: false }) as string;
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div
      className={`markdown-content ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleMarkdownLinkClick}
    />
  );
}
