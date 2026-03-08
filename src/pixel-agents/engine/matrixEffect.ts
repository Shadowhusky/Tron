import type { Character, SpriteData } from "../types";
import { MATRIX_EFFECT_DURATION } from "../types";
import {
  MATRIX_TRAIL_LENGTH,
  MATRIX_SPRITE_COLS,
  MATRIX_SPRITE_ROWS,
  MATRIX_FLICKER_FPS,
  MATRIX_FLICKER_VISIBILITY_THRESHOLD,
  MATRIX_COLUMN_STAGGER_RANGE,
  MATRIX_HEAD_COLOR,
  MATRIX_TRAIL_OVERLAY_ALPHA,
} from "../constants";

/** Hash-based flicker: ~70% visible for shimmer effect */
function flickerVisible(col: number, row: number, time: number): boolean {
  const t = Math.floor(time * MATRIX_FLICKER_FPS);
  const hash = ((col * 7 + row * 13 + t * 31) & 0xff);
  return hash < MATRIX_FLICKER_VISIBILITY_THRESHOLD;
}

function generateSeeds(): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < MATRIX_SPRITE_COLS; i++) {
    seeds.push(Math.random());
  }
  return seeds;
}

export { generateSeeds as matrixEffectSeeds };

/**
 * Render a character with a Matrix-style digital rain spawn/despawn effect.
 * Per-pixel rendering: each column sweeps top-to-bottom with a bright head and fading green trail.
 */
export function renderMatrixEffect(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  spriteData: SpriteData,
  drawX: number,
  drawY: number,
  zoom: number,
): void {
  const progress = ch.matrixEffectTimer / MATRIX_EFFECT_DURATION;
  const isSpawn = ch.matrixEffect === "spawn";
  const time = ch.matrixEffectTimer;
  const totalSweep = MATRIX_SPRITE_ROWS + MATRIX_TRAIL_LENGTH;

  for (let col = 0; col < MATRIX_SPRITE_COLS; col++) {
    const stagger = (ch.matrixEffectSeeds[col] ?? 0) * MATRIX_COLUMN_STAGGER_RANGE;
    const colProgress = Math.max(0, Math.min(1, (progress - stagger) / (1 - MATRIX_COLUMN_STAGGER_RANGE)));
    const headRow = colProgress * totalSweep;

    for (let row = 0; row < MATRIX_SPRITE_ROWS; row++) {
      const pixel = spriteData[row]?.[col];
      const hasPixel = pixel && pixel !== "";
      const distFromHead = headRow - row;
      const px = drawX + col * zoom;
      const py = drawY + row * zoom;

      if (isSpawn) {
        if (distFromHead < 0) {
          continue;
        } else if (distFromHead < 1 && hasPixel) {
          ctx.fillStyle = MATRIX_HEAD_COLOR;
          ctx.fillRect(px, py, zoom, zoom);
        } else if (distFromHead < MATRIX_TRAIL_LENGTH && hasPixel) {
          const trailPos = distFromHead / MATRIX_TRAIL_LENGTH;
          ctx.fillStyle = pixel;
          ctx.fillRect(px, py, zoom, zoom);
          const greenAlpha = (1 - trailPos) * MATRIX_TRAIL_OVERLAY_ALPHA;
          if (flickerVisible(col, row, time)) {
            ctx.fillStyle = `rgba(0, 255, 65, ${greenAlpha})`;
            ctx.fillRect(px, py, zoom, zoom);
          }
        } else {
          if (hasPixel) {
            ctx.fillStyle = pixel;
            ctx.fillRect(px, py, zoom, zoom);
          }
        }
      } else {
        // Despawn
        if (distFromHead < 0) {
          if (hasPixel) {
            ctx.fillStyle = pixel;
            ctx.fillRect(px, py, zoom, zoom);
          }
        } else if (distFromHead < 1 && hasPixel) {
          ctx.fillStyle = MATRIX_HEAD_COLOR;
          ctx.fillRect(px, py, zoom, zoom);
        }
      }
    }
  }
}
