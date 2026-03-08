import type { Character, SpriteData } from "../types";
import { CharacterState, Direction, TILE_SIZE } from "../types";
import {
  WALK_SPEED_PX_PER_SEC,
  WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  READ_FRAME_DURATION_SEC,
  WANDER_PAUSE_MIN_SEC,
  WANDER_PAUSE_MAX_SEC,
} from "../constants";
import { getCharacterSprites } from "../sprites/spriteData";
import { findPath, getWalkableTiles } from "../layout/tileMap";
import type { TileType } from "../types";

/** Tools that show reading animation instead of typing */
const READING_TOOLS = new Set([
  "read_file", "read_terminal", "list_dir", "search_dir",
  "web_search", "thinking", "agent", "ask_question",
]);

export function createCharacter(
  id: number,
  col: number,
  row: number,
  palette: number,
): Character {
  return {
    id,
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
    state: CharacterState.IDLE,
    direction: Direction.DOWN,
    palette,
    hueShift: 0,
    isActive: false,
    walkPath: [],
    moveProgress: 0,
    animFrame: 0,
    animTimer: 0,
    seatId: null,
    seatCol: col,
    seatRow: row,
    seatTimer: 0,
    wanderTimer: randomWanderPause(),
    wanderPauseTimer: 0,
    currentTool: null,
    bubbleType: null,
    bubbleTimer: 0,
    bubbleFadeTimer: 0,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    label: "",
    restTimer: 0,
  };
}

function randomWanderPause(): number {
  return WANDER_PAUSE_MIN_SEC + Math.random() * (WANDER_PAUSE_MAX_SEC - WANDER_PAUSE_MIN_SEC);
}

export function updateCharacter(
  ch: Character,
  dt: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): void {
  // Skip if matrix effect is playing
  if (ch.matrixEffect) return;

  switch (ch.state) {
    case CharacterState.TYPE: {
      // Typing or reading at seat
      const isReading = ch.currentTool != null && READING_TOOLS.has(ch.currentTool);
      const frameDuration = isReading ? READ_FRAME_DURATION_SEC : TYPE_FRAME_DURATION_SEC;
      ch.animTimer += dt;
      if (ch.animTimer >= frameDuration) {
        ch.animTimer -= frameDuration;
        ch.animFrame = ch.animFrame === 0 ? 1 : 0;
      }

      // If no longer active, stand up and wander
      if (!ch.isActive) {
        ch.state = CharacterState.IDLE;
        ch.wanderTimer = randomWanderPause();
        ch.animFrame = 0;
        ch.currentTool = null;
      }
      break;
    }

    case CharacterState.WALK: {
      if (ch.walkPath.length === 0) {
        // Arrived — check if at seat
        const atSeatCol = Math.round((ch.x - TILE_SIZE / 2) / TILE_SIZE);
        const atSeatRow = Math.round((ch.y - TILE_SIZE / 2) / TILE_SIZE);
        if (ch.isActive && ch.seatId && atSeatCol === ch.seatCol && atSeatRow === ch.seatRow) {
          ch.state = CharacterState.TYPE;
          ch.animFrame = 0;
          ch.animTimer = 0;
        } else {
          ch.state = CharacterState.IDLE;
          ch.wanderTimer = randomWanderPause();
        }
        ch.animFrame = 0;
        break;
      }

      // Move toward next tile
      ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

      while (ch.moveProgress >= 1 && ch.walkPath.length > 0) {
        ch.moveProgress -= 1;
        const target = ch.walkPath.shift()!;
        ch.x = target.col * TILE_SIZE + TILE_SIZE / 2;
        ch.y = target.row * TILE_SIZE + TILE_SIZE / 2;
      }

      // Update facing direction based on path
      if (ch.walkPath.length > 0) {
        const next = ch.walkPath[0];
        const dx = next.col * TILE_SIZE + TILE_SIZE / 2 - ch.x;
        const dy = next.row * TILE_SIZE + TILE_SIZE / 2 - ch.y;
        if (Math.abs(dx) > Math.abs(dy)) {
          ch.direction = dx > 0 ? Direction.RIGHT : Direction.LEFT;
        } else {
          ch.direction = dy > 0 ? Direction.DOWN : Direction.UP;
        }
      }

      // Walk animation
      ch.animTimer += dt;
      if (ch.animTimer >= WALK_FRAME_DURATION_SEC) {
        ch.animTimer -= WALK_FRAME_DURATION_SEC;
        ch.animFrame = (ch.animFrame + 1) % 4;
      }
      break;
    }

    case CharacterState.IDLE: {
      // If active and has a seat, go to seat
      if (ch.isActive && ch.seatId) {
        const startCol = Math.round((ch.x - TILE_SIZE / 2) / TILE_SIZE);
        const startRow = Math.round((ch.y - TILE_SIZE / 2) / TILE_SIZE);
        if (startCol === ch.seatCol && startRow === ch.seatRow) {
          ch.state = CharacterState.TYPE;
          ch.animFrame = 0;
          ch.animTimer = 0;
        } else {
          const path = findPath(startCol, startRow, ch.seatCol, ch.seatRow, tileMap, blockedTiles);
          if (path.length > 0) {
            ch.walkPath = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.animFrame = 0;
            ch.animTimer = 0;
          }
        }
        break;
      }

      // Wander timer
      ch.wanderTimer -= dt;
      if (ch.wanderTimer <= 0) {
        const walkable = getWalkableTiles(tileMap, blockedTiles);
        if (walkable.length > 0) {
          const target = walkable[Math.floor(Math.random() * walkable.length)];
          const startCol = Math.round((ch.x - TILE_SIZE / 2) / TILE_SIZE);
          const startRow = Math.round((ch.y - TILE_SIZE / 2) / TILE_SIZE);
          const path = findPath(startCol, startRow, target.col, target.row, tileMap, blockedTiles);
          if (path.length > 0) {
            ch.walkPath = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.animFrame = 0;
            ch.animTimer = 0;
          } else {
            ch.wanderTimer = randomWanderPause();
          }
        } else {
          ch.wanderTimer = randomWanderPause();
        }
      }
      break;
    }
  }
}

/** Get the sprite data for the character's current animation state */
export function getCharacterSprite(ch: Character): SpriteData {
  const sprites = getCharacterSprites(ch.palette, ch.hueShift);

  const dirFrames = ch.direction === Direction.DOWN ? sprites.down
    : ch.direction === Direction.UP ? sprites.up
    : ch.direction === Direction.RIGHT ? sprites.right
    : sprites.left;

  switch (ch.state) {
    case CharacterState.WALK:
      return dirFrames[ch.animFrame % 4];
    case CharacterState.TYPE: {
      const isReading = ch.currentTool != null && READING_TOOLS.has(ch.currentTool);
      if (isReading) {
        return dirFrames[6]; // reading frame
      }
      return dirFrames[4 + (ch.animFrame % 2)]; // typing frames
    }
    case CharacterState.IDLE:
    default:
      return dirFrames[0]; // standing
  }
}
