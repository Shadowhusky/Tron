import { useState, useRef, useCallback, useEffect, lazy, Suspense } from "react";
import type { LayoutNode } from "../../types";
import { useLayout } from "../../contexts/LayoutContext";
import { useTheme } from "../../contexts/ThemeContext";
import { snapDividerPosition } from "../../utils/paneNav";
import SettingsPane from "../../features/settings/components/SettingsPane";
import TerminalPane from "./TerminalPane";
import BrowserPane from "./BrowserPane";
const CodeEditorPane = lazy(() => import("./CodeEditorPane"));

interface SplitPaneProps {
  node: LayoutNode;
  path?: number[];
}

const MIN_SIZE_PERCENT = 10; // Minimum panel size as percentage of total
/** Divider magnet-snap distance (px): when a dragged divider comes within this
 *  of another divider on the same axis, it snaps into alignment. */
const SNAP_PX = 7;

const SplitPane: React.FC<SplitPaneProps> = ({ node, path = [] }) => {
  const { updateSplitSizes, activeSessionId } = useLayout();
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const containerRef = useRef<HTMLDivElement>(null);

  // Drag state
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const dragStartRef = useRef<{
    pos: number;
    sizes: number[];
    index: number;
  } | null>(null);
  const snapCandidatesRef = useRef<number[]>([]);
  const [liveSizes, setLiveSizes] = useState<number[] | null>(null);

  // SSH connect leaf — renders through TerminalPane with connect placeholder
  if (node.type === "leaf" && node.contentType === "ssh-connect") {
    return <TerminalPane sessionId={node.sessionId} />;
  }

  // Browser leaf
  if (node.type === "leaf" && node.contentType === "browser") {
    return (
      <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
        <BrowserPane sessionId={node.sessionId} initialUrl={node.url || "https://www.google.com"} />
      </div>
    );
  }

  // Code editor leaf (lazy-loaded — CodeMirror is ~300KB)
  if (node.type === "leaf" && node.contentType === "editor") {
    return (
      <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
        <Suspense fallback={<div className="flex items-center justify-center h-full opacity-40 text-sm">Loading editor...</div>}>
          <CodeEditorPane sessionId={node.sessionId} filePath={node.editorPath || ""} sourceSessionId={node.sourceSessionId} />
        </Suspense>
      </div>
    );
  }

  // Settings leaf
  if (node.type === "leaf" && node.contentType === "settings") {
    return (
      <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
        <SettingsPane />
      </div>
    );
  }

  // Terminal leaf
  if (node.type === "leaf") {
    return <TerminalPane sessionId={node.sessionId} />;
  }

  const isHorizontal = node.direction === "horizontal";
  const sizes =
    liveSizes ||
    node.sizes ||
    node.children.map(() => 100 / node.children.length);
  const totalSize = sizes.reduce((a, b) => a + b, 0);

  const handleMouseDown = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    const pos = isHorizontal ? e.clientX : e.clientY;
    // Gather the screen positions of every OTHER divider on the same axis so
    // the drag can magnet-snap to align with them (nested-split alignment).
    const axis = isHorizontal ? "col" : "row";
    const draggedEl = e.currentTarget as HTMLElement;
    const candidates: number[] = [];
    document.querySelectorAll(`[data-divider-axis="${axis}"]`).forEach((el) => {
      if (el === draggedEl) return;
      const r = el.getBoundingClientRect();
      candidates.push(isHorizontal ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2);
    });
    snapCandidatesRef.current = candidates;
    dragStartRef.current = { pos, sizes: [...sizes], index };
    setDraggingIndex(index);
  };

  // Double-click a divider → equalize all children of this split (VS Code /
  // iTerm2 behavior).
  const handleEqualize = () => {
    const equal = node.children.map(() => 100 / node.children.length);
    updateSplitSizes(path, equal);
    setLiveSizes(null);
  };

  // Split node — recurse with resize handles
  return (
    <div
      ref={containerRef}
      className={`flex w-full h-full ${isHorizontal ? "flex-row" : "flex-col"}`}
      style={{ position: "relative" }}
    >
      {node.children.map((child, index) => (
        <SplitChild
          key={index}
          child={child}
          index={index}
          totalChildren={node.children.length}
          size={sizes[index]}
          totalSize={totalSize}
          isHorizontal={isHorizontal}
          isDragging={draggingIndex !== null}
          path={path}
          onMouseDown={handleMouseDown}
          onEqualize={handleEqualize}
          isLight={isLight}
          activeSessionId={activeSessionId}
        />
      ))}

      {/* Global drag overlay */}
      {draggingIndex !== null && (
        <DragOverlay
          isHorizontal={isHorizontal}
          containerRef={containerRef}
          dragStartRef={dragStartRef}
          totalSize={totalSize}
          snapCandidatesRef={snapCandidatesRef}
          onSizeUpdate={setLiveSizes}
          onDragEnd={(finalSizes) => {
            setDraggingIndex(null);
            setLiveSizes(null);
            if (finalSizes) {
              updateSplitSizes(path, finalSizes);
            }
          }}
        />
      )}
    </div>
  );
};

/** Individual split child with optional resize handle */
const SplitChild: React.FC<{
  child: LayoutNode;
  index: number;
  totalChildren: number;
  size: number;
  totalSize: number;
  isHorizontal: boolean;
  isDragging: boolean;
  path: number[];
  onMouseDown: (e: React.MouseEvent, index: number) => void;
  onEqualize: () => void;
  isLight: boolean;
  activeSessionId: string | null;
}> = ({
  child,
  index,
  totalChildren,
  size,
  totalSize,
  isHorizontal,
  isDragging,
  path,
  onMouseDown,
  onEqualize,
  isLight,
  activeSessionId,
}) => {
  const isLeaf = child.type === "leaf";
  const paneSessionId = isLeaf ? child.sessionId : undefined;
  // Focus via dimming (Apple/iTerm2: "dim to focus") — the focused pane stays
  // clean and full-contrast; INACTIVE panes recede behind a gentle scrim.
  // No accent borders. Split (non-leaf) children handle focus in recursion.
  const isInactiveLeaf = isLeaf && paneSessionId !== activeSessionId;
  return (
    <>
      <div
        style={{ flex: size / totalSize }}
        className="relative overflow-hidden min-w-0 min-h-0"
        data-pane-session={paneSessionId}
      >
        <SplitPane node={child} path={[...path, index]} />
        <div
          className={`pointer-events-none absolute inset-0 z-30 transition-opacity duration-300 ${
            isLight ? "bg-black/[0.05]" : "bg-black/[0.14]"
          } ${isInactiveLeaf ? "opacity-100" : "opacity-0"}`}
        />
      </div>
      {/* Resize handle between this child and the next. A 1px visual line with
          a wider invisible hit area (overflows into neighbors) for easy grab. */}
      {index < totalChildren - 1 && (
        <div
          className={`shrink-0 z-20 relative ${isHorizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize"}`}
        >
          {/* Visual line — neutral material weights, no accent color */}
          <div
            className={`absolute inset-0 transition-colors ${
              isDragging
                ? isLight ? "bg-black/25" : "bg-white/30"
                : isLight
                  ? "bg-gray-200"
                  : "bg-white/10"
            }`}
          />
          {/* Wide invisible hit area (centered, ~11px) — carries the events */}
          <div
            data-divider-axis={isHorizontal ? "col" : "row"}
            onMouseDown={(e) => onMouseDown(e, index)}
            onDoubleClick={onEqualize}
            className={`group absolute z-10 ${
              isHorizontal
                ? "top-0 bottom-0 -left-[5px] -right-[5px] cursor-col-resize"
                : "left-0 right-0 -top-[5px] -bottom-[5px] cursor-row-resize"
            }`}
          >
            {/* Hover accent on the 1px line */}
            <div
              className={`absolute opacity-0 group-hover:opacity-100 transition-opacity ${
                isLight ? "bg-black/20" : "bg-white/25"
              } ${
                isHorizontal ? "top-0 bottom-0 left-[5px] w-px" : "left-0 right-0 top-[5px] h-px"
              }`}
            />
          </div>
        </div>
      )}
    </>
  );
};

/** Invisible overlay that captures mouse events during drag */
const DragOverlay: React.FC<{
  isHorizontal: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  dragStartRef: React.RefObject<{
    pos: number;
    sizes: number[];
    index: number;
  } | null>;
  totalSize: number;
  snapCandidatesRef: React.RefObject<number[]>;
  onSizeUpdate: (sizes: number[]) => void;
  onDragEnd: (finalSizes: number[] | null) => void;
}> = ({
  isHorizontal,
  containerRef,
  dragStartRef,
  totalSize,
  snapCandidatesRef,
  onSizeUpdate,
  onDragEnd,
}) => {
  const finalSizesRef = useRef<number[] | null>(null);

  // Notify terminals to defer fit() during drag
  useEffect(() => {
    window.dispatchEvent(new Event("tron:splitDragStart"));
    return () => {
      window.dispatchEvent(new Event("tron:splitDragEnd"));
    };
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragStartRef.current || !containerRef.current) return;
      const { pos, sizes, index } = dragStartRef.current;

      const containerRect = containerRef.current.getBoundingClientRect();
      const containerStart = isHorizontal ? containerRect.left : containerRect.top;
      const containerSize = isHorizontal ? containerRect.width : containerRect.height;
      const currentPos = isHorizontal ? e.clientX : e.clientY;
      const deltaPx = currentPos - pos;
      const deltaPercent = (deltaPx / containerSize) * totalSize;

      const newSizes = [...sizes];
      const minSize = (MIN_SIZE_PERCENT / 100) * totalSize;
      let leftNew = sizes[index] + deltaPercent;
      let rightNew = sizes[index + 1] - deltaPercent;

      if (leftNew >= minSize && rightNew >= minSize) {
        // Magnet-snap: if the divider's resulting screen position is within
        // SNAP_PX of another divider on this axis, align exactly to it.
        const boundaryFraction =
          (newSizes.slice(0, index).reduce((a, b) => a + b, 0) + leftNew) / totalSize;
        const dividerScreen = containerStart + boundaryFraction * containerSize;
        const snapped = snapDividerPosition(dividerScreen, snapCandidatesRef.current || [], SNAP_PX);
        if (snapped !== dividerScreen && containerSize > 0) {
          const adjust = ((snapped - dividerScreen) / containerSize) * totalSize;
          const sl = leftNew + adjust;
          const sr = rightNew - adjust;
          if (sl >= minSize && sr >= minSize) {
            leftNew = sl;
            rightNew = sr;
          }
        }
        newSizes[index] = leftNew;
        newSizes[index + 1] = rightNew;
        finalSizesRef.current = newSizes;
        onSizeUpdate(newSizes);
      }
    },
    [isHorizontal, containerRef, dragStartRef, totalSize, snapCandidatesRef, onSizeUpdate],
  );

  const handleMouseUp = useCallback(() => {
    onDragEnd(finalSizesRef.current);
  }, [onDragEnd]);

  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return (
    <div
      className="fixed inset-0 z-50"
      style={{ cursor: isHorizontal ? "col-resize" : "row-resize" }}
    />
  );
};

export default SplitPane;
