import { useTheme } from "../../contexts/ThemeContext";
import { useConfig } from "../../contexts/ConfigContext";
import { useLayout } from "../../contexts/LayoutContext";
import type { LayoutNode } from "../../types";
import { themeClass } from "../../utils/theme";
import { useAgentStatuses, type AgentStatus } from "../hooks/useTronAgentBridge";

/** Tool → display label */
const TOOL_LABEL: Record<string, string> = {
  read_file: "reading",
  write_file: "writing",
  edit_file: "editing",
  execute_command: "running cmd",
  search_dir: "searching",
  list_dir: "browsing",
  web_search: "web search",
  thinking: "thinking",
  agent: "sub-agent",
  ask_question: "asking",
  read_terminal: "reading output",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function AgentDot({ agent, resolvedTheme, onClick }: { agent: AgentStatus; resolvedTheme: string; onClick?: () => void }) {
  const statusText = agent.permission
    ? "needs approval"
    : agent.active
      ? (agent.tool ? TOOL_LABEL[agent.tool] || agent.tool : "working")
      : "idle";

  // Tokens / elapsed are surfaced when an external agent (Claude Code etc.)
  // is currently working — they come from the spinner suffix.
  const meta: string[] = [];
  if (agent.active && agent.elapsedSeconds != null) meta.push(`${agent.elapsedSeconds}s`);
  if (agent.active && agent.tokens != null) meta.push(`${formatTokens(agent.tokens)} tok`);
  const metaText = meta.length > 0 ? ` · ${meta.join(" · ")}` : "";

  const tooltip = `${agent.label}: ${statusText}${metaText} — click to switch`;

  return (
    <span
      data-testid={`agent-dot-${agent.sessionId}`}
      data-status={agent.permission ? "needs-approval" : agent.active ? "active" : "idle"}
      data-tool={agent.tool ?? ""}
      className={`inline-flex items-center gap-1 font-mono text-[10px] leading-none transition-colors duration-300 cursor-pointer rounded px-1 -mx-1 ${
        themeClass(resolvedTheme, {
          dark: "hover:bg-white/5",
          light: "hover:bg-gray-200/60",
          modern: "hover:bg-white/5",
        })
      } ${
        agent.permission
          ? "text-yellow-400"
          : themeClass(resolvedTheme, {
              dark: agent.active ? "text-green-400/80" : "text-white/20",
              light: agent.active ? "text-green-700" : "text-gray-400",
              modern: agent.active ? "text-green-300/80" : "text-white/15",
            })
      }`}
      title={tooltip}
      onClick={onClick}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${agent.permission
        ? "bg-yellow-400 animate-pulse"
        : agent.active
          ? `${themeClass(resolvedTheme, { dark: "bg-green-400", light: "bg-green-500", modern: "bg-green-300" })} animate-pulse`
          : themeClass(resolvedTheme, { dark: "bg-white/20", light: "bg-gray-300", modern: "bg-white/15" })
      }`} />
      <span className={`max-w-[150px] truncate ${agent.permission ? "text-yellow-300" : themeClass(resolvedTheme, {
        dark: "text-white/30",
        light: "text-gray-500",
        modern: "text-white/20",
      })}`}>
        {agent.label}
      </span>
      <span>{statusText}</span>
      {metaText && (
        <span className={themeClass(resolvedTheme, {
          dark: "text-white/25",
          light: "text-gray-400",
          modern: "text-white/20",
        })}>
          {metaText}
        </span>
      )}
    </span>
  );
}

/** Check if a layout tree contains a given sessionId. */
function treeHasSession(node: LayoutNode, sessionId: string): boolean {
  if (node.type === "leaf") return node.sessionId === sessionId;
  return node.children.some(c => treeHasSession(c, sessionId));
}

export default function AgentStatusBar() {
  const { resolvedTheme } = useTheme();
  const { config } = useConfig();
  const { tabs, selectTab } = useLayout();
  const statuses = useAgentStatuses();

  if (!config.showAgentStatusBar) return null;
  if (statuses.length === 0) return null;

  const switchToAgent = (sessionId: string) => {
    const tab = tabs.find(t => treeHasSession(t.root, sessionId));
    if (tab) selectTab(tab.id);
  };

  return (
    <div
      data-testid="agent-status-bar"
      className={`flex items-center gap-3 px-3 py-0.5 shrink-0 overflow-hidden border-b font-mono ${themeClass(
        resolvedTheme,
        {
          dark: "border-white/5 bg-[#0a0a0a]",
          light: "border-gray-100 bg-gray-50",
          modern: "border-white/4 bg-[#060610]",
        },
      )}`}
    >
      {[...statuses].sort((a, b) => {
        const aScore = a.permission ? 2 : a.active ? 1 : 0;
        const bScore = b.permission ? 2 : b.active ? 1 : 0;
        return bScore - aScore;
      }).map(agent => (
        <AgentDot
          key={agent.sessionId}
          agent={agent}
          resolvedTheme={resolvedTheme}
          onClick={() => switchToAgent(agent.sessionId)}
        />
      ))}
    </div>
  );
}
