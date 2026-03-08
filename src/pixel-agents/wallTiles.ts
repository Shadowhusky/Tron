import type { SpriteData, FurnitureInstance } from "./types";
import { TileType, TILE_SIZE } from "./types";
import { WALL_FILL_COLOR } from "./floorTiles";

/** Simple wall tile — solid color with top highlight */
function makeWallSprite(): SpriteData {
  const rows: SpriteData = [];
  for (let r = 0; r < TILE_SIZE * 2; r++) {
    const row: string[] = [];
    for (let c = 0; c < TILE_SIZE; c++) {
      if (r === 0) row.push("#5A5A8C"); // top edge highlight
      else if (r === 1) row.push("#4A4A7C");
      else row.push(WALL_FILL_COLOR);
    }
    rows.push(row);
  }
  return rows;
}

const wallSprite = makeWallSprite();

/** Get wall sprite for a position (simplified — no auto-tiling, just solid walls) */
export function getWallSprite(): { sprite: SpriteData; offsetY: number } {
  return {
    sprite: wallSprite,
    offsetY: TILE_SIZE - wallSprite.length,
  };
}

/** Convert all wall tiles to FurnitureInstance objects for z-sorted rendering */
export function getWallInstances(
  tileMap: TileType[][],
  rows: number,
  cols: number,
): FurnitureInstance[] {
  const instances: FurnitureInstance[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (tileMap[r]?.[c] === TileType.WALL) {
        const { sprite, offsetY } = getWallSprite();
        instances.push({
          sprite,
          x: c * TILE_SIZE,
          y: r * TILE_SIZE + offsetY,
          zY: r * TILE_SIZE,
        });
      }
    }
  }
  return instances;
}
