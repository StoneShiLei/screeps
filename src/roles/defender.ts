/**
 * defender：家里进了人才孵化，打完就自然老死。
 *
 * 常备军在 Screeps 里是笔烂账——入侵者要等房间累计采够十万能量才会来一次，
 * 平时养着的兵每 1500 tick 就得重造一遍，那笔钱够多造好几个 extension。
 * 所以配额直接挂在"房间里有几个敌人"上，没敌人时是零。
 *
 * 代价是遇袭那一刻手上一个兵都没有，得现造。真正扛住第一波的是塔，
 * defender 是给塔补刀、以及三级前还没塔时的应急手段。
 */

import { announce, log } from "../utils/logger";
import { requestMove } from "../movement/traffic";
import { travelTo } from "../movement/move";

/** 敌人离得比这还远就先不管，省得被牵着满房间跑，离开塔的火力范围 */
const CHASE_RANGE = 20;

/** 非战斗 creep 感到危险的距离。入侵者带远程攻击，射程 3，留点余量 */
const FLEE_RANGE = 6;

/** 撤退时一次最多算这么多步，逃命不值得花大钱寻路 */
const FLEE_OPS = 500;

interface RoomThreat {
  hostiles: Creep[];
  towered: boolean;
}

/**
 * 本 tick 各房间的敌情。
 *
 * 遇袭时房间里每个 creep 都要问一遍"有敌人吗、有塔吗"，各自 find 一遍
 * 就是几十次全房遍历。查一次存下来，这一 tick 里谁问都是同一个答案。
 */
let threats: { tick: number; rooms: Record<string, RoomThreat> } = { tick: -1, rooms: {} };

function threatOf(room: Room): RoomThreat {
  if (threats.tick !== Game.time) threats = { tick: Game.time, rooms: {} };

  return (threats.rooms[room.name] ??= scanThreat(room));
}

function scanThreat(room: Room): RoomThreat {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);

  // 平安无事时就别去数塔了，那是全房遍历，而绝大多数 tick 都平安无事
  const towered =
    hostiles.length > 0 &&
    room.find(FIND_MY_STRUCTURES, { filter: structure => structure.structureType === STRUCTURE_TOWER }).length > 0;

  return { hostiles, towered };
}

export function hostilesIn(room: Room): Creep[] {
  return threatOf(room).hostiles;
}

export function runDefender(creep: Creep): void {
  const hostiles = hostilesIn(creep.room);
  const target = creep.pos.findClosestByRange(hostiles);

  if (!target || creep.pos.getRangeTo(target) > CHASE_RANGE) {
    rally(creep);
    return;
  }

  announce(creep, "迎战");

  // 先打再走：攻击不看这一 tick 有没有移动，够得着就先削一刀
  if (creep.attack(target) === ERR_NOT_IN_RANGE) {
    travelTo(creep, target.pos, { range: 1, visualizePathStyle: { stroke: "#ff4444" } });
  }
}

/**
 * 没仗打时回 spawn 边上待着。
 *
 * 待在门口而不是原地不动，是因为入侵者是冲着 spawn 来的，在那儿等
 * 等于站在必经之路上。
 */
function rally(creep: Creep): void {
  const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return;

  announce(creep, "待命");
  travelTo(creep, spawn.pos, { range: 3 });
}

/**
 * 没塔的时候让非战斗 creep 躲远点。返回 true 表示这一 tick 它只顾逃命。
 *
 * 三级之前房间是没有塔的，一个矿工站在原地被入侵者慢慢磨死，损失的不只是
 * 那 550 能量，还有它本该挖出来的几千点。跑开虽然也停产，但人还在。
 *
 * 有塔之后就不躲了：塔的火力比 creep 的命值钱得多，把敌人引到塔下才是对的，
 * 何况满房间乱跑还会把交通搅乱。
 */
export function evade(creep: Creep): boolean {
  const threat = threatOf(creep.room);
  if (threat.hostiles.length === 0 || threat.towered) return false;

  const danger = threat.hostiles.filter(hostile => creep.pos.getRangeTo(hostile) <= FLEE_RANGE);
  if (danger.length === 0) return false;

  const escape = PathFinder.search(
    creep.pos,
    danger.map(hostile => ({ pos: hostile.pos, range: FLEE_RANGE })),
    { flee: true, maxOps: FLEE_OPS, plainCost: 2, swampCost: 10 }
  );

  announce(creep, "逃");

  const step = escape.path[0];
  if (step) requestMove(creep, step);

  // 逃跑路线和平时的路径缓存冲突，留着下 tick 会被当成还在原路上走
  delete creep.memory.travel;
  return true;
}

/** 敌情播报，给主循环用。数量变了才吭声，不然一千多 tick 全是同一行 */
export function reportThreat(room: Room): void {
  const count = hostilesIn(room).length;
  const previous = room.memory.threat ?? 0;
  if (count === previous) return;

  room.memory.threat = count;
  if (count > 0) log.warn("防御", `${room.name} 出现 ${count} 个敌对 creep`);
  else log.info("防御", `${room.name} 敌人清空`);
}
