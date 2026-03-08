import { useMemo, useState } from "react";
import { X, Users, Bug } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { useLayout } from "../../contexts/LayoutContext";
import { themeClass } from "../../utils/theme";
import { OfficeState } from "../engine/officeState";
import { useTronAgentBridge } from "../hooks/useTronAgentBridge";
import { CharacterState } from "../types";
import OfficeCanvas from "./OfficeCanvas";

interface PixelAgentsPaneProps {
  sessionId: string;
}

const THEME_BG: Record<string, string> = {
  dark: "#1E1E2E",
  light: "#E8E0D0",
  modern: "#0A0A1E",
};

const STATE_NAMES: Record<number, string> = {
  [CharacterState.IDLE]: "IDLE",
  [CharacterState.WALK]: "WALK",
  [CharacterState.TYPE]: "TYPE",
};

const PixelAgentsPane: React.FC<PixelAgentsPaneProps> = ({ sessionId }) => {
  const { resolvedTheme } = useTheme();
  const { closePane } = useLayout();
  const [showDebug, setShowDebug] = useState(false);

  const officeState = useMemo(() => new OfficeState(), []);

  // Bridge Tron agent state -> office characters
  const debugInfo = useTronAgentBridge(officeState);

  // Expose for e2e testing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__pixelAgentsOfficeState = officeState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__pixelAgentsDebug = debugInfo;

  const bgColor = THEME_BG[resolvedTheme] || THEME_BG.dark;

  return (
    <div
      data-testid="pixel-agents-pane"
      className={`flex flex-col h-full w-full ${themeClass(resolvedTheme, {
        dark: "bg-[#1E1E2E]",
        light: "bg-[#E8E0D0]",
        modern: "bg-[#0A0A1E]",
      })}`}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between px-3 py-1.5 shrink-0 border-b ${themeClass(
          resolvedTheme,
          {
            dark: "border-white/10 bg-black/20",
            light: "border-gray-200 bg-white/60",
            modern: "border-purple-500/20 bg-black/30",
          },
        )}`}
      >
        <div className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 opacity-60" />
          <span
            className={`text-xs font-medium ${themeClass(resolvedTheme, {
              dark: "text-white/70",
              light: "text-gray-600",
              modern: "text-purple-300/70",
            })}`}
          >
            Pixel Agents
          </span>
          <button
            onClick={() => setShowDebug(d => !d)}
            className={`p-0.5 rounded transition-colors ${themeClass(resolvedTheme, {
              dark: "text-white/20 hover:text-white/50",
              light: "text-gray-300 hover:text-gray-500",
              modern: "text-purple-300/20 hover:text-purple-300/50",
            })}`}
            title="Toggle debug info"
          >
            <Bug className="h-3 w-3" />
          </button>
        </div>
        <button
          onClick={() => closePane(sessionId)}
          className={`p-0.5 rounded hover:bg-white/10 transition-colors ${themeClass(
            resolvedTheme,
            {
              dark: "text-white/40 hover:text-white/70",
              light: "text-gray-400 hover:text-gray-600",
              modern: "text-purple-300/40 hover:text-purple-300/70",
            },
          )}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Debug overlay */}
      {showDebug && (
        <div className={`px-3 py-2 text-[10px] font-mono border-b shrink-0 ${themeClass(resolvedTheme, {
          dark: "bg-black/40 border-white/10 text-green-400/80",
          light: "bg-gray-100 border-gray-200 text-gray-700",
          modern: "bg-black/50 border-purple-500/20 text-green-300/80",
        })}`}>
          <div>store: {debugInfo.storeExists ? "OK" : "NULL"} | id: {debugInfo.storeId} | v: {debugInfo.version} | sessions: {debugInfo.layoutSessionCount}</div>
          <div className="opacity-60">terminal active: {debugInfo.terminalActive.length === 0 ? "(none)" : debugInfo.terminalActive.join(", ")}</div>
          {debugInfo.trackedSessions.length === 0 && <div className="opacity-50">No terminal sessions tracked</div>}
          {debugInfo.trackedSessions.map(s => (
            <div key={s.sessionId}>
              [{s.sessionId}] char#{s.charId} | agent: {s.agentActive ? "RUN" : "-"} | term: {s.termActive ? "ACTIVE" : "-"} | tool: {s.tool ?? "-"} | char: {STATE_NAMES[s.charState] ?? s.charState} | active: {s.isActive ? "YES" : "no"}
            </div>
          ))}
        </div>
      )}

      {/* Canvas area */}
      <div className="flex-1 relative min-h-0">
        <OfficeCanvas
          officeState={officeState}
          bgColor={bgColor}
          isVisible={true}
        />
      </div>
    </div>
  );
};

export default PixelAgentsPane;
