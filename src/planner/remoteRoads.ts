/**
 * 外矿到基地的路。
 *
 * 值得铺是因为收益会被跑过的次数放大：运输队一辈子就在源和基地之间往返，路面把
 * 每格的疲劳从 2 降到 1，等于让同样的预算多买一半 CARRY——没有路的时候它必须
 * 一比一配 MOVE 才能满载全速，铺好之后二比一就够了。
 *
 * 和房内主干道分开存（`RoomMemory.remoteRoads`），不和 `roads` 合成一份，是为了
 * 两件事互不干扰：房间重新规划时不会把外矿路线冲掉，外矿换人家时也只用清掉
 * 自己那一段。读的时候两份取并集。
 */

import { bunkerEntrances, decodeCells, encodeCells } from "./roads";
import { BUNKER_STRUCTURES } from "./bunkerLayout";
import { Coord } from "./outposts";
import { isBunkerCell } from "./bunkerPlanner";
import { log } from "../utils/logger";

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
      // 房间交界那圈不铺：站上去就换房间了，路面留不住人也建不了工地
      if (step.x === 0 || step.y === 0 || step.x === ROOM_SIZE - 1 || step.y === ROOM_SIZE - 1) continue;
      // 基地自己那圈路由布局表管
      if (step.roomName === home.name && isBunkerCell(anchor.x, anchor.y, step.x, step.y)) continue;

      const cells = byRoom.get(step.roomName) ?? new Map<string, Coord>();
      cells.set(`${step.x},${step.y}`, { x: step.x, y: step.y });
      byRoom.set(step.roomName, cells);

      // 后一条路线看到前一条已经铺过的格子就会拐过来汇进同一条主干，
      // 而不是各走一条平行线——那样要多花一倍能量，维修面积也大一倍
      matrices.get(step.roomName)?.set(step.x, step.y, ROAD_COST);
    }
  }

  for (const [name, cells] of byRoom) {
    const memory = (Memory.rooms[name] ??= {} as RoomMemory);
    memory.remoteRoads = encodeCells([...cells.values()]);
  }

  const total = [...byRoom.values()].reduce((sum, cells) => sum + cells.size, 0);
  log.info("外矿", `${roomName} → ${home.name} 的路线规划完毕，共 ${total} 格，跨 ${byRoom.size} 个房间`);
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
 * 在外矿房间里拍路面工地。
 *
 * 房间不归我们，`runRoomPlanner` 不管它，所以这件事挂在"有视野时看一眼"那条
 * 路径上。无主房间里造路不受等级限制（没有控制器就没有建筑上限），拍得下。
 */
export function maintainRemoteRoadSites(room: Room, level: number, minLevel: number): void {
  if (level < minLevel) return;

  const cells = remoteRoadCells(room.name);
  if (cells.length === 0) return;

  let open = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  if (open >= MAX_ROAD_SITES) return;

  for (const cell of cells) {
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
