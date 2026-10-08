import type { LayoutNode, Tab } from "../types";
import { extractFilename } from "./platform";

const GENERIC_TITLE_RE = /^(claude( code)?|codex|openai codex)$/i;
/** Agent status/spinner glyph prefix ("✳ Fix login bug", "◐ Fix login bug", "⠋ tron"). */
const AGENT_TITLE_GLYPH_RE = /^[✳✢✶✻✽·◐◑◒◓⠀-⣿]\s/;
const TITLE_WORKING_RE = /^[◐◑◒◓⠀-⣿]\s/;
const TITLE_IDLE_RE = /^✳\s/;

/**
 * Activity encoded in an agent CLI's title: Claude Code spins ◐◑◒◓ while
 * working and shows ✳ when idle; Codex spins braille. More reliable than
 * screen-scraping since Claude Code ≥2.1 dropped "esc to interrupt".
 */
export function titleActivity(title: string): "working" | "idle" | null {
  if (TITLE_WORKING_RE.test(title)) return "working";
  if (TITLE_IDLE_RE.test(title)) return "idle";
  return null;
}

/**
 * Whether a terminal title belongs to an agent CLI. Claude Code renders inline
 * and marks its titles with a status glyph; full-screen TUIs (Codex) own the
 * alternate screen. Plain shell titles are neither.
 */
export function isAgentTitle(title: string, inAlternateBuffer: boolean): boolean {
  return inAlternateBuffer || AGENT_TITLE_GLYPH_RE.test(title);
}

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

export type AgentTransition = "finished" | "needs-approval";

/** A turn shorter than this is a detection blip, not work worth a notification. */
export const MIN_WORKING_MS = 5000;
/** Idle this long ends the turn — shorter pauses (spinner gaps) are mid-turn. */
export const FINISH_SETTLE_MS = 3000;

export interface AgentWatch {
  permission: boolean;
  /** When the current turn started; null between turns. */
  turnStart: number | null;
  /** When the agent last went idle within the turn. */
  idleSince: number | null;
}

/**
 * Advance one external agent CLI's notification state. Emits "needs-approval"
 * as soon as a prompt appears, and "finished" once per turn after it stays
 * idle for FINISH_SETTLE_MS — only if the turn did MIN_WORKING_MS of work.
 */
export function stepAgentWatch(
  prev: AgentWatch | undefined,
  next: { active: boolean; permission: boolean },
  now: number,
): { watch: AgentWatch; event: AgentTransition | null } {
  const p = prev ?? { permission: false, turnStart: null, idleSince: null };
  const event: AgentTransition | null = next.permission && !p.permission ? "needs-approval" : null;
  if (next.active) {
    return { watch: { permission: next.permission, turnStart: p.turnStart ?? now, idleSince: null }, event };
  }
  if (p.turnStart === null) return { watch: { permission: next.permission, turnStart: null, idleSince: null }, event };
  const idleSince = p.idleSince ?? now;
  if (now - idleSince < FINISH_SETTLE_MS) {
    return { watch: { permission: next.permission, turnStart: p.turnStart, idleSince }, event };
  }
  const worked = idleSince - p.turnStart >= MIN_WORKING_MS;
  return {
    watch: { permission: next.permission, turnStart: null, idleSince: null },
    event: event ?? (worked ? "finished" : null),
  };
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
