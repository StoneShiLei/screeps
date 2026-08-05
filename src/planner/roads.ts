/**
 * 主干道规划：把矿点、控制器和基地门口连起来。
 *
 * 只规划房间内这几条高频路线。hauler 一辈子就在矿边容器和 spawn 之间往返，
 * 这几条线上的每一格路，收益都会被跑过的次数放大成千上万倍；而房间里
 * 其他地方铺路基本是在给风景花钱。
 *
 * 几条路是依次算的，算完一条就把它的格子降成路价，后面的路自然会拐过来
 * 汇进同一条主干。分开算的话会得到三条各走各的平行线，多花一倍能量，
 * 维修面积也大一倍。
 */

import { BUNKER_STRUCTURES } from "./bunkerLayout";
import { Coord } from "./outposts";
import { isBunkerCell } from "./bunkerPlanner";

/** 和 movement/costMatrix 用同一套相对代价，规划出来的路才是 creep 真会走的路 */
const ROAD_COST = 1;
const PLAIN_COST = 2;
const SWAMP_COST = 10;
const BLOCKED = 255;

const ROOM_SIZE = 50;

/** 单条路的寻路算力上限 */
const MAX_OPS = 4000;

/**
 * 坐标编码的基数。
 *
 * 一格两个字符，x 和 y 各一个。48 起头是为了让 0..49 全部落在 '0'..'a' 这段
 * 可打印 ASCII 里——Memory 存的是 JSON，落到控制字符或者非 ASCII 上会被转义成
 * \uXXXX，一格就从 2 字节涨到 12 字节。
 */
const ENCODE_BASE = 48;

export function encodeCells(cells: Coord[]): string {
  let packed = "";
  for (const cell of cells) {
    packed += String.fromCharCode(ENCODE_BASE + cell.x, ENCODE_BASE + cell.y);
  }
  return packed;
}

export function decodeCells(packed: string): Coord[] {
  const cells: Coord[] = [];
  for (let i = 0; i + 1 < packed.length; i += 2) {
    cells.push({
      x: packed.charCodeAt(i) - ENCODE_BASE,
      y: packed.charCodeAt(i + 1) - ENCODE_BASE
    });
  }
  return cells;
}

/**
 * 算出该铺路的格子，返回编码后的串。
 *
 * 只在规划房间时跑一次，跑完存 Memory，之后每 tick 都是直接读。
 */
export function planRoads(room: Room, anchor: Coord): string {
  const entrances = bunkerEntrances(room, anchor);
  if (entrances.length === 0) return "";

  const targets = roadTargets(room);
  if (targets.length === 0) return "";

  const matrix = roadMatrix(room, anchor);
  const goals = entrances.map(pos => ({ pos, range: 0 }));
  const cells = new Map<string, Coord>();

  for (const target of targets) {
    const result = PathFinder.search(target, goals, {
      maxOps: MAX_OPS,
      plainCost: PLAIN_COST,
      swampCost: SWAMP_COST,
      roomCallback: () => matrix
    });
    if (result.incomplete) continue;

    for (const step of result.path) {
      if (step.roomName !== room.name) continue;
      // bunker 自己那圈路由布局表管，别重复拍工地
      if (isBunkerCell(anchor.x, anchor.y, step.x, step.y)) continue;

      cells.set(`${step.x},${step.y}`, { x: step.x, y: step.y });
      matrix.set(step.x, step.y, ROAD_COST);
    }
  }

  return encodeCells([...cells.values()]);
}

/**
 * 基地外圈那几个路口。
 *
 * bunker 的墙不是密不透风的，布局表在四条边的中段各留了五格路当门。
 * 让外面的路精确接到门上，进出基地才不用绕着围墙走半圈。
 */
function bunkerEntrances(room: Room, anchor: Coord): RoomPosition[] {
  const radius = BUNKER_STRUCTURES.reduce((max, s) => Math.max(max, Math.abs(s.dx), Math.abs(s.dy)), 0);
  const entrances: RoomPosition[] = [];

  for (const structure of BUNKER_STRUCTURES) {
    if (structure.type !== "road") continue;
    if (Math.abs(structure.dx) !== radius && Math.abs(structure.dy) !== radius) continue;

    const position = room.getPositionAt(anchor.x + structure.dx, anchor.y + structure.dy);
    if (position) entrances.push(position);
  }

  return entrances;
}

/**
 * 路要通到哪几个地方。
 *
 * 终点是容器本身，但路径不含起点，所以最后落的是紧挨容器的那一格——
 * 正好够 hauler 站在路上取货，容器那格也空出来留给容器自己。
 */
function roadTargets(room: Room): RoomPosition[] {
  const targets: RoomPosition[] = [];
  const spots = [...Object.values(room.memory.miningSpots ?? {})];

  const upgradeSpot = room.memory.upgradeSpot;
  if (upgradeSpot) spots.push(upgradeSpot);

  for (const spot of spots) {
    const position = room.getPositionAt(spot.x, spot.y);
    if (position) targets.push(position);
  }

  return targets;
}

function roadMatrix(room: Room, anchor: Coord): CostMatrix {
  const matrix = new PathFinder.CostMatrix();
  const terrain = room.getTerrain();

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

  // 基地地皮上迟早会立起建筑，只有布局里的路能借道
  for (const structure of BUNKER_STRUCTURES) {
    const x = anchor.x + structure.dx;
    const y = anchor.y + structure.dy;
    matrix.set(x, y, structure.type === "road" ? ROAD_COST : BLOCKED);
  }

  // 容器和路不能同格，落点得给容器留着。升级站位反倒不用避——
  // 升级工站在路上照样干活，还省一半疲劳。
  for (const spot of Object.values(room.memory.miningSpots ?? {})) {
    matrix.set(spot.x, spot.y, BLOCKED);
  }
  const upgradeSpot = room.memory.upgradeSpot;
  if (upgradeSpot) matrix.set(upgradeSpot.x, upgradeSpot.y, BLOCKED);

  for (const structure of room.find(FIND_STRUCTURES)) {
    if (structure.structureType === STRUCTURE_ROAD) {
      matrix.set(structure.pos.x, structure.pos.y, ROAD_COST);
    }
  }

  return matrix;
}
