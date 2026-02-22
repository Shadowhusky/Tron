import { useState, useRef, useCallback, useEffect } from "react";
import type { LayoutNode } from "../../types";
import { useLayout } from "../../contexts/LayoutContext";
import { useTheme } from "../../contexts/ThemeContext";
import SettingsPane from "../../features/settings/components/SettingsPane";
import TerminalPane from "./TerminalPane";

interface SplitPaneProps {
  node: LayoutNode;
  path?: number[];
}

const MIN_SIZE_PERCENT = 10; // Minimum panel size as percentage of total

const SplitPane: React.FC<SplitPaneProps> = ({ node, path = [] }) => {
  const { updateSplitSizes } = useLayout();
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
  const [liveSizes, setLiveSizes] = useState<number[] | null>(null);

  // SSH connect leaf — renders through TerminalPane with connect placeholder
  if (node.type === "leaf" && node.contentType === "ssh-connect") {
    return <TerminalPane sessionId={node.sessionId} />;
  }

  // Settings leaf
  if (node.type === "leaf" && node.contentType === "settings") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          position: "relative",
        }}
      >
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
    dragStartRef.current = { pos, sizes: [...sizes], index };
    setDraggingIndex(index);
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
          isLight={isLight}
        />
      ))}

      {/* Global drag overlay */}
      {draggingIndex !== null && (
        <DragOverlay
          isHorizontal={isHorizontal}
          containerRef={containerRef}
          dragStartRef={dragStartRef}
          totalSize={totalSize}
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
  isLight: boolean;
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
  isLight,
}) => {
  return (
    <>
      <div
        style={{ flex: size / totalSize }}
        className="relative overflow-hidden min-w-0 min-h-0"
      >
        <SplitPane node={child} path={[...path, index]} />
      </div>
      {/* Resize handle between this child and the next */}
      {index < totalChildren - 1 && (
        <div
          onMouseDown={(e) => onMouseDown(e, index)}
          className={`shrink-0 z-20 group transition-colors ${
            isHorizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"
          } ${
            isDragging
              ? "bg-purple-500/40"
              : isLight
                ? "bg-gray-200 hover:bg-purple-500/40"
                : "bg-white/5 hover:bg-purple-500/30"
          }`}
          style={{
            [isHorizontal ? "width" : "height"]: "4px",
          }}
        >
          {/* Visual indicator on hover */}
          <div
            className={`absolute opacity-0 group-hover:opacity-100 transition-opacity bg-purple-500 rounded-full ${
              isHorizontal
                ? "w-0.5 h-8 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
                : "h-0.5 w-8 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
            }`}
          />
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
  onSizeUpdate: (sizes: number[]) => void;
  onDragEnd: (finalSizes: number[] | null) => void;
}> = ({
  isHorizontal,
  containerRef,
  dragStartRef,
  totalSize,
  onSizeUpdate,
  onDragEnd,
}) => {
  const finalSizesRef = useRef<number[] | null>(null);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragStartRef.current || !containerRef.current) return;
      const { pos, sizes, index } = dragStartRef.current;

      const containerRect = containerRef.current.getBoundingClientRect();
      const containerSize = isHorizontal
        ? containerRect.width
        : containerRect.height;
      const currentPos = isHorizontal ? e.clientX : e.clientY;
      const deltaPx = currentPos - pos;
      const deltaPercent = (deltaPx / containerSize) * totalSize;

      const newSizes = [...sizes];
      const leftNew = sizes[index] + deltaPercent;
      const rightNew = sizes[index + 1] - deltaPercent;
      const minSize = (MIN_SIZE_PERCENT / 100) * totalSize;

      if (leftNew >= minSize && rightNew >= minSize) {
        newSizes[index] = leftNew;
        newSizes[index + 1] = rightNew;
        finalSizesRef.current = newSizes;
        onSizeUpdate(newSizes);
      }
    },
    [isHorizontal, containerRef, dragStartRef, totalSize, onSizeUpdate],
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
