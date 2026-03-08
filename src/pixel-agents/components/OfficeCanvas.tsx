import { useEffect, useRef, useCallback, useState } from "react";
import type { OfficeState } from "../engine/officeState";
import { startGameLoop } from "../engine/gameLoop";
import { renderFrame } from "../engine/renderer";
import { DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM, TILE_SIZE } from "../constants";
import ToolOverlay from "./ToolOverlay";

interface OfficeCanvasProps {
  officeState: OfficeState;
  bgColor: string;
  isVisible: boolean;
}

const OfficeCanvas: React.FC<OfficeCanvasProps> = ({ officeState, bgColor, isVisible }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const panRef = useRef({ x: 0, y: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  // Cache container dimensions to avoid getBoundingClientRect every frame
  const containerSizeRef = useRef({ w: 0, h: 0 });

  // Canvas resize
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      containerSizeRef.current = { w: rect.width, h: rect.height };
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.scale(dpr, dpr);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isVisible) return;

    const stop = startGameLoop(canvas, {
      update: (dt) => {
        officeState.update(dt);
      },
      render: (ctx) => {
        const { w, h } = containerSizeRef.current;
        if (w === 0) return;
        renderFrame(ctx, officeState, {
          zoom,
          panX: panRef.current.x,
          panY: panRef.current.y,
          canvasWidth: w,
          canvasHeight: h,
          bgColor,
        });
      },
    });

    return stop;
  }, [officeState, bgColor, isVisible, zoom]);

  // Mouse wheel zoom — use native listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(prev => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + (e.deltaY > 0 ? -0.5 : 0.5))));
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, []);

  // Pan threshold (px) — distinguish drag from click
  const PAN_THRESHOLD = 4;
  const dragStartRef = useRef({ x: 0, y: 0 });
  const didDragRef = useRef(false);

  // Pan with any mouse drag (left, middle, ctrl+click)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0 || e.button === 1) {
      isPanning.current = true;
      didDragRef.current = false;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      if (e.button === 1) e.preventDefault();
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning.current) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (!didDragRef.current && Math.abs(dx) + Math.abs(dy) >= PAN_THRESHOLD) {
        didDragRef.current = true;
      }
      if (didDragRef.current) {
        panRef.current.x += e.clientX - lastMouseRef.current.x;
        panRef.current.y += e.clientY - lastMouseRef.current.y;
        setPan({ ...panRef.current });
      }
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (isPanning.current && !didDragRef.current && e.button === 0) {
      // Click (no drag) — select character
      const container = containerRef.current;
      if (container && officeState.layout) {
        const rect = container.getBoundingClientRect();
        const { cols, rows } = officeState.layout;
        const mapW = cols * TILE_SIZE * zoom;
        const mapH = rows * TILE_SIZE * zoom;
        const offsetX = (rect.width - mapW) / 2 + panRef.current.x;
        const offsetY = (rect.height - mapH) / 2 + panRef.current.y;

        const worldX = (e.clientX - rect.left - offsetX) / zoom;
        const worldY = (e.clientY - rect.top - offsetY) / zoom;

        const ch = officeState.getCharacterAt(worldX, worldY);
        officeState.selectedId = ch ? ch.id : null;
      }
    }
    isPanning.current = false;
  }, [officeState, zoom]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative overflow-hidden"
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        data-testid="pixel-agents-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className="block w-full h-full cursor-grab active:cursor-grabbing"
        style={{ imageRendering: "pixelated" }}
      />
      {/* Tool overlay — positioned relative to this canvas container */}
      <ToolOverlay
        officeState={officeState}
        containerRef={containerRef}
        zoom={zoom}
        panX={pan.x}
        panY={pan.y}
      />
      {/* Zoom controls */}
      <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-black/40 rounded-lg px-2 py-1 text-xs text-white/70 select-none">
        <button
          onClick={() => setZoom(prev => Math.max(MIN_ZOOM, prev - 1))}
          className="px-1 hover:text-white"
        >
          −
        </button>
        <span className="w-8 text-center">{zoom}×</span>
        <button
          onClick={() => setZoom(prev => Math.min(MAX_ZOOM, prev + 1))}
          className="px-1 hover:text-white"
        >
          +
        </button>
      </div>
    </div>
  );
};

export default OfficeCanvas;
