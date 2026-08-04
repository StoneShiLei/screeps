/**
 * 地形分析的基础算法。
 *
 * 这里的函数刻意不依赖 Game / Room 等游戏对象，只吃一个 50x50 的地形数组，
 * 这样游戏内的布局模块和本地的选房脚本可以共用同一份实现。
 */

export const ROOM_SIZE = 50;

export const TERRAIN_PLAIN = 0;
export const TERRAIN_WALL = 1;
export const TERRAIN_SWAMP = 2;

/** 50x50 地形，下标 = y * 50 + x */
export type TerrainGrid = Uint8Array;

/** 每格到最近墙壁的切比雪夫距离，下标同 TerrainGrid */
export type ClearanceGrid = Uint8Array;

/** 解析 Screeps API 返回的地形串：每个字符一格，1 是墙、2 是沼泽 */
export function decodeTerrain(encoded: string): TerrainGrid {
  const grid = new Uint8Array(ROOM_SIZE * ROOM_SIZE);

  for (let i = 0; i < grid.length; i++) {
    // 编码是位掩码：1 是墙，2 是沼泽，3 表示两者叠加（当墙处理）
    const code = encoded.charCodeAt(i) - 48;
    if (code === 1 || code === 3) {
      grid[i] = TERRAIN_WALL;
    } else if (code === 2) {
      grid[i] = TERRAIN_SWAMP;
    } else {
      grid[i] = TERRAIN_PLAIN;
    }
  }

  return grid;
}

/**
 * 距离变换：算出每格到最近墙壁的切比雪夫距离，房间外一律当成墙。
 *
 * 结果的含义很实用：某格的值是 k，就表示以它为中心的 (2k-1)×(2k-1) 方形区域内
 * 没有任何墙壁。所以"这个房间能不能放下 11×11 的建筑群"直接看有没有格子达到 6。
 *
 * 用的是标准两遍扫描：正向只看左上方向已算好的邻居，反向补右下方向。
 * 整个房间只需遍历两次，比对每格做 BFS 快得多。
 */
export function distanceTransform(terrain: TerrainGrid): ClearanceGrid {
  const dt = new Uint8Array(ROOM_SIZE * ROOM_SIZE);

  const read = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= ROOM_SIZE || y >= ROOM_SIZE ? 0 : dt[y * ROOM_SIZE + x];

  for (let i = 0; i < dt.length; i++) {
    dt[i] = terrain[i] === TERRAIN_WALL ? 0 : ROOM_SIZE;
  }

  for (let y = 0; y < ROOM_SIZE; y++) {
    for (let x = 0; x < ROOM_SIZE; x++) {
      const i = y * ROOM_SIZE + x;
      if (dt[i] === 0) continue;
      const nearest = Math.min(read(x - 1, y - 1), read(x, y - 1), read(x + 1, y - 1), read(x - 1, y));
      dt[i] = Math.min(dt[i], nearest + 1);
    }
  }

  for (let y = ROOM_SIZE - 1; y >= 0; y--) {
    for (let x = ROOM_SIZE - 1; x >= 0; x--) {
      const i = y * ROOM_SIZE + x;
      if (dt[i] === 0) continue;
      const nearest = Math.min(read(x + 1, y + 1), read(x, y + 1), read(x - 1, y + 1), read(x + 1, y));
      dt[i] = Math.min(dt[i], nearest + 1);
    }
  }

  return dt;
}

/** 到不了的格子用这个值表示 */
export const UNREACHABLE = 65535;

/**
 * 从一个点出发做广度优先搜索，算出到房间内每一格要走几步。
 *
 * creep 可以斜着走，所以是 8 邻域。这里不区分平原和沼泽——
 * 主干道最终都会铺路，铺完路两者速度一样，按步数算反而更接近成型后的实际情况。
 */
export function walkingDistanceFrom(terrain: TerrainGrid, startX: number, startY: number): Uint16Array {
  const distance = new Uint16Array(ROOM_SIZE * ROOM_SIZE).fill(UNREACHABLE);
  const queue = new Int32Array(ROOM_SIZE * ROOM_SIZE);
  let head = 0;
  let tail = 0;

  const startIndex = startY * ROOM_SIZE + startX;
  distance[startIndex] = 0;
  queue[tail++] = startIndex;

  while (head < tail) {
    const index = queue[head++];
    const x = index % ROOM_SIZE;
    const y = (index - x) / ROOM_SIZE;
    const next = distance[index] + 1;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= ROOM_SIZE || ny >= ROOM_SIZE) continue;

        const neighbour = ny * ROOM_SIZE + nx;
        if (terrain[neighbour] === TERRAIN_WALL) continue;
        if (distance[neighbour] <= next) continue;

        distance[neighbour] = next;
        queue[tail++] = neighbour;
      }
    }
  }

  return distance;
}

export interface OpenSpot {
  x: number;
  y: number;
  /** 该点的距离变换值，即能容纳的方形半径 */
  clearance: number;
}

/**
 * 找出最开阔的若干个点。
 * margin 用来把房间边缘排除掉：出口两格内不能建东西，紧贴边界也不适合当据点。
 */
export function findOpenSpots(dt: ClearanceGrid, minClearance: number, margin = 3): OpenSpot[] {
  const spots: OpenSpot[] = [];

  for (let y = margin; y < ROOM_SIZE - margin; y++) {
    for (let x = margin; x < ROOM_SIZE - margin; x++) {
      const clearance = dt[y * ROOM_SIZE + x];
      if (clearance >= minClearance) {
        spots.push({ x, y, clearance });
      }
    }
  }

  return spots.sort((a, b) => b.clearance - a.clearance);
}
