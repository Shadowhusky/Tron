import { themeClass } from "../../../utils/theme";
import type { ResolvedTheme } from "../../../contexts/ThemeContext";
import type { SSHConnectionStatus } from "../../../types";

interface SSHStatusBadgeProps {
  status: SSHConnectionStatus;
  label: string; // e.g. "user@host"
  resolvedTheme: ResolvedTheme;
  onReconnect?: () => void;
}

const SSHStatusBadge: React.FC<SSHStatusBadgeProps> = ({
  status,
  label,
  resolvedTheme,
  onReconnect,
}) => {
  const dotColor =
    status === "connected" ? "bg-green-400" :
    status === "connecting" || status === "reconnecting" ? "bg-yellow-400 animate-pulse" :
    "bg-red-400";

  const statusText =
    status === "connected" ? label :
    status === "connecting" ? "Connecting..." :
    status === "reconnecting" ? "Reconnecting..." :
    "Disconnected";

  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs ${themeClass(resolvedTheme, {
      dark: "bg-white/5 text-gray-300",
      modern: "bg-white/5 text-gray-300",
      light: "bg-gray-100 text-gray-600",
    })}`}>
      <div className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span className="truncate max-w-[150px]">{statusText}</span>
      {status === "disconnected" && onReconnect && (
        <button
          onClick={onReconnect}
          className={`ml-1 px-1.5 py-0.5 rounded text-xs transition-colors ${themeClass(resolvedTheme, {
            dark: "hover:bg-white/10 text-purple-400",
            modern: "hover:bg-white/10 text-purple-400",
            light: "hover:bg-gray-200 text-purple-600",
          })}`}
        >
          Reconnect
        </button>
      )}
    </div>
  );
};

export default SSHStatusBadge;
