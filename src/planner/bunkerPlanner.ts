/**
 * 决定 bunker 放在房间的哪个位置。
 *
 * 思路和 Overmind 的 BasePlanner 一致：先筛出所有放得下的锚点，
 * 再挑一个到各能量源和控制器总路程最短的。
 *
 * 和地形模块一样不依赖 Game 对象，本地选房脚本和游戏内规划共用。
 */

import { ROOM_SIZE, TERRAIN_WALL, TerrainGrid, UNREACHABLE, walkingDistanceFrom } from "./terrain";
import { BUNKER_STRUCTURES } from "./bunkerLayout";

/** 建筑不能贴房间边缘，出口附近也不适合当据点 */
export const EDGE_MARGIN = 3;

const OFFSETS = BUNKER_STRUCTURES.map(structure => ({ dx: structure.dx, dy: structure.dy }));

/** bunker 的 128 格是否都落在可建造的地面上 */
export function canPlaceBunker(terrain: TerrainGrid, anchorX: number, anchorY: number): boolean {
  for (const { dx, dy } of OFFSETS) {
    const x = anchorX + dx;
    const y = anchorY + dy;

    if (x < EDGE_MARGIN || y < EDGE_MARGIN || x >= ROOM_SIZE - EDGE_MARGIN || y >= ROOM_SIZE - EDGE_MARGIN) {
      return false;
    }
    if (terrain[y * ROOM_SIZE + x] === TERRAIN_WALL) {
      return false;
    }
  }

  return true;
}

export interface AnchorCandidate {
  x: number;
  y: number;
  /** 到各兴趣点的步数之和，越小越好 */
  cost: number;
  /** 分别到每个兴趣点的步数，方便排查某个源特别远的情况 */
  distances: number[];
}

export interface PointOfInterest {
  x: number;
  y: number;
}

/**
 * 给房间里所有能放下 bunker 的位置打分并排序。
 *
 * 打分方式是把锚点到每个能量源、控制器的步数加起来。先对每个兴趣点各做一次
 * 广度优先搜索得到全房间的距离图，之后每个候选锚点只要查表相加，
 * 比"每个候选点单独寻路"快几个数量级。
 */
export function rankAnchors(terrain: TerrainGrid, targets: PointOfInterest[]): AnchorCandidate[] {
  const distanceMaps = targets.map(target => walkingDistanceFrom(terrain, target.x, target.y));
  const candidates: AnchorCandidate[] = [];

  for (let y = EDGE_MARGIN; y < ROOM_SIZE - EDGE_MARGIN; y++) {
    for (let x = EDGE_MARGIN; x < ROOM_SIZE - EDGE_MARGIN; x++) {
      if (!canPlaceBunker(terrain, x, y)) continue;

      const index = y * ROOM_SIZE + x;
      const distances = distanceMaps.map(map => map[index]);
      if (distances.some(d => d === UNREACHABLE)) continue;

      candidates.push({
        x,
        y,
        cost: distances.reduce((sum, d) => sum + d, 0),
        distances
      });
    }
  }

  return candidates.sort((a, b) => a.cost - b.cost);
}

/** 按 RCL 过滤出该等级应该存在的建筑 */
export function structuresForLevel(level: number): typeof BUNKER_STRUCTURES {
  return BUNKER_STRUCTURES.filter(structure => structure.rcl <= level);
}
