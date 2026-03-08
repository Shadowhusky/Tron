import type { SpriteData } from "../types";

// Zoom-level caches: zoom -> WeakMap<SpriteData, HTMLCanvasElement>
const zoomCaches = new Map<number, WeakMap<SpriteData, HTMLCanvasElement>>();

/** Get a pre-rendered canvas for a sprite at a given zoom level */
export function getCachedSprite(sprite: SpriteData, zoom: number): HTMLCanvasElement {
  let cache = zoomCaches.get(zoom);
  if (!cache) {
    cache = new WeakMap();
    zoomCaches.set(zoom, cache);
  }

  const cached = cache.get(sprite);
  if (cached) return cached;

  const rows = sprite.length;
  const cols = sprite[0]?.length || 0;
  const canvas = document.createElement("canvas");
  canvas.width = cols * zoom;
  canvas.height = rows * zoom;

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const pixel = sprite[r][c];
      if (pixel && pixel !== "") {
        ctx.fillStyle = pixel;
        ctx.fillRect(c * zoom, r * zoom, zoom, zoom);
      }
    }
  }

  cache.set(sprite, canvas);
  return canvas;
}

/** Generate a 1px white outline sprite (for selection highlight) */
export function getOutlineSprite(sprite: SpriteData): SpriteData {
  const rows = sprite.length;
  const cols = sprite[0]?.length || 0;
  const outline: SpriteData = Array.from({ length: rows + 2 }, () =>
    Array(cols + 2).fill("")
  );

  const hasPixel = (r: number, c: number) =>
    r >= 0 && r < rows && c >= 0 && c < cols && sprite[r][c] !== "";

  for (let r = -1; r <= rows; r++) {
    for (let c = -1; c <= cols; c++) {
      if (hasPixel(r, c)) continue;
      const neighbors = [
        hasPixel(r - 1, c),
        hasPixel(r + 1, c),
        hasPixel(r, c - 1),
        hasPixel(r, c + 1),
      ];
      if (neighbors.some(Boolean)) {
        outline[r + 1][c + 1] = "#FFFFFF";
      }
    }
  }

  return outline;
}
