/**
 * 移动入口。所有角色都该走这里，不要直接调 creep.moveTo。
 *
 * 比原版 moveTo 多做三件事：
 *
 * 一是认路。用自己的代价矩阵寻路，road 才有折扣，否则 creep 看不出路和平地
 * 有什么区别。
 *
 * 二是记路。moveTo 每 tick 都重新寻一遍路，一次几十上百 CPU；这里算一次
 * 存成方向串，之后每 tick 只是读一个字符。存方向而不是坐标是因为一步只要
 * 一个字符，几十步的路径也就几十字节，塞进 Memory 不心疼。
 *
 * 三是不自己动。算出下一步之后只登记给交通层，等全房间的意图收齐了统一结算，
 * 这样面对面的两个 creep 能直接换位，不用谁绕开谁。
 */

import { noteDeparture, requestMove } from "./traffic";
import { announce } from "../utils/logger";
import { costMatrixFor } from "./costMatrix";
import { isVisualOn } from "../utils/settings";

/** 方向常量 1..8 对应的坐标偏移，下标 0 空着占位 */
const OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
];

/**
 * 连续几 tick 没挪窝就当是卡住了。
 *
 * 定 3 是因为交通层已经处理了让位，正常情况下顶多因为疲劳停一两 tick。
 * 再多就说明路径本身有问题，重算一次比继续撞墙划算。
 */
const STUCK_LIMIT = 3;

/** 房内寻路的算力上限，超了就用当前找到的次优解 */
const MAX_OPS = 2000;

/**
 * 跨房间寻路的算力上限。
 *
 * 外矿单程六七十格，跨着两三个房间搜，2000 ops 经常不够用；不够时 PathFinder
 * 返回的是半成品，creep 会朝着大致方向撞墙。这条路每 tick 都在走，一次算贵点
 * 换一条真能走通的路是值的。
 */
const MAX_OPS_INTERROOM = 8000;

export interface TravelOptions {
  /** 离目标多近算到达，默认贴身。建造和升级这类远程操作可以放大 */
  range?: number;
  visualizePathStyle?: PolyStyle;
}

export function travelTo(creep: Creep, target: RoomPosition | _HasRoomPosition, options: TravelOptions = {}): void {
  const range = options.range ?? 1;
  const destination = target instanceof RoomPosition ? target : target.pos;

  if (creep.pos.inRangeTo(destination, range)) {
    // 到地方了就把路径丢掉，免得下次去别处时误用。
    // 这里不声明钉死：站定只是暂时的，该不该让路由角色自己判断。
    delete creep.memory.travel;
    return;
  }

  const state = refreshState(creep, destination, range);
  if (!state) {
    announce(creep, "无路");
    return;
  }

  const direction = toDirection(state.path[0]);
  if (!direction) {
    delete creep.memory.travel;
    return;
  }

  const next = stepFrom(creep.pos, direction);
  if (next) {
    state.last = keyOf(creep.pos);
    requestMove(creep, next);
  } else {
    // 下一格落在房间外面，说明这一步是跨出去。出口对面归另一个房间管，
    // 本房间的交通层看不到那边的 creep，也就无从协调，直接走；但要报备一声，
    // 否则边缘兜底会把正要出门的人当成闲人拉回来。
    // 过去之后路径缓存作废，下一 tick 在新房间从头寻路。
    creep.move(direction);
    noteDeparture(creep);
    delete creep.memory.travel;
  }

  // 颜色仍由调用方决定（区分取货/送货），开关只决定画不画
  if (options.visualizePathStyle && isVisualOn("movement")) {
    drawPath(creep, state.path, options.visualizePathStyle);
  }
}

/**
 * 更新路径缓存，必要时重新寻路。
 *
 * 判断上一步走没走成靠对比位置而不是 move 的返回值：move 返回 OK 只代表
 * 意图登记成功，真正走没走成要等结算，而结算的时候这段代码早就跑完了。
 */
function refreshState(creep: Creep, destination: RoomPosition, range: number): TravelState | undefined {
  const state = creep.memory.travel;
  const wanted = destinationKey(destination, range);

  if (state && state.last) {
    if (state.last === keyOf(creep.pos)) {
      state.stuck++;
    } else {
      state.stuck = 0;
      state.path = state.path.slice(1);
    }
  }

  if (state && state.dest === wanted && state.path.length > 0 && state.stuck < STUCK_LIMIT) {
    return state;
  }

  const path = findPath(creep, destination, range, Boolean(state && state.stuck >= STUCK_LIMIT));
  if (!path) return undefined;

  const fresh: TravelState = { dest: wanted, path, stuck: 0, last: "" };
  creep.memory.travel = fresh;
  return fresh;
}

/**
 * 寻一条路并压成方向串。
 *
 * 卡了太久的时候把所有 creep 当成障碍重算一次：正常情况下不该躲同伴，
 * 它们迟早会走开；但已经卡了几 tick 就说明对面也动不了，这时候绕开才是对的。
 */
function findPath(creep: Creep, destination: RoomPosition, range: number, avoidCreeps: boolean): string | undefined {
  const crossing = destination.roomName !== creep.pos.roomName;
  const result = PathFinder.search(
    creep.pos,
    { pos: destination, range },
    {
      plainCost: 2,
      swampCost: 10,
      maxOps: crossing ? MAX_OPS_INTERROOM : MAX_OPS,
      roomCallback: roomName => {
        const room = Game.rooms[roomName];
        if (!room) return false;

        const matrix = costMatrixFor(room);
        if (!avoidCreeps) return matrix;

        const withCreeps = matrix.clone();
        for (const other of room.find(FIND_CREEPS)) withCreeps.set(other.pos.x, other.pos.y, 255);
        return withCreeps;
      }
    }
  );

  if (result.path.length === 0) return undefined;

  let serialized = "";
  let previous = creep.pos;
  for (const step of result.path) {
    serialized += previous.getDirectionTo(step);

    // 跨出房间的那一步要编进来，否则 creep 走到出口格就没有下一步可走了。
    // 但只编这一步：邻房的地形要有视野才看得清，隔着墙算出来的路多半是错的，
    // 等真站过去了再重新算。
    if (step.roomName !== previous.roomName) break;
    previous = step;
  }

  return serialized.length > 0 ? serialized : undefined;
}

function toDirection(character: string): DirectionConstant | undefined {
  const value = Number(character);
  return value >= 1 && value <= 8 ? (value as DirectionConstant) : undefined;
}

/** 算出这一步落在哪；返回 undefined 表示走出了房间，得交给调用方按跨房间处理 */
function stepFrom(pos: RoomPosition, direction: DirectionConstant): RoomPosition | undefined {
  const offset = OFFSETS[direction];
  const x = pos.x + offset[0];
  const y = pos.y + offset[1];
  if (x < 0 || y < 0 || x > 49 || y > 49) return undefined;

  return new RoomPosition(x, y, pos.roomName);
}

function drawPath(creep: Creep, path: string, style: PolyStyle): void {
  const points: [number, number][] = [];
  let x = creep.pos.x;
  let y = creep.pos.y;

  for (const character of path) {
    const offset = OFFSETS[Number(character)];
    if (!offset) break;

    x += offset[0];
    y += offset[1];
    points.push([x, y]);
  }

  if (points.length > 0) creep.room.visual.poly(points, style);
}

function keyOf(pos: RoomPosition): string {
  return `${pos.x},${pos.y}`;
}

function destinationKey(pos: RoomPosition, range: number): string {
  return `${pos.x},${pos.y},${pos.roomName},${range}`;
}
