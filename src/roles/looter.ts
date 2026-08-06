/**
 * looter：去无主房间把前人留下的存货搬回家。
 *
 * 除了取货地点是敌方建筑，它和普通搬运工没有区别——所以体型也一样，是纯
 * CARRY 加 MOVE。活干完之后不自杀，直接转成 hauler：身体完全通用，而孵化费
 * 已经付过了。
 */

import { announce, log } from "../utils/logger";
import { claimDemand, logisticsOf } from "../managers/logistics";
import { commuteTo, travelTo } from "../movement/move";
import { lootPiles, pickResource, short } from "../managers/loot";

export function runLooter(creep: Creep): void {
  updateState(creep);

  if (creep.memory.working) {
    deliver(creep);
  } else {
    collect(creep);
  }
}

/**
 * 装满了才回家，卸空了才再出门。
 *
 * 这个状态必须是黏的。原来判断的是"此刻装满了没有"，于是往一个 extension 卸掉
 * 50 之后它就不再满，当场转身跑回外矿——一趟能拉四百点的车，每次只送五十点，
 * 剩下的三百五十点跟着它跑完整个来回。
 *
 * 换状态时清掉上一段的认领：留着的话物流系统会一直替它占着那个目标的份额，
 * 而它正在另一个房间装货，那个 extension 就永远等不到人。
 */
function updateState(creep: Creep): void {
  if (creep.memory.working && creep.store.getUsedCapacity() === 0) {
    creep.memory.working = false;
    delete creep.memory.deliverTo;
    announce(creep, "去搬");
  } else if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    delete creep.memory.withdrawFrom;
    announce(creep, "回家");
  }
}

function collect(creep: Creep): void {
  const roomName = creep.memory.targetRoom;
  if (!roomName) {
    // 任务撤了。手上还有货就先送掉，空手的直接转正
    if (creep.store.getUsedCapacity() > 0) creep.memory.working = true;
    else finish(creep);
    return;
  }

  if (commuteTo(creep, roomName)) return;

  const pile = pickPile(creep);
  if (!pile) {
    // 这个房间搬空了。手上有货就送回去，空手就等管理器撤配额
    if (creep.store.getUsedCapacity() > 0) creep.memory.working = true;
    else announce(creep, "搬空了");
    return;
  }

  const resource = pickResource(pile.store, homeOf(creep) ?? creep.room);
  if (!resource) {
    // 只剩家里放不下的矿物。占着编制干等没意义，回去当搬运工
    announce(creep, "拿不动");
    if (creep.store.getUsedCapacity() > 0) creep.memory.working = true;
    return;
  }

  const result = creep.withdraw(pile, resource);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, pile, { visualizePathStyle: { stroke: "#ffdd44" } });
    return;
  }

  if (result === OK) announce(creep, short(pile.store.getUsedCapacity(resource) ?? 0));
}

/**
 * 挑一个取货点，存货最多的优先。
 *
 * 认领之后记住不换：几个人一起扑向同一个 terminal 是对的（withdraw 允许多人
 * 同 tick 取同一个目标），但每 tick 重新排序会让它们在两个仓库之间来回走。
 */
function pickPile(creep: Creep): AnyStoreStructure | undefined {
  const remembered = creep.memory.withdrawFrom
    ? Game.getObjectById(creep.memory.withdrawFrom as Id<AnyStoreStructure>)
    : undefined;
  // 单一资源的仓库（比如 spawn）不带参数问总量会返回 null，当空处理
  if (remembered && (remembered.store.getUsedCapacity() ?? 0) > 0) return remembered;

  const best = lootPiles(creep.room)[0];
  if (!best) {
    delete creep.memory.withdrawFrom;
    return undefined;
  }

  creep.memory.withdrawFrom = best.structure.id;
  return best.structure;
}

/**
 * 回家交货。
 *
 * 能量走正常的物流需求表，和搬运工一样按优先级填 spawn、extension、塔；
 * 矿物只能进 storage，别处都不收。
 */
function deliver(creep: Creep): void {
  const home = homeOf(creep);
  if (!home) return;

  if (commuteTo(creep, home.name)) return;

  delete creep.memory.withdrawFrom;

  const mineral = (Object.keys(creep.store) as ResourceConstant[]).find(type => type !== RESOURCE_ENERGY);
  if (mineral) {
    if (!home.storage) {
      // 家里没有 storage，矿物无处可放。取货那头已经拦着不拿矿物了，能走到这里
      // 只可能是 storage 中途被拆了。倒在地上也比让它卡死一个编制名额好
      log.warn("搬运", `${home.name} 没有 storage，${creep.name} 只能把 ${mineral} 倒在地上`);
      creep.drop(mineral);
      return;
    }

    if (creep.transfer(home.storage, mineral) === ERR_NOT_IN_RANGE) {
      travelTo(creep, home.storage, { visualizePathStyle: { stroke: "#ffffff" } });
    }
    return;
  }

  const target = claimDemand(creep, logisticsOf(home, creep).demands);
  if (!target) {
    // 家里暂时没地方收。站在 spawn 边上等，别跑回去白跑一趟
    announce(creep, "满仓");
    return;
  }

  if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffffff" } });
  }
}

/**
 * 活干完了，转成搬运工。
 *
 * 纯 CARRY MOVE 的身体正是 hauler 要的，孵化费也已经付了，自杀等于白扔
 * 剩下那几百 tick 的运力。
 */
function finish(creep: Creep): void {
  if (creep.memory.targetRoom) return;

  log.info("搬运", `${creep.name} 没有仓库要搬了，转做 hauler`);
  creep.memory.role = "hauler";
  delete creep.memory.withdrawFrom;
  delete creep.memory.deliverTo;
}

function homeOf(creep: Creep): Room | undefined {
  return Game.rooms[creep.memory.room];
}
