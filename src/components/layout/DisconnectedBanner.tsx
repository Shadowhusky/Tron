import { themeClass } from "../../utils/theme";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import type { TerminalSession } from "../../types";

interface DisconnectedBannerProps {
  state: NonNullable<TerminalSession["disconnected"]>;
  label: string;
  /** Disconnected panes across all tabs — "Reconnect all" shows when > 1. */
  disconnectedCount: number;
  resolvedTheme: ResolvedTheme;
  onReconnect: () => void;
  onReconnectAll: () => void;
}

/** Strip above a restored SSH/remote pane that can't reach its host yet. The
 *  pane's last output stays visible below it. */
export function DisconnectedBanner({
  state,
  label,
  disconnectedCount,
  resolvedTheme,
  onReconnect,
  onReconnectAll,
}: DisconnectedBannerProps) {
  const message = state.connecting
    ? `Reconnecting to ${label}…`
    : state.manualOnly
      ? `Couldn't reconnect to ${label}${state.error ? `: ${state.error}` : ""}`
      : `${label} is unreachable — retrying automatically`;
  const buttonClass = `shrink-0 cursor-pointer rounded-md px-2 py-0.5 font-medium transition-colors disabled:cursor-default disabled:opacity-40 ${themeClass(resolvedTheme, {
    dark: "text-blue-400 hover:bg-white/10",
    modern: "text-blue-400 hover:bg-white/10",
    light: "text-blue-600 hover:bg-gray-200",
  })}`;

  return (
    <div
      data-testid="disconnected-banner"
      className={`flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[13px] ${themeClass(resolvedTheme, {
        dark: "border-white/5 bg-amber-500/[0.07] text-gray-300",
        modern: "border-white/[0.08] bg-amber-500/10 text-gray-200",
        light: "border-gray-200 bg-amber-50 text-gray-700",
      })}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.manualOnly && !state.connecting ? "bg-red-400" : "bg-amber-400"} ${state.connecting ? "animate-pulse" : ""}`}
      />
      <span className="min-w-0 flex-1 truncate" title={state.error}>
        {message}
      </span>
      <button onClick={onReconnect} disabled={state.connecting} className={buttonClass}>
        Reconnect
      </button>
      {disconnectedCount > 1 && (
        <button onClick={onReconnectAll} className={buttonClass}>
          Reconnect all ({disconnectedCount})
        </button>
      )}
    </div>
  );
}
