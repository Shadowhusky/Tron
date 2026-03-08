import type { Character, SpriteData } from "../types";
import { TileType, TILE_SIZE, CharacterState } from "../types";
import { CHARACTER_SITTING_OFFSET_PX, BUBBLE_VERTICAL_OFFSET } from "../constants";
import { getFloorSprite, WALL_FILL_COLOR } from "../floorTiles";
import { getWallInstances } from "../wallTiles";
import { getCachedSprite } from "../sprites/spriteCache";
import { getCharacterSprite } from "./characters";
import { renderMatrixEffect } from "./matrixEffect";
import { permissionBubble, waitingBubble } from "../sprites/spriteData";
import type { OfficeState } from "./officeState";

interface RenderOptions {
  zoom: number;
  panX: number;
  panY: number;
  canvasWidth: number;
  canvasHeight: number;
  bgColor: string;
}

interface Drawable {
  sprite: SpriteData;
  x: number;
  y: number;
  zY: number;
  character?: Character;
}

// Cached static drawables (furniture + walls) — rebuilt only when layout changes
let cachedStaticDrawables: Drawable[] | null = null;
let cachedLayoutVersion = -1;

function getStaticDrawables(state: OfficeState): Drawable[] {
  if (cachedStaticDrawables && cachedLayoutVersion === state.layoutVersion) {
    return cachedStaticDrawables;
  }
  if (!state.layout) return [];

  const drawables: Drawable[] = [];

  for (const fi of state.furnitureInstances) {
    drawables.push({ sprite: fi.sprite, x: fi.x, y: fi.y, zY: fi.zY });
  }

  const wallInstances = getWallInstances(state.tileMap, state.layout.rows, state.layout.cols);
  for (const wi of wallInstances) {
    drawables.push({ sprite: wi.sprite, x: wi.x, y: wi.y, zY: wi.zY });
  }

  // Pre-sort static items (they never move)
  drawables.sort((a, b) => a.zY - b.zY);

  cachedStaticDrawables = drawables;
  cachedLayoutVersion = state.layoutVersion;
  return drawables;
}

/** Main render function — draws the entire office scene */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  state: OfficeState,
  options: RenderOptions,
): void {
  const { zoom, panX, panY, canvasWidth, canvasHeight, bgColor } = options;

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  if (!state.layout) return;

  const { cols, rows } = state.layout;
  const mapW = cols * TILE_SIZE * zoom;
  const mapH = rows * TILE_SIZE * zoom;
  const offsetX = Math.floor((canvasWidth - mapW) / 2 + panX);
  const offsetY = Math.floor((canvasHeight - mapH) / 2 + panY);

  renderTileGrid(ctx, state, zoom, offsetX, offsetY);

  // Merge cached static drawables with dynamic characters via insertion sort
  const statics = getStaticDrawables(state);

  // Build character drawables
  const charDrawables: Drawable[] = [];
  for (const ch of state.characters.values()) {
    const sprite = getCharacterSprite(ch);
    const spriteW = (sprite[0]?.length || 16);
    const spriteH = sprite.length;
    const drawX = ch.x - spriteW / 2;
    let drawY = ch.y - spriteH + 4;
    if (ch.state === CharacterState.TYPE) drawY += CHARACTER_SITTING_OFFSET_PX;

    charDrawables.push({
      sprite,
      x: drawX,
      y: drawY,
      zY: ch.y + TILE_SIZE / 2 + 0.5,
      character: ch,
    });
  }
  charDrawables.sort((a, b) => a.zY - b.zY);

  // Merge-draw: interleave pre-sorted statics and characters by zY
  let si = 0;
  let ci = 0;
  while (si < statics.length || ci < charDrawables.length) {
    const useStatic = si < statics.length && (ci >= charDrawables.length || statics[si].zY <= charDrawables[ci].zY);
    const d = useStatic ? statics[si++] : charDrawables[ci++];

    const sx = Math.floor(offsetX + d.x * zoom);
    const sy = Math.floor(offsetY + d.y * zoom);

    if (d.character?.matrixEffect) {
      renderMatrixEffect(ctx, d.character, d.sprite, sx, sy, zoom);
    } else {
      ctx.drawImage(getCachedSprite(d.sprite, zoom), sx, sy);
    }

    if (d.character && d.character.id === state.selectedId) {
      ctx.strokeStyle = "#7C4DFF";
      ctx.lineWidth = 1;
      const cached = getCachedSprite(d.sprite, zoom);
      ctx.strokeRect(sx - 1, sy - 1, cached.width + 2, cached.height + 2);
    }
  }

  renderBubbles(ctx, state, zoom, offsetX, offsetY);
}

function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  state: OfficeState,
  zoom: number,
  offsetX: number,
  offsetY: number,
): void {
  if (!state.layout) return;
  const { cols, rows } = state.layout;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = state.tileMap[r]?.[c];
      if (tile === undefined || tile === TileType.VOID) continue;

      const px = Math.floor(offsetX + c * TILE_SIZE * zoom);
      const py = Math.floor(offsetY + r * TILE_SIZE * zoom);

      if (tile === TileType.WALL) {
        ctx.fillStyle = WALL_FILL_COLOR;
        ctx.fillRect(px, py, TILE_SIZE * zoom, TILE_SIZE * zoom);
      } else {
        ctx.drawImage(getCachedSprite(getFloorSprite(tile), zoom), px, py);
      }
    }
  }
}

function renderBubbles(
  ctx: CanvasRenderingContext2D,
  state: OfficeState,
  zoom: number,
  offsetX: number,
  offsetY: number,
): void {
  for (const ch of state.characters.values()) {
    if (!ch.bubbleType && ch.bubbleFadeTimer <= 0) continue;

    const bubbleSprite = ch.bubbleType === "permission" ? permissionBubble : waitingBubble;
    const bw = (bubbleSprite[0]?.length || 14) * zoom;
    const bh = bubbleSprite.length * zoom;

    const bx = Math.floor(offsetX + ch.x * zoom - bw / 2);
    const by = Math.floor(offsetY + (ch.y - 20) * zoom + BUBBLE_VERTICAL_OFFSET * zoom - bh);

    if (ch.bubbleFadeTimer > 0) {
      ctx.globalAlpha = ch.bubbleFadeTimer / 0.5;
    }

    ctx.drawImage(getCachedSprite(bubbleSprite, zoom), bx, by);
    ctx.globalAlpha = 1;
  }
}
