import { useTheme } from "../../contexts/ThemeContext";
import { useConfig } from "../../contexts/ConfigContext";
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

function AgentDot({ agent, resolvedTheme }: { agent: AgentStatus; resolvedTheme: string }) {
  const statusText = agent.permission
    ? "needs approval"
    : agent.active
      ? (agent.tool ? TOOL_LABEL[agent.tool] || agent.tool : "working")
      : "idle";

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[10px] leading-none transition-colors duration-300 ${
        agent.permission
          ? "text-yellow-400"
          : themeClass(resolvedTheme, {
              dark: agent.active ? "text-green-400/80" : "text-white/20",
              light: agent.active ? "text-gray-700" : "text-gray-300",
              modern: agent.active ? "text-green-300/80" : "text-white/15",
            })
      }`}
      title={`${agent.label}: ${statusText}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${agent.permission
        ? "bg-yellow-400 animate-pulse"
        : agent.active
          ? `${themeClass(resolvedTheme, { dark: "bg-green-400", light: "bg-gray-700", modern: "bg-green-300" })} animate-pulse`
          : themeClass(resolvedTheme, { dark: "bg-white/20", light: "bg-gray-300", modern: "bg-white/15" })
      }`} />
      <span className={`max-w-[150px] truncate ${agent.permission ? "text-yellow-300" : themeClass(resolvedTheme, {
        dark: "text-white/30",
        light: "text-gray-400",
        modern: "text-white/20",
      })}`}>
        {agent.label}
      </span>
      <span>{statusText}</span>
    </span>
  );
}

export default function AgentStatusBar() {
  const { resolvedTheme } = useTheme();
  const { config } = useConfig();
  const statuses = useAgentStatuses();

  // Only render if user has enabled the status bar
  if (!config.showAgentStatusBar) return null;

  // Hide entirely when no sessions have had agent activity
  if (statuses.length === 0) return null;

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
        // Active/permission first, then idle; preserve relative order within groups
        const aScore = a.permission ? 2 : a.active ? 1 : 0;
        const bScore = b.permission ? 2 : b.active ? 1 : 0;
        return bScore - aScore;
      }).map(agent => (
        <AgentDot key={agent.sessionId} agent={agent} resolvedTheme={resolvedTheme} />
      ))}
    </div>
  );
}
