// --- Tile & Floor ---

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  VOID: 8,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

export interface FloorColor {
  h: number;
  s: number;
  b: number;
  c: number;
  colorize?: boolean;
}

// --- Character ---

export const CharacterState = {
  IDLE: 0,
  WALK: 1,
  TYPE: 2,
} as const;
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState];

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export interface Character {
  id: number;
  x: number;
  y: number;
  state: CharacterState;
  direction: Direction;
  palette: number;
  hueShift: number;
  isActive: boolean;
  walkPath: Array<{ col: number; row: number }>;
  moveProgress: number;
  animFrame: number;
  animTimer: number;
  seatId: string | null;
  seatCol: number;
  seatRow: number;
  seatTimer: number;
  wanderTimer: number;
  wanderPauseTimer: number;
  currentTool: string | null;
  bubbleType: "permission" | "waiting" | null;
  bubbleTimer: number;
  bubbleFadeTimer: number;
  matrixEffect: "spawn" | "despawn" | null;
  matrixEffectTimer: number;
  matrixEffectSeeds: number[];
  label: string;
  restTimer: number;
}

// --- Furniture ---

export const FurnitureType = {
  DESK: 0,
  BOOKSHELF: 1,
  PLANT: 2,
  COOLER: 3,
  WHITEBOARD: 4,
  CHAIR: 5,
  PC: 6,
  LAMP: 7,
} as const;
export type FurnitureType = (typeof FurnitureType)[keyof typeof FurnitureType];

export type SpriteData = string[][];

export interface FurnitureCatalogEntry {
  type: FurnitureType;
  name: string;
  cols: number;
  rows: number;
  sprite: SpriteData;
  isDesk?: boolean;
  category?: string;
  seatDirection?: Direction;
}

export interface PlacedFurniture {
  type: FurnitureType;
  col: number;
  row: number;
  id: string;
  /** Flip the sprite vertically when set to DOWN */
  direction?: Direction;
  /** Direction the seated character faces (toward the desk). Defaults to UP. */
  faceDirection?: Direction;
}

export interface FurnitureInstance {
  sprite: SpriteData;
  x: number;
  y: number;
  zY: number;
  offsetY?: number;
  id?: string;
  col?: number;
  row?: number;
  isOn?: boolean;
}

export interface Seat {
  id: string;
  col: number;
  row: number;
  direction: Direction;
  furnitureId: string;
}

// --- Layout ---

export interface OfficeLayout {
  version: number;
  cols: number;
  rows: number;
  tiles: TileType[];
  tileColors?: Array<FloorColor | null>;
  furniture: PlacedFurniture[];
}

// --- Constants re-exports ---

export const MATRIX_EFFECT_DURATION = 0.3;
export const TILE_SIZE = 16;
export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 11;
