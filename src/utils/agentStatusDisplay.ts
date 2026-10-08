import type { LayoutNode, Tab } from "../types";
import { extractFilename } from "./platform";

const GENERIC_TITLE_RE = /^(claude( code)?|codex|openai codex)$/i;

/**
 * Turn a terminal title set by an agent CLI into a session name. Claude Code
 * prefixes its title with a status/spinner glyph ("✳ Fix login bug"); the bare
 * product name means the session hasn't been named yet.
 */
export function agentNameFromTitle(raw: string): string | null {
  const name = raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim();
  if (!name || GENERIC_TITLE_RE.test(name)) return null;
  return name;
}

export function resolveAgentLabel(opts: {
  cliTitle?: string | null;
  brand?: string | null;
  cwd?: string | null;
  tabTitle?: string | null;
}): string {
  const fromTitle = opts.cliTitle ? agentNameFromTitle(opts.cliTitle) : null;
  if (fromTitle) return fromTitle;
  if (opts.brand) {
    const folder = opts.cwd ? extractFilename(opts.cwd.replace(/[\\/]+$/, "")) : "";
    return folder ? `${opts.brand} · ${folder}` : opts.brand;
  }
  return opts.tabTitle || "Terminal";
}

/** Compact elapsed time, at most four characters so the status slot never reflows. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  if (h >= 10) return `${h}h`;
  return `${h}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** Session ids in on-screen order: tab order, then depth-first pane order. */
export function layoutSessionOrder(tabs: Tab[]): string[] {
  const out: string[] = [];
  const walk = (node: LayoutNode) => {
    if (node.type === "leaf") out.push(node.sessionId);
    else node.children.forEach(walk);
  };
  tabs.forEach((t) => walk(t.root));
  return out;
}
