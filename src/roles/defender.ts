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

/**
 * 会打人的部件。
 *
 * HEAL 也算：单独一个奶妈伤不了我们，但它出现就说明这是支战斗队伍，
 * 后面跟着的才是真正要命的。
 *
 * 写字符串字面量而不是 ATTACK 那些全局常量：常量只在游戏运行时存在，
 * 模块顶层引用会让单元测试加载阶段就崩。
 */
const WEAPONS: BodyPartConstant[] = ["attack", "ranged_attack", "heal"];

interface RoomThreat {
  /** 带武器的敌人。逃跑、孵化防御兵、外矿撤退都只认这些 */
  armed: Creep[];
  /** 房间里所有敌对 creep，含对方的矿工和运输队 */
  all: Creep[];
  towered: boolean;
}

/**
 * 这个敌对 creep 打得死人吗。
 *
 * 分清"敌人"和"竞争者"是有代价的教训：邻居的 worker 和 transport 一个 ATTACK
 * 都没带，纯粹是去采矿运货的，而我们原来见到任何敌对 creep 就给房间记上遇袭、
 * 停 1500 tick、把全部外派人员撤回来。邻居那边天天有人路过，于是那个外矿等于
 * 被我们自己永久让了出去——对方一枪没放。
 *
 * 带 WORK 的确实能拆我们的建筑，但那是塔该管的事（一发 10 能量），不值得让
 * 整条产线停摆，更不值得放弃一个房间。
 */
function isArmed(creep: Creep): boolean {
  return creep.body.some(part => WEAPONS.includes(part.type));
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
  const all = room.find(FIND_HOSTILE_CREEPS);
  const armed = all.filter(isArmed);

  // 平安无事时就别去数塔了，那是全房遍历，而绝大多数 tick 都平安无事
  const towered =
    armed.length > 0 &&
    room.find(FIND_MY_STRUCTURES, { filter: structure => structure.structureType === STRUCTURE_TOWER }).length > 0;

  return { armed, all, towered };
}

/** 带武器的敌人。配额和撤退判断用这个 */
export function hostilesIn(room: Room): Creep[] {
  return threatOf(room).armed;
}

/** 房间里全部敌对 creep，包括手无寸铁的矿工运输队。塔照打不误，反正一发才 10 能量 */
export function intrudersIn(room: Room): Creep[] {
  return threatOf(room).all;
}

export function runDefender(creep: Creep): void {
  // 优先打带武器的，剩下的经济单位随手清理——先解决打得死人的那些
  const threat = threatOf(creep.room);
  const hostiles = threat.armed.length > 0 ? threat.armed : threat.all;
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
  if (threat.armed.length === 0 || threat.towered) return false;

  const danger = threat.armed.filter(hostile => creep.pos.getRangeTo(hostile) <= FLEE_RANGE);
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

/**
 * 敌情播报，给主循环用。数量变了才吭声，不然一千多 tick 全是同一行。
 *
 * 记进 Memory 的是带武器的那些，因为读它的地方（配额、面板）问的都是
 * "要不要打"。手无寸铁的邻居单独提一句就够——那是竞争，不是战争。
 */
export function reportThreat(room: Room): void {
  const threat = threatOf(room);
  const count = threat.armed.length;
  const previous = room.memory.threat ?? 0;
  if (count === previous) return;

  room.memory.threat = count;
  if (count > 0) {
    const unarmed = threat.all.length - count;
    log.warn("防御", `${room.name} 出现 ${count} 个武装敌人${unarmed > 0 ? `，另有 ${unarmed} 个经济单位` : ""}`);
  } else {
    log.info("防御", `${room.name} 武装敌人清空${threat.all.length > 0 ? `，还有 ${threat.all.length} 个邻居在场` : ""}`);
  }
}
