/**
 * 决定 bunker 放在房间的哪个位置。
 *
 * 思路和 Overmind 的 BasePlanner 一致：先筛出所有放得下的锚点，
 * 再挑一个到各能量源和控制器总路程最短的。
 *
 * 和地形模块一样不依赖 Game 对象，本地选房脚本和游戏内规划共用。
 */

import {
  ROOM_SIZE,
  SWAMP_COST,
  TERRAIN_SWAMP,
  TERRAIN_WALL,
  TerrainGrid,
  UNREACHABLE,
  distanceTransform,
  walkingDistanceFrom,
  weightedDistanceFrom
} from "./terrain";
import { BUNKER_STRUCTURES } from "./bunkerLayout";

/** 建筑不能贴房间边缘，出口附近也不适合当据点 */
export const EDGE_MARGIN = 3;

const OFFSETS = BUNKER_STRUCTURES.map(structure => ({ dx: structure.dx, dy: structure.dy }));

/**
 * 锚点至少要离墙多远。
 *
 * bunker 中心一圈是实心的，如果锚点周围半径 k 内全是建筑，那锚点的距离变换值
 * 就必须大于 k。用这个值预筛选候选点，能在做逐格碰撞检测前砍掉绝大多数位置，
 * 省下来的 CPU 在游戏里很关键。
 */
function computeRequiredClearance(): number {
  const occupied = new Set(OFFSETS.map(({ dx, dy }) => `${dx},${dy}`));
  occupied.add("0,0");

  for (let radius = 1; ; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (!occupied.has(`${dx},${dy}`)) return radius;
      }
    }
  }
}

const REQUIRED_CLEARANCE = computeRequiredClearance();

const OCCUPIED_OFFSETS = new Set(OFFSETS.map(({ dx, dy }) => `${dx},${dy}`));

/** 这一格是不是被 bunker 占了，规划外围设施时要避开 */
export function isBunkerCell(anchorX: number, anchorY: number, x: number, y: number): boolean {
  return OCCUPIED_OFFSETS.has(`${x - anchorX},${y - anchorY}`);
}

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
  /** 排序用的综合成本，已经把沼泽的代价折算进去 */
  cost: number;
  /** 到各兴趣点的纯步数之和，代表铺好路以后的距离 */
  steps: number;
  /** 分别到每个兴趣点的步数，方便排查某个源特别远的情况 */
  distances: number[];
  /** 到各兴趣点的加权路程之和，沼泽按 5 倍算，反映铺路前的实际耗时 */
  weighted: number;
  /** 三条主干道加起来要踩过多少格沼泽 */
  swampOnPath: number;
  /** bunker 那 128 格里有多少格是沼泽 */
  swampCells: number;
}

export interface PointOfInterest {
  x: number;
  y: number;
}

/**
 * 主干道上每经过一格沼泽，折算成多走几步。
 *
 * 沼泽的代价不是永久的：铺完路以后沼泽路和平原路一样快，真正的损失是
 * 铺路前那段时间走得慢，加上铺这格路要多花 1200 能量。所以不能按移动成本的
 * 5 倍直接计入——那会让"24 步全沼泽"输给"48 步全平原"，可长远看前者每趟都省一半时间。
 * 记 1 步是个折中：既体现沼泽的开局拖累，又不至于淹没步数本身的长期价值。
 */
const PATH_SWAMP_PENALTY = 1;

/**
 * bunker 占地内每格沼泽折算成多走几步。
 *
 * 建筑压在沼泽上不额外花钱，受影响的只有铺在建筑之间的路，
 * 而基地内部的通行距离本来就短，所以权重比主干道低得多。
 */
const BUNKER_SWAMP_PENALTY = 0.25;

/**
 * 给房间里所有能放下 bunker 的位置打分并排序。
 *
 * 先对每个兴趣点各做一次全房间的距离搜索，之后每个候选锚点只要查表相加，
 * 比"每个候选点单独寻路"快几个数量级。
 *
 * 打分同时看两件事：加权路程（沼泽算 5 倍，决定开局几千 tick 的效率）
 * 和 bunker 占地内的沼泽格数（决定铺路要多花多少能量）。纯步数也一并返回，
 * 那代表基地成型铺好路之后的距离。
 */
export function rankAnchors(terrain: TerrainGrid, targets: PointOfInterest[]): AnchorCandidate[] {
  const stepMaps = targets.map(target => walkingDistanceFrom(terrain, target.x, target.y));
  const weightedMaps = targets.map(target => weightedDistanceFrom(terrain, target.x, target.y));
  const clearance = distanceTransform(terrain);
  const candidates: AnchorCandidate[] = [];

  for (let y = EDGE_MARGIN; y < ROOM_SIZE - EDGE_MARGIN; y++) {
    for (let x = EDGE_MARGIN; x < ROOM_SIZE - EDGE_MARGIN; x++) {
      // 先看一眼开阔度，不够的直接跳过，省下 128 格的碰撞检测
      if (clearance[y * ROOM_SIZE + x] <= REQUIRED_CLEARANCE) continue;
      if (!canPlaceBunker(terrain, x, y)) continue;

      const index = y * ROOM_SIZE + x;
      const distances = stepMaps.map(map => map[index]);
      if (distances.some(d => d === UNREACHABLE)) continue;

      const weighted = weightedMaps.reduce((sum, map) => sum + map[index], 0);
      const swampCells = countSwampCells(terrain, x, y);
      const steps = distances.reduce((sum, d) => sum + d, 0);
      // 加权路程每比步数多 SWAMP_COST-1，就说明路上多踩了一格沼泽
      const swampOnPath = (weighted - steps) / (SWAMP_COST - 1);

      candidates.push({
        x,
        y,
        cost: steps + swampOnPath * PATH_SWAMP_PENALTY + swampCells * BUNKER_SWAMP_PENALTY,
        steps,
        distances,
        weighted,
        swampOnPath,
        swampCells
      });
    }
  }

  return candidates.sort((a, b) => a.cost - b.cost);
}

/** bunker 占地范围内的沼泽格数，主要影响内部道路的造价和维护 */
export function countSwampCells(terrain: TerrainGrid, anchorX: number, anchorY: number): number {
  let swamp = 0;

  for (const { dx, dy } of OFFSETS) {
    if (terrain[(anchorY + dy) * ROOM_SIZE + anchorX + dx] === TERRAIN_SWAMP) swamp++;
  }

  return swamp;
}

/** 按 RCL 过滤出该等级应该存在的建筑 */
export function structuresForLevel(level: number): typeof BUNKER_STRUCTURES {
  return BUNKER_STRUCTURES.filter(structure => structure.rcl <= level);
}
