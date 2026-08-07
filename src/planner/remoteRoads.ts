/**
 * 外矿基础设施：到基地的路，以及矿边的容器。
 *
 * 路值得铺是因为收益会被跑过的次数放大：运输队一辈子就在源和基地之间往返，路面把
 * 每格的疲劳从 2 降到 1，等于让同样的预算多买一半 CARRY——没有路的时候它必须
 * 一比一配 MOVE 才能满载全速，铺好之后二比一就够了。
 *
 * 容器同理：矿工站在上面挖，能量直接进桶，运输队不用在地上扫；每房上限 5 个，
 * 外矿常见一两个源，名额绰绰有余。路和容器都由派驻的拓荒者建、修。
 *
 * 和房内主干道分开存（`RoomMemory.remoteRoads`），不和 `roads` 合成一份，是为了
 * 两件事互不干扰：房间重新规划时不会把外矿路线冲掉，外矿换人家时也只用清掉
 * 自己那一段。读的时候两份取并集。
 */

import { Coord, SourceInfo, planMiningSpotsOnly } from "./outposts";
import { bunkerEntrances, decodeCells, encodeCells } from "./roads";
import { BUNKER_STRUCTURES } from "./bunkerLayout";
import { containerAt } from "../utils/structures";
import { isBunkerCell } from "./bunkerPlanner";
import { log } from "../utils/logger";
import { terrainOfRoom } from "./terrain";

/** 和 movement/costMatrix 同一套相对代价，规划出来的才是 creep 真会走的路 */
const ROAD_COST = 1;
const PLAIN_COST = 2;
const SWAMP_COST = 10;
const BLOCKED = 255;

const ROOM_SIZE = 50;

/** 跨房间寻路的算力上限。一条外矿路线要穿两三个房间，比房内寻路贵得多 */
const MAX_OPS = 20000;

/** 最多穿几个房间。再远的外矿本来就不该开 */
const MAX_ROOMS = 4;

/** 同时最多开几个路面工地，让进度集中在一格上而不是摊在四十格里 */
const MAX_ROAD_SITES = 2;

/** 掉到这个比例以下才值得修。路有 5000 血，每 1000 tick 掉 100 */
const REPAIR_THRESHOLD = 0.6;

/**
 * 外矿路规划算法版本。涨一号就会在有视野时重算一遍，用来修跨房错位这类存量问题。
 */
export const REMOTE_ROADS_REV = 1;

/**
 * 算出从这个外矿到基地的路，按房间分段存进各自的 Memory。
 *
 * 只在启用外矿时算一次。跨房间寻路要两万 ops，不是每 tick 能跑的东西。
 */
export function planRemoteRoads(home: Room, roomName: string): void {
  const anchor = home.memory.anchor;
  if (!anchor) return;

  const sources = Memory.rooms[roomName]?.sources;
  if (!sources) return;

  const entrances = bunkerEntrances(home, anchor).map(pos => ({ pos, range: 1 }));
  if (entrances.length === 0) return;

  const byRoom = new Map<string, Map<string, Coord>>();
  const matrices = new Map<string, CostMatrix>();

  const remember = (name: string, x: number, y: number): void => {
    // 房间交界那圈不铺：站上去就换房间了，路面留不住人也建不了工地
    if (x === 0 || y === 0 || x === ROOM_SIZE - 1 || y === ROOM_SIZE - 1) return;
    // 基地自己那圈路由布局表管
    if (name === home.name && isBunkerCell(anchor.x, anchor.y, x, y)) return;

    const cells = byRoom.get(name) ?? new Map<string, Coord>();
    cells.set(`${x},${y}`, { x, y });
    byRoom.set(name, cells);

    // 后一条路线看到前一条已经铺过的格子就会拐过来汇进同一条主干，
    // 而不是各走一条平行线——那样要多花一倍能量，维修面积也大一倍
    matrices.get(name)?.set(x, y, ROAD_COST);
  };

  for (const spot of Object.values(sources)) {
    const from = new RoomPosition(spot.x, spot.y, roomName);
    const result = PathFinder.search(from, entrances, {
      plainCost: PLAIN_COST,
      swampCost: SWAMP_COST,
      maxOps: MAX_OPS,
      maxRooms: MAX_ROOMS,
      roomCallback: name => matrices.get(name) ?? cache(matrices, name, home, anchor)
    });

    if (result.incomplete) {
      log.warn("外矿", `${roomName} 到 ${home.name} 找不到路线，暂不铺路`);
      continue;
    }

    for (const step of result.path) {
      remember(step.roomName, step.x, step.y);
    }
    // 出口格本身不铺，但两侧进房一格必须钉在同一条出口轴上，
    // 否则 PathFinder 对角跨房后两边路会对不齐（E27S36 y=29 / E28S36 y=30）
    alignBorderApproaches(result.path, remember);
  }

  for (const [name, cells] of byRoom) {
    const memory = (Memory.rooms[name] ??= {} as RoomMemory);
    memory.remoteRoads = encodeCells([...cells.values()]);
  }

  const remoteMemory = (Memory.rooms[roomName] ??= {} as RoomMemory);
  remoteMemory.remoteRoadsRev = REMOTE_ROADS_REV;

  const total = [...byRoom.values()].reduce((sum, cells) => sum + cells.size, 0);
  log.info("外矿", `${roomName} → ${home.name} 的路线规划完毕，共 ${total} 格，跨 ${byRoom.size} 个房间`);
}

/**
 * 出口格往房间里缩一格。交界圈本身不铺路，对接靠这一格对齐。
 */
export function inwardFromExit(x: number, y: number): Coord | undefined {
  if (x === 0) return { x: 1, y };
  if (x === ROOM_SIZE - 1) return { x: ROOM_SIZE - 2, y };
  if (y === 0) return { x, y: 1 };
  if (y === ROOM_SIZE - 1) return { x, y: ROOM_SIZE - 2 };
  return undefined;
}

/**
 * 跨房处两侧各钉一格，共享出口轴（东西邻房同 y，南北邻房同 x）。
 *
 * PathFinder 允许对角进出，路径里房内第一格的次坐标可能和出口不一致；
 * 只按路径原样铺就会出现两边路错开一行。
 */
export function alignBorderApproaches(
  path: { x: number; y: number; roomName: string }[],
  remember: (roomName: string, x: number, y: number) => void
): void {
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a.roomName === b.roomName) continue;

    const inwardA = inwardFromExit(a.x, a.y);
    const inwardB = inwardFromExit(b.x, b.y);
    if (inwardA) remember(a.roomName, inwardA.x, inwardA.y);
    if (inwardB) remember(b.roomName, inwardB.x, inwardB.y);
    if (inwardA && inwardB) continue;

    // 路径偶尔跳过出口格，按邻接方向用离开侧的次坐标对齐两侧
    const dir = Game.map.findExit(a.roomName, b.roomName);
    if (dir === FIND_EXIT_RIGHT) {
      remember(a.roomName, ROOM_SIZE - 2, a.y);
      remember(b.roomName, 1, a.y);
    } else if (dir === FIND_EXIT_LEFT) {
      remember(a.roomName, 1, a.y);
      remember(b.roomName, ROOM_SIZE - 2, a.y);
    } else if (dir === FIND_EXIT_BOTTOM) {
      remember(a.roomName, a.x, ROOM_SIZE - 2);
      remember(b.roomName, a.x, 1);
    } else if (dir === FIND_EXIT_TOP) {
      remember(a.roomName, a.x, 1);
      remember(b.roomName, a.x, ROOM_SIZE - 2);
    }
  }
}

/**
 * 算出外矿每个源旁边的容器落点。
 *
 * 要在路线规划之后跑：落点会优先贴着已经算好的路面，运输队取货不用绕路。
 * 没有视野也能算——地形和源坐标都在 Memory 里。
 */
export function planRemoteMiningSpots(home: Room, roomName: string): void {
  const sources = Memory.rooms[roomName]?.sources;
  if (!sources) return;

  const list: SourceInfo[] = Object.entries(sources).map(([id, spot]) => ({
    id,
    x: spot.x,
    y: spot.y
  }));
  if (list.length === 0) return;

  const favored = new Set(remoteRoadCells(roomName).map(cell => `${cell.x},${cell.y}`));
  const spots = planMiningSpotsOnly(terrainOfRoom(roomName), list, preferenceToward(home.name, roomName), favored);

  const memory = (Memory.rooms[roomName] ??= {} as RoomMemory);
  memory.miningSpots = spots;

  const count = Object.keys(spots).length;
  log.info("外矿", `${roomName} 矿边容器落点规划完毕，共 ${count} 个`);
}

/** 朝向老家的那个出口中点，用作"离家近"的参照 */
function preferenceToward(homeName: string, remoteName: string): Coord {
  const exit = Game.map.findExit(remoteName, homeName);
  if (exit === FIND_EXIT_TOP) return { x: 25, y: 2 };
  if (exit === FIND_EXIT_BOTTOM) return { x: 25, y: 47 };
  if (exit === FIND_EXIT_LEFT) return { x: 2, y: 25 };
  if (exit === FIND_EXIT_RIGHT) return { x: 47, y: 25 };
  return { x: 25, y: 25 };
}

function cache(matrices: Map<string, CostMatrix>, name: string, home: Room, anchor: Coord): CostMatrix {
  const matrix = buildMatrix(name, home, anchor);
  matrices.set(name, matrix);
  return matrix;
}

/**
 * 没有视野也要能算。
 *
 * `Game.map.getRoomTerrain` 不需要视野，而外矿路线要穿的房间多半正是看不见的那些。
 * 有视野时再叠上已有的路和挡路的建筑。
 */
function buildMatrix(name: string, home: Room, anchor: Coord): CostMatrix {
  const matrix = new PathFinder.CostMatrix();
  const terrain = Game.map.getRoomTerrain(name);

  for (let y = 0; y < ROOM_SIZE; y++) {
    for (let x = 0; x < ROOM_SIZE; x++) {
      const tile = terrain.get(x, y);
      if (tile === TERRAIN_MASK_WALL) {
        matrix.set(x, y, BLOCKED);
        continue;
      }
      matrix.set(x, y, tile === TERRAIN_MASK_SWAMP ? SWAMP_COST : PLAIN_COST);
    }
  }

  if (name === home.name) {
    // 基地地皮上迟早立起建筑，只有布局里的路能借道
    for (const structure of BUNKER_STRUCTURES) {
      const cost = structure.type === "road" ? ROAD_COST : BLOCKED;
      matrix.set(anchor.x + structure.dx, anchor.y + structure.dy, cost);
    }
  }

  const room = Game.rooms[name];
  if (!room) return matrix;

  for (const structure of room.find(FIND_STRUCTURES)) {
    if (structure.structureType === STRUCTURE_ROAD) {
      matrix.set(structure.pos.x, structure.pos.y, ROAD_COST);
    } else if (structure.structureType !== STRUCTURE_CONTAINER) {
      matrix.set(structure.pos.x, structure.pos.y, BLOCKED);
    }
  }

  return matrix;
}

/** 这个房间里外矿路线要铺的格子 */
export function remoteRoadCells(roomName: string): Coord[] {
  return decodeCells(Memory.rooms[roomName]?.remoteRoads ?? "");
}

/**
 * 在外矿房间里拍容器和路面工地。
 *
 * 房间不归我们，`runRoomPlanner` 不管它，所以这件事挂在"有视野时看一眼"那条
 * 路径上。容器不看老家等级——无主/预定房间里照样拍得下；路仍按老家等级解锁。
 * 容器优先占工地名额：矿边桶比路面更直接影响产出。
 */
export function maintainRemoteSites(room: Room, level: number, minLevel: number): void {
  let open = room.find(FIND_MY_CONSTRUCTION_SITES).length;

  for (const spot of Object.values(room.memory.miningSpots ?? {})) {
    if (open >= MAX_ROAD_SITES) return;

    const position = room.getPositionAt(spot.x, spot.y);
    if (!position) continue;
    if (position.lookFor(LOOK_STRUCTURES).some(structure => structure.structureType === STRUCTURE_CONTAINER)) {
      continue;
    }
    if (position.lookFor(LOOK_CONSTRUCTION_SITES).length > 0) continue;

    if (room.createConstructionSite(spot.x, spot.y, STRUCTURE_CONTAINER) === OK) open++;
  }

  if (level < minLevel) return;

  for (const cell of remoteRoadCells(room.name)) {
    if (open >= MAX_ROAD_SITES) return;

    const position = room.getPositionAt(cell.x, cell.y);
    if (!position) continue;
    if (position.lookFor(LOOK_STRUCTURES).some(structure => structure.structureType === STRUCTURE_ROAD)) continue;
    if (position.lookFor(LOOK_CONSTRUCTION_SITES).length > 0) continue;

    if (room.createConstructionSite(cell.x, cell.y, STRUCTURE_ROAD) === OK) open++;
  }
}

/** 这条路线上磨损最重的一格，给派驻的拓荒者修 */
export function wornRoad(room: Room): StructureRoad | undefined {
  let worst: StructureRoad | undefined;

  for (const cell of remoteRoadCells(room.name)) {
    const road = room
      .getPositionAt(cell.x, cell.y)
      ?.lookFor(LOOK_STRUCTURES)
      .find((structure): structure is StructureRoad => structure.structureType === STRUCTURE_ROAD);

    if (!road || road.hits > road.hitsMax * REPAIR_THRESHOLD) continue;
    if (!worst || road.hits < worst.hits) worst = road;
  }

  return worst;
}

/** 矿边容器里血量最低的那一个 */
export function wornContainer(room: Room): StructureContainer | undefined {
  let worst: StructureContainer | undefined;

  for (const spot of Object.values(room.memory.miningSpots ?? {})) {
    const container = containerAt(room, spot.x, spot.y);
    if (!container || container.hits > container.hitsMax * REPAIR_THRESHOLD) continue;
    if (!worst || container.hits < worst.hits) worst = container;
  }

  return worst;
}

/** 这条路线还差几格没铺，配额靠它判断要不要派人 */
export function unbuiltRemoteRoads(room: Room): number {
  let missing = 0;

  for (const cell of remoteRoadCells(room.name)) {
    const built = room
      .getPositionAt(cell.x, cell.y)
      ?.lookFor(LOOK_STRUCTURES)
      .some(structure => structure.structureType === STRUCTURE_ROAD);

    if (!built) missing++;
  }

  return missing;
}

/** 矿边容器还差几个没建 */
export function unbuiltRemoteContainers(room: Room): number {
  let missing = 0;

  for (const spot of Object.values(room.memory.miningSpots ?? {})) {
    const built = containerAt(room, spot.x, spot.y) !== undefined;
    if (!built) missing++;
  }

  return missing;
}
