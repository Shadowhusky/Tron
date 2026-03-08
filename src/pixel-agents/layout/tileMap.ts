import { TileType } from "../types";

/** Check if a tile position is walkable (floor and not blocked by furniture) */
export function isWalkable(
  col: number,
  row: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): boolean {
  const tile = tileMap[row]?.[col];
  if (tile === undefined || tile === TileType.WALL || tile === TileType.VOID) return false;
  return !blockedTiles.has(`${col},${row}`);
}

/** Get all walkable tiles in the map */
export function getWalkableTiles(
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  const result: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < tileMap.length; r++) {
    for (let c = 0; c < (tileMap[r]?.length || 0); c++) {
      if (isWalkable(c, r, tileMap, blockedTiles)) {
        result.push({ col: c, row: r });
      }
    }
  }
  return result;
}

/** BFS pathfinding on 4-connected grid, returns path excluding start */
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  if (startCol === endCol && startRow === endRow) return [];

  const key = (c: number, r: number) => `${c},${r}`;
  const visited = new Set<string>();
  visited.add(key(startCol, startRow));

  interface Node {
    col: number;
    row: number;
    path: Array<{ col: number; row: number }>;
  }

  const queue: Node[] = [{ col: startCol, row: startRow, path: [] }];
  const dirs = [
    [0, -1], [0, 1], [-1, 0], [1, 0], // N, S, W, E
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const [dc, dr] of dirs) {
      const nc = current.col + dc;
      const nr = current.row + dr;
      const nk = key(nc, nr);

      if (visited.has(nk)) continue;

      // Allow walking to endCol,endRow even if blocked (it's the destination)
      const isEnd = nc === endCol && nr === endRow;
      if (!isEnd && !isWalkable(nc, nr, tileMap, blockedTiles)) continue;

      // Check tile is at least a floor
      const tile = tileMap[nr]?.[nc];
      if (tile === undefined || tile === TileType.WALL || tile === TileType.VOID) continue;

      visited.add(nk);
      const newPath = [...current.path, { col: nc, row: nr }];

      if (isEnd) return newPath;
      queue.push({ col: nc, row: nr, path: newPath });
    }
  }

  return []; // No path found
}
