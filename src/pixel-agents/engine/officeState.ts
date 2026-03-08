import type { Character, Seat, FurnitureInstance, OfficeLayout } from "../types";
import { CharacterState, TILE_SIZE, MATRIX_EFFECT_DURATION, TileType } from "../types";
import { BUBBLE_FADE_DURATION } from "../constants";
import { createCharacter, updateCharacter } from "./characters";
import { matrixEffectSeeds } from "./matrixEffect";
import { findPath } from "../layout/tileMap";
import { layoutToTileMap, layoutToSeats, getBlockedTiles, layoutToFurnitureInstances } from "../layout/layoutSerializer";

export class OfficeState {
  characters = new Map<number, Character>();
  tileMap: TileType[][] = [];
  seats: Seat[] = [];
  blockedTiles = new Set<string>();
  furnitureInstances: FurnitureInstance[] = [];
  layout: OfficeLayout | null = null;
  layoutVersion = 0;

  selectedId: number | null = null;

  private nextPalette = 0;

  rebuildFromLayout(layout: OfficeLayout): void {
    this.layout = layout;
    this.layoutVersion++;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout);
    this.blockedTiles = getBlockedTiles(layout);
    this.furnitureInstances = layoutToFurnitureInstances(layout);

    // Re-assign seats for existing characters and route active ones
    for (const ch of this.characters.values()) {
      this.assignSeat(ch);
      if (ch.isActive && ch.seatId) {
        this.sendToSeat(ch);
      }
    }
  }

  addAgent(id: number, label: string): void {
    if (this.characters.has(id)) return;

    // Find a spawn position (first walkable tile)
    let spawnCol = 1, spawnRow = 1;
    if (this.layout) {
      for (let r = 0; r < this.layout.rows; r++) {
        for (let c = 0; c < this.layout.cols; c++) {
          const tile = this.tileMap[r]?.[c];
          if (tile !== undefined && tile !== TileType.WALL && tile !== TileType.VOID && !this.blockedTiles.has(`${c},${r}`)) {
            spawnCol = c;
            spawnRow = r;
            break;
          }
        }
        if (spawnCol !== 1 || spawnRow !== 1) break;
      }
    }

    const ch = createCharacter(id, spawnCol, spawnRow, this.nextPalette++ % 6);
    ch.label = label;
    ch.matrixEffect = "spawn";
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();

    this.characters.set(id, ch);
    this.assignSeat(ch);
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;

    // Start despawn effect
    ch.matrixEffect = "despawn";
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    ch.isActive = false;
  }

  setAgentActive(id: number, active: boolean, tool?: string | null): void {
    const ch = this.characters.get(id);
    if (!ch) return;

    ch.isActive = active;
    if (tool !== undefined) ch.currentTool = tool;

    if (active && ch.seatId && ch.state !== CharacterState.TYPE) {
      this.sendToSeat(ch);
    }
  }

  /** Route a character to their assigned seat (or start TYPE if already there) */
  private sendToSeat(ch: Character): void {
    const startCol = Math.round((ch.x - TILE_SIZE / 2) / TILE_SIZE);
    const startRow = Math.round((ch.y - TILE_SIZE / 2) / TILE_SIZE);

    if (startCol === ch.seatCol && startRow === ch.seatRow) {
      // Already at seat — start typing
      ch.state = CharacterState.TYPE;
      ch.animFrame = 0;
      ch.animTimer = 0;
      return;
    }

    // Walk to seat (interrupts wander walk or idle)
    const path = findPath(startCol, startRow, ch.seatCol, ch.seatRow, this.tileMap, this.blockedTiles);
    if (path.length > 0) {
      ch.walkPath = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.animFrame = 0;
      ch.animTimer = 0;
    }
  }

  setBubble(id: number, type: "permission" | "waiting" | null): void {
    const ch = this.characters.get(id);
    if (!ch) return;

    if (type === null && ch.bubbleType) {
      // Fade out
      ch.bubbleFadeTimer = BUBBLE_FADE_DURATION;
    }
    ch.bubbleType = type;
    if (type) ch.bubbleTimer = 0;
  }

  private assignSeat(ch: Character): void {
    // Find an unoccupied seat
    const occupiedSeats = new Set<string>();
    for (const other of this.characters.values()) {
      if (other.id !== ch.id && other.seatId) {
        occupiedSeats.add(other.seatId);
      }
    }

    const freeSeat = this.seats.find(s => !occupiedSeats.has(s.id));
    if (freeSeat) {
      ch.seatId = freeSeat.id;
      ch.seatCol = freeSeat.col;
      ch.seatRow = freeSeat.row;
      ch.direction = freeSeat.direction;
    }
  }

  update(dt: number): void {
    for (const ch of this.characters.values()) {
      // Matrix effect timer
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt;
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === "despawn") {
            this.characters.delete(ch.id);
            continue;
          }
          ch.matrixEffect = null;
        }
        continue;
      }

      // Bubble timer
      if (ch.bubbleFadeTimer > 0) {
        ch.bubbleFadeTimer -= dt;
        if (ch.bubbleFadeTimer <= 0) {
          ch.bubbleFadeTimer = 0;
        }
      }
      if (ch.bubbleType) {
        ch.bubbleTimer += dt;
      }

      updateCharacter(ch, dt, this.tileMap, this.blockedTiles);
    }
  }

  getCharacterAt(worldX: number, worldY: number): Character | null {
    // Characters are 16x17 pixels, centered at (x, y)
    for (const ch of this.characters.values()) {
      const spriteW = 16;
      const spriteH = 17;
      const left = ch.x - spriteW / 2;
      const top = ch.y - spriteH + 4;
      if (worldX >= left && worldX <= left + spriteW && worldY >= top && worldY <= top + spriteH) {
        return ch;
      }
    }
    return null;
  }
}
