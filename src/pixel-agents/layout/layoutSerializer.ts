import type { OfficeLayout, PlacedFurniture, FurnitureInstance, Seat } from "../types";
import { TileType, FurnitureType, Direction, TILE_SIZE } from "../types";
import { getCatalogEntry } from "./furnitureCatalog";

/** Convert flat tile array to 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileType[][] {
  const grid: TileType[][] = [];
  for (let r = 0; r < layout.rows; r++) {
    const row: TileType[] = [];
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c] ?? TileType.VOID);
    }
    grid.push(row);
  }
  return grid;
}

/** Get tiles blocked by furniture footprints */
export function getBlockedTiles(layout: OfficeLayout): Set<string> {
  const blocked = new Set<string>();
  for (const f of layout.furniture) {
    const entry = getCatalogEntry(f.type);
    if (!entry) continue;
    for (let dr = 0; dr < entry.rows; dr++) {
      for (let dc = 0; dc < entry.cols; dc++) {
        blocked.add(`${f.col + dc},${f.row + dr}`);
      }
    }
  }
  return blocked;
}

/** Convert placed furniture to renderable instances */
/** Flip a sprite vertically (reverse row order) */
function flipSpriteY(sprite: string[][]): string[][] {
  return [...sprite].reverse();
}

export function layoutToFurnitureInstances(layout: OfficeLayout): FurnitureInstance[] {
  const instances: FurnitureInstance[] = [];
  for (const f of layout.furniture) {
    const entry = getCatalogEntry(f.type);
    if (!entry) continue;
    const x = f.col * TILE_SIZE;
    const y = f.row * TILE_SIZE;
    // z-sort by bottom row of furniture
    const zY = (f.row + entry.rows) * TILE_SIZE;
    // Flip sprite when facing DOWN (chairs, PCs facing opposite direction)
    const sprite = (f.direction === Direction.DOWN)
      ? flipSpriteY(entry.sprite)
      : entry.sprite;
    // Offset tall sprites upward
    const spriteH = sprite.length;
    const tileH = entry.rows * TILE_SIZE;
    const offsetY = tileH - spriteH;
    instances.push({
      sprite,
      x,
      y: y + offsetY,
      zY,
      id: f.id,
      col: f.col,
      row: f.row,
    });
  }
  return instances;
}

/** Generate seats from chair furniture.
 *  `faceDirection` = direction the seated character faces (toward desk).
 *  Falls back to catalog seatDirection (UP). */
export function layoutToSeats(layout: OfficeLayout): Seat[] {
  const seats: Seat[] = [];
  for (const f of layout.furniture) {
    if (f.type !== FurnitureType.CHAIR) continue;
    const entry = getCatalogEntry(f.type);
    seats.push({
      id: f.id,
      col: f.col,
      row: f.row,
      direction: f.faceDirection ?? entry?.seatDirection ?? Direction.UP,
      furnitureId: f.id,
    });
  }
  return seats;
}

/** Create the default 20x11 office layout */
export function createDefaultLayout(): OfficeLayout {
  const cols = 20;
  const rows = 11;

  // Start with all floors
  const tiles: TileType[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Walls around border
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        tiles.push(TileType.WALL);
      }
      // Internal divider wall (with doorway)
      else if (c === 10 && r !== 4 && r !== 5) {
        tiles.push(TileType.WALL);
      }
      // Carpet area (floor 2 for left room)
      else if (c >= 3 && c <= 7 && r >= 3 && r <= 7) {
        tiles.push(TileType.FLOOR_2);
      }
      // Right room floor variant
      else if (c > 10) {
        tiles.push(TileType.FLOOR_3);
      }
      else {
        tiles.push(TileType.FLOOR_1);
      }
    }
  }

  const furniture: PlacedFurniture[] = [
    // Left room — upper desks (chairs flipped, characters face UP toward desk)
    { type: FurnitureType.DESK, col: 3, row: 2, id: "desk-1" },
    { type: FurnitureType.CHAIR, col: 3, row: 3, id: "chair-1", direction: Direction.DOWN, faceDirection: Direction.UP },
    { type: FurnitureType.CHAIR, col: 4, row: 3, id: "chair-2", direction: Direction.DOWN, faceDirection: Direction.UP },
    { type: FurnitureType.PC, col: 3, row: 2, id: "pc-1a" },
    { type: FurnitureType.PC, col: 4, row: 2, id: "pc-1b" },

    { type: FurnitureType.DESK, col: 6, row: 2, id: "desk-2" },
    { type: FurnitureType.CHAIR, col: 6, row: 3, id: "chair-3", direction: Direction.DOWN, faceDirection: Direction.UP },
    { type: FurnitureType.CHAIR, col: 7, row: 3, id: "chair-4", direction: Direction.DOWN, faceDirection: Direction.UP },
    { type: FurnitureType.PC, col: 6, row: 2, id: "pc-2a" },
    { type: FurnitureType.PC, col: 7, row: 2, id: "pc-2b" },

    // Left room — lower desks (characters face DOWN toward desk)
    { type: FurnitureType.DESK, col: 3, row: 7, id: "desk-3" },
    { type: FurnitureType.CHAIR, col: 3, row: 6, id: "chair-5", faceDirection: Direction.DOWN },
    { type: FurnitureType.CHAIR, col: 4, row: 6, id: "chair-6", faceDirection: Direction.DOWN },
    { type: FurnitureType.PC, col: 3, row: 7, id: "pc-3a", direction: Direction.DOWN },
    { type: FurnitureType.PC, col: 4, row: 7, id: "pc-3b", direction: Direction.DOWN },

    // Right room — upper desks (chairs flipped, characters face UP toward desk)
    { type: FurnitureType.DESK, col: 12, row: 2, id: "desk-4" },
    { type: FurnitureType.CHAIR, col: 12, row: 3, id: "chair-7", direction: Direction.DOWN, faceDirection: Direction.UP },
    { type: FurnitureType.CHAIR, col: 13, row: 3, id: "chair-8", direction: Direction.DOWN, faceDirection: Direction.UP },
    { type: FurnitureType.PC, col: 12, row: 2, id: "pc-4a" },
    { type: FurnitureType.PC, col: 13, row: 2, id: "pc-4b" },

    { type: FurnitureType.DESK, col: 15, row: 2, id: "desk-5" },
    { type: FurnitureType.CHAIR, col: 15, row: 3, id: "chair-9", direction: Direction.DOWN, faceDirection: Direction.UP },
    { type: FurnitureType.CHAIR, col: 16, row: 3, id: "chair-10", direction: Direction.DOWN, faceDirection: Direction.UP },
    { type: FurnitureType.PC, col: 15, row: 2, id: "pc-5a" },
    { type: FurnitureType.PC, col: 16, row: 2, id: "pc-5b" },

    // Decor
    { type: FurnitureType.PLANT, col: 1, row: 1, id: "plant-1" },
    { type: FurnitureType.PLANT, col: 18, row: 1, id: "plant-2" },
    { type: FurnitureType.BOOKSHELF, col: 8, row: 1, id: "bookshelf-1" },
    { type: FurnitureType.COOLER, col: 11, row: 8, id: "cooler-1" },
    { type: FurnitureType.WHITEBOARD, col: 14, row: 7, id: "whiteboard-1" },
    { type: FurnitureType.PLANT, col: 1, row: 9, id: "plant-3" },
  ];

  return {
    version: 1,
    cols,
    rows,
    tiles,
    furniture,
  };
}
