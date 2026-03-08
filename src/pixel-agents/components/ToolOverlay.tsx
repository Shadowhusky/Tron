import { useEffect, useRef, useState } from "react";
import type { OfficeState } from "../engine/officeState";
import type { Character } from "../types";
import { CharacterState, TILE_SIZE } from "../types";
import { CHARACTER_SITTING_OFFSET_PX } from "../constants";

interface ToolOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panX: number;
  panY: number;
}

interface CharLabel {
  id: number;
  x: number;
  y: number;
  label: string;
  status: string;
  color: string;
}

const TOOL_LABELS: Record<string, { label: string; color: string }> = {
  read_file: { label: "reading", color: "#42A5F5" },
  write_file: { label: "writing", color: "#66BB6A" },
  edit_file: { label: "editing", color: "#66BB6A" },
  execute_command: { label: "running command", color: "#FF7043" },
  run_in_terminal: { label: "running", color: "#FF7043" },
  search_dir: { label: "searching", color: "#AB47BC" },
  list_dir: { label: "browsing files", color: "#AB47BC" },
  web_search: { label: "web search", color: "#26C6DA" },
  thinking: { label: "thinking", color: "#7C4DFF" },
  agent: { label: "sub-agent", color: "#FFA726" },
  ask_question: { label: "asking...", color: "#FF9800" },
  read_terminal: { label: "reading output", color: "#42A5F5" },
};

function getStatusInfo(ch: Character): { status: string; color: string } {
  if (ch.matrixEffect === "spawn") return { status: "spawning...", color: "#4CAF50" };
  if (ch.matrixEffect === "despawn") return { status: "leaving...", color: "#F44336" };
  if (ch.bubbleType === "permission") return { status: "needs permission", color: "#FF9800" };
  if (ch.bubbleType === "waiting") return { status: "waiting...", color: "#9E9E9E" };
  if (ch.state === CharacterState.TYPE) {
    if (ch.currentTool) {
      const info = TOOL_LABELS[ch.currentTool];
      if (info) return { status: info.label, color: info.color };
      const name = ch.currentTool.replace(/_/g, " ");
      return { status: name, color: "#42A5F5" };
    }
    return { status: "working...", color: "#7C4DFF" };
  }
  if (ch.state === CharacterState.WALK) return { status: "walking", color: "#66BB6A" };
  return { status: "idle", color: "#9E9E9E" };
}

/** Serialize label array into a comparable string to avoid unnecessary re-renders */
function labelsKey(labels: CharLabel[]): string {
  let key = "";
  for (const l of labels) {
    key += `${l.id}:${l.x | 0},${l.y | 0},${l.status},${l.label};`;
  }
  return key;
}

const OVERLAY_UPDATE_MS = 200; // 5fps is plenty for text labels

const ToolOverlay: React.FC<ToolOverlayProps> = ({
  officeState,
  containerRef,
  zoom,
  panX,
  panY,
}) => {
  const [labels, setLabels] = useState<CharLabel[]>([]);
  const prevKeyRef = useRef("");

  // Update labels on a 200ms interval instead of 60fps RAF
  useEffect(() => {
    const update = () => {
      const container = containerRef.current;
      if (!container || !officeState.layout) return;

      const rect = container.getBoundingClientRect();
      const { cols, rows } = officeState.layout;
      const mapW = cols * TILE_SIZE * zoom;
      const mapH = rows * TILE_SIZE * zoom;
      const ox = (rect.width - mapW) / 2 + panX;
      const oy = (rect.height - mapH) / 2 + panY;

      const newLabels: CharLabel[] = [];
      for (const ch of officeState.characters.values()) {
        if (ch.id !== officeState.selectedId && ch.state === CharacterState.IDLE && !ch.bubbleType) continue;

        const screenX = ox + ch.x * zoom;
        let screenY = oy + ch.y * zoom;
        if (ch.state === CharacterState.TYPE) screenY += CHARACTER_SITTING_OFFSET_PX * zoom;

        const { status, color } = getStatusInfo(ch);
        newLabels.push({
          id: ch.id,
          x: screenX,
          y: screenY - 24 * zoom,
          label: ch.label,
          status,
          color,
        });
      }

      // Only trigger React re-render if labels actually changed
      const key = labelsKey(newLabels);
      if (key !== prevKeyRef.current) {
        prevKeyRef.current = key;
        setLabels(newLabels);
      }
    };

    update();
    const id = setInterval(update, OVERLAY_UPDATE_MS);
    return () => clearInterval(id);
  }, [officeState, containerRef, zoom, panX, panY]);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {labels.map((l) => (
        <div
          key={l.id}
          className="absolute whitespace-nowrap text-center"
          style={{
            left: l.x,
            top: l.y,
            transform: "translate(-50%, -100%)",
            fontSize: Math.max(9, zoom * 3),
          }}
        >
          <div className="bg-black/60 text-white px-1.5 py-0.5 rounded text-[10px] leading-tight">
            <div className="font-medium">{l.label}</div>
            <div className="flex items-center justify-center gap-1 opacity-80">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: l.color }}
              />
              <span>{l.status}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ToolOverlay;
