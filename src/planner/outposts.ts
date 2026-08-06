/**
 * bunker 之外那几个关键落点的选址。
 *
 * bunker 布局表是一张固定的偏移表，管不到能量源和控制器旁边——那两处的位置
 * 完全取决于房间地形，只能现算。这里算出来的点会建成 container：
 * 矿工站在上面挖，挖出来的能量直接落进脚下的容器，搬运工再从容器取货。
 *
 * 和地形模块一样不依赖 Game 对象，本地脚本和游戏内共用。
 */

import { ROOM_SIZE, TERRAIN_WALL, TerrainGrid, UNREACHABLE, walkingDistanceFrom } from "./terrain";
import { isBunkerCell } from "./bunkerPlanner";

export interface Coord {
  x: number;
  y: number;
}

export interface SourceInfo extends Coord {
  id: string;
}

export interface OutpostPlan {
  /** 每个能量源旁边的采集点，键是能量源 id */
  miningSpots: Record<string, Coord>;
  /** 控制器旁边的能量堆放点 */
  upgradeSpot?: Coord;
  /** 升级工的站位，都在上面那个容器 1 格以内 */
  upgradeStations: Coord[];
}

/**
 * 控制器旁的容器最远只放到 2 格。
 *
 * 升级的作用距离是 3 格，容器放在 2 格以内的话，紧挨着容器的每一格都还在
 * 升级范围内，升级工站在容器旁边既能取能量又能升级，一步都不用挪。
 * 放到第 3 格就会出现"能取货但够不着控制器"的位置。
 */
const CONTROLLER_CONTAINER_RANGE = 2;

/** 房间边缘两格是出口区域，不能建东西 */
const EDGE_MARGIN = 2;

function isBuildable(terrain: TerrainGrid, x: number, y: number): boolean {
  if (x < EDGE_MARGIN || y < EDGE_MARGIN || x >= ROOM_SIZE - EDGE_MARGIN || y >= ROOM_SIZE - EDGE_MARGIN) {
    return false;
  }
  return terrain[y * ROOM_SIZE + x] !== TERRAIN_WALL;
}

/**
 * 在目标周围指定半径内挑一格，取离基地最近的那个。
 *
 * 离基地近意味着搬运工每趟少走几步，这是这些落点唯一需要优化的指标。
 * 已经被 bunker 占掉的格子要排除，否则容器会和基地建筑抢位置。
 */
function pickClosestToBase(
  terrain: TerrainGrid,
  anchor: Coord,
  target: Coord,
  radius: number,
  distanceFromBase: Uint16Array,
  taken: Set<string>
): Coord | undefined {
  let best: Coord | undefined;
  let bestDistance = Infinity;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;

      const x = target.x + dx;
      const y = target.y + dy;
      if (!isBuildable(terrain, x, y)) continue;
      if (isBunkerCell(anchor.x, anchor.y, x, y)) continue;
      if (taken.has(`${x},${y}`)) continue;

      const distance = distanceFromBase[y * ROOM_SIZE + x];
      if (distance === UNREACHABLE || distance >= bestDistance) continue;

      best = { x, y };
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * 控制器旁的容器按"周围站得下几个人"来挑，离基地的远近只作次要参考。
 *
 * 升级工是钉在容器旁边不挪窝的，容器四周有几个落脚点，就直接决定了这个房间
 * 最多能有几个人同时升级。挑一个离基地近但三面环墙的位置，等于给升级速度
 * 焊死一个上限，省下的那几步脚程完全不够赔。
 */
function pickUpgradeSpot(
  terrain: TerrainGrid,
  anchor: Coord,
  controller: Coord,
  distanceFromBase: Uint16Array,
  taken: Set<string>,
  blocked: Set<string>
): { spot: Coord; stations: Coord[] } | undefined {
  let best: { spot: Coord; stations: Coord[] } | undefined;
  let bestCount = 0;
  let bestDistance = Infinity;

  for (let dy = -CONTROLLER_CONTAINER_RANGE; dy <= CONTROLLER_CONTAINER_RANGE; dy++) {
    for (let dx = -CONTROLLER_CONTAINER_RANGE; dx <= CONTROLLER_CONTAINER_RANGE; dx++) {
      if (dx === 0 && dy === 0) continue;

      const x = controller.x + dx;
      const y = controller.y + dy;
      if (!isBuildable(terrain, x, y)) continue;
      if (isBunkerCell(anchor.x, anchor.y, x, y)) continue;
      if (taken.has(`${x},${y}`)) continue;

      const distance = distanceFromBase[y * ROOM_SIZE + x];
      if (distance === UNREACHABLE) continue;

      const stations = standingSpots(terrain, anchor, { x, y }, blocked);
      if (stations.length < bestCount) continue;
      if (stations.length === bestCount && distance >= bestDistance) continue;

      best = { spot: { x, y }, stations };
      bestCount = stations.length;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * 容器周围能站人的格子，包括容器自己那一格。
 *
 * 容器不挡路，站在上面取货距离算 0，同样合法，白扔一个站位没道理。
 * 切比雪夫距离下这些格子离控制器最多 1 + 2 = 3 格，全都在升级射程内，
 * 所以不用再单独校验够不够得着控制器。
 */
function standingSpots(terrain: TerrainGrid, anchor: Coord, container: Coord, blocked: Set<string>): Coord[] {
  const spots: Coord[] = [];

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = container.x + dx;
      const y = container.y + dy;
      if (!isBuildable(terrain, x, y)) continue;
      if (blocked.has(`${x},${y}`)) continue;
      // bunker 地皮上迟早会立起建筑，站上去等于占了将来的建筑位
      if (isBunkerCell(anchor.x, anchor.y, x, y)) continue;

      spots.push({ x, y });
    }
  }

  return spots;
}

/**
 * 只算矿边落点：没有 bunker、没有升级站。
 *
 * 外矿房间用这个——那边没有家，也不需要控制器旁的容器。preference 是"离家更近"
 * 的参照点（通常是朝向老家的出口），favored 是加分格（通常是已经规划好的路面），
 * 运输队取货时不用绕开路。
 */
export function planMiningSpotsOnly(
  terrain: TerrainGrid,
  sources: SourceInfo[],
  preference: Coord,
  favored: Set<string> = new Set()
): Record<string, Coord> {
  const distanceFrom = walkingDistanceFrom(terrain, preference.x, preference.y);
  const taken = new Set<string>();
  const miningSpots: Record<string, Coord> = {};

  for (const source of sources) {
    const spot = pickAdjacent(terrain, source, 1, distanceFrom, taken, favored);
    if (spot) {
      miningSpots[source.id] = spot;
      taken.add(`${spot.x},${spot.y}`);
    }
  }

  return miningSpots;
}

/**
 * 在目标周围挑一格：先看离 preference 近不近，同等距离再看是不是 favored。
 *
 * 和家里那套不同：外矿没有 bunker 地皮，也不必躲布局表。
 */
function pickAdjacent(
  terrain: TerrainGrid,
  target: Coord,
  radius: number,
  distanceFrom: Uint16Array,
  taken: Set<string>,
  favored: Set<string>
): Coord | undefined {
  let best: Coord | undefined;
  let bestDistance = Infinity;
  let bestFavored = false;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;

      const x = target.x + dx;
      const y = target.y + dy;
      if (!isBuildable(terrain, x, y)) continue;
      if (taken.has(`${x},${y}`)) continue;

      const distance = distanceFrom[y * ROOM_SIZE + x];
      if (distance === UNREACHABLE) continue;

      const onFavored = favored.has(`${x},${y}`);
      if (distance > bestDistance) continue;
      if (distance === bestDistance && bestFavored && !onFavored) continue;

      best = { x, y };
      bestDistance = distance;
      bestFavored = onFavored;
    }
  }

  return best;
}

/**
 * 算出所有外围落点。
 *
 * 只做一次全房间的寻路（从锚点出发），之后每个候选格子查表即可，
 * 比对每个候选点单独寻路快几个数量级。
 */
export function planOutposts(
  terrain: TerrainGrid,
  anchor: Coord,
  sources: SourceInfo[],
  controller: Coord
): OutpostPlan {
  const distanceFromBase = walkingDistanceFrom(terrain, anchor.x, anchor.y);
  const taken = new Set<string>();
  const miningSpots: Record<string, Coord> = {};

  for (const source of sources) {
    const spot = pickClosestToBase(terrain, anchor, source, 1, distanceFromBase, taken);
    if (spot) {
      miningSpots[source.id] = spot;
      taken.add(`${spot.x},${spot.y}`);
    }
  }

  // 能量源和控制器占的格子站不了人，采集点则是矿工的专座，都不能算作升级站位
  const blocked = new Set<string>([
    `${controller.x},${controller.y}`,
    ...sources.map(source => `${source.x},${source.y}`),
    ...taken
  ]);
  const upgrade = pickUpgradeSpot(terrain, anchor, controller, distanceFromBase, taken, blocked);

  return { miningSpots, upgradeSpot: upgrade?.spot, upgradeStations: upgrade?.stations ?? [] };
}
