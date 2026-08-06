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
  const carrying = creep.store.getUsedCapacity() > 0;

  // 装满了就回家，没装满但目标没了也回家——手里那点货照样要交掉
  const roomName = creep.memory.targetRoom;
  if (!roomName || creep.store.getFreeCapacity() === 0) {
    deliver(creep);
    return;
  }

  if (commuteTo(creep, roomName)) {
    announce(creep, carrying ? "满载" : "去搬");
    return;
  }

  const pile = pickPile(creep);
  if (!pile) {
    // 这个房间搬空了。手上有货就送回去，空手就等管理器撤配额
    if (carrying) deliver(creep);
    else announce(creep, "搬空了");
    return;
  }

  const resource = pickResource(pile.store, homeOf(creep) ?? creep.room);
  if (!resource) {
    announce(creep, "拿不动");
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

  if (creep.store.getUsedCapacity() === 0) {
    finish(creep);
    return;
  }

  if (creep.room.name !== home.name) {
    announce(creep, "回家");
    commuteTo(creep, home.name);
    return;
  }

  delete creep.memory.withdrawFrom;

  const mineral = (Object.keys(creep.store) as ResourceConstant[]).find(type => type !== RESOURCE_ENERGY);
  if (mineral && home.storage) {
    if (creep.transfer(home.storage, mineral) === ERR_NOT_IN_RANGE) {
      travelTo(creep, home.storage, { visualizePathStyle: { stroke: "#ffffff" } });
    }
    return;
  }

  const target = claimDemand(creep, logisticsOf(home).demands);
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
