import type { SpriteData } from "./types";
import { TILE_SIZE, FALLBACK_FLOOR_COLOR } from "./constants";

/** Generate a solid-color 16x16 floor tile */
function solidTile(color: string): SpriteData {
  const row = Array(TILE_SIZE).fill(color);
  return Array.from({ length: TILE_SIZE }, () => [...row]);
}

const fallbackTile = solidTile(FALLBACK_FLOOR_COLOR);

/** Simple floor tile with subtle checkerboard pattern */
function patternedTile(base: string, alt: string): SpriteData {
  return Array.from({ length: TILE_SIZE }, (_, r) =>
    Array.from({ length: TILE_SIZE }, (_, c) =>
      (r + c) % 4 === 0 ? alt : base
    )
  );
}

const floorVariants: SpriteData[] = [
  patternedTile("#4A4A6A", "#525278"),  // Floor 1 - default purple-gray
  patternedTile("#5A5A5A", "#626262"),  // Floor 2 - neutral gray
  patternedTile("#4A5A6A", "#526278"),  // Floor 3 - blue-gray
  patternedTile("#5A4A5A", "#625262"),  // Floor 4 - mauve
  patternedTile("#4A6A5A", "#527862"),  // Floor 5 - green-gray
  patternedTile("#6A5A4A", "#786252"),  // Floor 6 - warm gray
  patternedTile("#5A6A6A", "#627878"),  // Floor 7 - teal-gray
];

export function getFloorSprite(patternIndex: number): SpriteData {
  if (patternIndex >= 1 && patternIndex <= 7) {
    return floorVariants[patternIndex - 1];
  }
  return fallbackTile;
}

export const WALL_FILL_COLOR = "#3A3A5C";
