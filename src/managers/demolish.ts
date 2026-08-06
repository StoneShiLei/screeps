/**
 * 清掉前人留在自己房间里的建筑。
 *
 * 占下一个有旧基地的房间时会撞上一条不直观的规则：建筑数量上限（CONTROLLER_STRUCTURES）
 * 是按**房间里该类建筑的总数**算的，不分归属。前主人那个还立着的 spawn 就占掉了 RCL1
 * 唯一的 spawn 名额，我们自己的 spawn 工地一拍就是 ERR_RCL_NOT_ENOUGH——而地形是空的、
 * 等级是够的，从现象上完全看不出原因。
 *
 * 同理，旧 extension 挡住 RCL2 之后我们自己的 extension，旧塔挡住 RCL3 的塔。旧塔还多
 * 一层危险：房间升到 3 级那一刻它就重新变成"有效建筑"，而它的主人不是我们——他要是
 * 还在运行代码并且看得见这个房间，那座塔就会朝我们的人开火。
 *
 * 用 destroy 而不是派人去拆：自己房间里的建筑（包括别人的）可以直接 destroy，一条指令、
 * 瞬间完成、不花能量。拆迁看着更"划算"其实是个错觉——DISMANTLE_COST 是 0.005，
 * 拆一整个 spawn 也就返还几十点能量，为它花上百 tick 的 creep 时间是亏的。
 *
 * destroy 唯一的限制是房间里不能有敌对 creep。刚占下的房间常常还站着前主人或者邻居的
 * 人，那种时候只能等——对方失去这个房间的归属之后不会再补员，现有的人一千多 tick
 * 内会自己老死。这段时间里拓荒者手上有拆的活可以顶着。
 */

import { intrudersIn } from "../roles/defender";
import { log } from "../utils/logger";

/**
 * 拆除顺序，按"先挡住谁"排。
 *
 * spawn 排第一是因为它挡的是整个殖民地——没有 spawn 的房间什么都干不了。
 * 之后按解锁等级往下走：extension 挡 2 级，塔挡 3 级，其余都在更后面。
 *
 * 墙和城墙故意不在名单里：它们不占建筑上限，圈在外面还是白捡的防御工事。
 * 真挡在规划位置上的那几段由 clearInheritedWalls 单独处理。
 */
const DEMOLITION_ORDER: StructureConstant[] = [
  "spawn",
  "extension",
  "tower",
  "link",
  "lab",
  "extractor",
  "observer",
  "powerSpawn",
  "nuker",
  "factory",
  "storage",
  "terminal"
];

/**
 * 里面的货多到这个数就先别拆，等搬运工掏空。
 *
 * 拆之前清空是为了不把货洒在地上蒸发，但这件事要有个额度：前主人的 spawn 里剩着
 * 一百多点能量，为了这点零头把整个殖民地的开工时间往后推几千 tick（搬运工得先把
 * terminal 里那八万点搬完才轮到它）显然不划算。
 */
const WORTH_SAVING = 1000;

/** 一 tick 最多拆几个。destroy 不花钱，这个上限纯粹是为了日志能读 */
const PER_TICK = 5;

/**
 * 把挡路的前人建筑拆掉。
 *
 * 每 tick 都可以跑：没东西可拆时只是一次 find，占下的房间稳定下来之后名单就空了。
 */
export function runDemolition(room: Room): void {
  const targets = demolitionList(room);
  if (targets.length === 0) return;

  // destroy 在房间里有敌对 creep 时一律被拒绝，武装与否都算
  if (isBlocked(room)) {
    log.debug("拆迁", () => `${room.name} 还有 ${intrudersIn(room).length} 个外人在场，destroy 用不了，先清场`);
    return;
  }

  for (const structure of targets.sort((a, b) => rankOf(a) - rankOf(b)).slice(0, PER_TICK)) {
    const type = structure.structureType;
    const result = structure.destroy();

    if (result === OK) log.info("拆迁", `${room.name} 拆掉前人的 ${type} (${structure.pos.x},${structure.pos.y})`);
    else log.warn("拆迁", `${room.name} 拆不掉 (${structure.pos.x},${structure.pos.y}) 的 ${type}：错误码 ${result}`);
  }
}

/**
 * 有活要干、但被赖着不走的外人堵住了。
 *
 * 这个状态会一直卡着不动：`destroy` 见到任何敌对 creep 就拒绝，而对方失去房间
 * 归属之后往往就地停摆——它们不干活也不走，只是站着等老死，最长一千五百 tick。
 * 整座前人基地占着建筑上限，我们的 spawn 和 extension 一个也拍不下来。
 *
 * 派一个兵过去清场比等便宜得多：它们是矿工和运输队，一个攻击部件都没有。
 */
export function isBlocked(room: Room): boolean {
  return intrudersIn(room).length > 0;
}

/** 需要有人去清场的自有房间：有拆迁积压，而且被外人堵着 */
export function blockedByIntruders(room: Room): boolean {
  return demolitionList(room).length > 0 && isBlocked(room);
}

/**
 * 这个房间里下一个该拆的前人建筑，给拓荒者用。
 *
 * 拓荒者拆是备用手段：destroy 被敌对 creep 挡住的时候，dismantle 不受这条限制，
 * 是当下唯一能推进的办法。
 */
export function demolitionTarget(room: Room): Structure | undefined {
  const candidates = demolitionList(room);
  if (candidates.length === 0) return undefined;

  return candidates.sort((a, b) => rankOf(a) - rankOf(b))[0];
}

/** 还剩几个要拆，给面板和控制台看进度 */
export function demolitionList(room: Room): Structure[] {
  // 只在自己的房间里动手：别人房间里的建筑该不该拆是另一回事，那是打仗
  if (!room.controller?.my) return [];

  return room.find(FIND_HOSTILE_STRUCTURES).filter(isWorthRemoving);
}

function isWorthRemoving(structure: Structure): boolean {
  if (rankOf(structure) < 0) return false;

  const store = (structure as AnyStoreStructure).store;
  return (store?.getUsedCapacity() ?? 0) < WORTH_SAVING;
}

function rankOf(structure: Structure): number {
  return DEMOLITION_ORDER.indexOf(structure.structureType);
}
