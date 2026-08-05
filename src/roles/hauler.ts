/**
 * hauler：只搬不挖，活儿从物流系统现领。
 *
 * 和 builder、upgrader 那种"认准一件事干到底"的角色不同，hauler 每次
 * 交完货就重新问一遍"现在哪里最缺"，所以房间里的能量流向能随时调整——
 * 造兵的时候优先喂 spawn，被打的时候优先喂 tower，不用改一行代码。
 */

import { LogisticsEntry, SUPPLY_PRIORITY, chooseEntry, claimSupply, isDropped, logisticsOf } from "../managers/logistics";
import { announce } from "../utils/logger";
import { travelTo } from "../movement/move";

/** 自己不采集、靠别人供能的角色，闲下来的运力优先喂它们 */
const FEED_ROLES: CreepRole[] = ["builder", "upgrader"];

/** 超过这个距离就不值得专门跑一趟去喂 */
const FEED_RANGE = 5;

export function runHauler(creep: Creep): void {
  updateState(creep);

  if (creep.memory.working) {
    deliver(creep);
  } else {
    pickUp(creep);
  }
}

/**
 * 空了就去取货，满了就去送货。
 *
 * 换状态时把上一段的任务清掉，否则物流系统会以为它还在赶去那个目标，
 * 白白替它占着份额，别的 hauler 就不去了。
 */
function updateState(creep: Creep): void {
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    delete creep.memory.deliverTo;
    announce(creep, "取货");
  } else if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    delete creep.memory.withdrawFrom;
    announce(creep, "送货");
  }
}

function deliver(creep: Creep): void {
  const target = resolveDelivery(creep) ?? nearbyWorker(creep);
  if (!target) {
    announce(creep, "待命");
    return;
  }

  const result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffffff" } });
  } else {
    // 不管是送完了还是目标满了，都重新挑一个，别在原地耗着
    delete creep.memory.deliverTo;
  }
}

function pickUp(creep: Creep): void {
  const target = claimSupply(creep, availableSupplies(creep.room));

  if (!target) {
    // 没货可取但身上有存货时改去送货，免得半满的 hauler 一直闲着
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.working = true;
      delete creep.memory.withdrawFrom;
    } else {
      announce(creep, "无货源");
    }
    return;
  }

  const result = isDropped(target) ? creep.pickup(target) : creep.withdraw(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffaa00" } });
  } else {
    delete creep.memory.withdrawFrom;
  }
}

/**
 * 先看认领的目标还算不算数，不算了再挑新的。
 *
 * 顺序不能反：供需表里已经扣掉了自己认领的那份，直接去挑新目标的话，
 * 自己刚认领的目标会因为"已经不缺了"而落选，于是每 tick 换一个目标来回跑。
 */
function resolveDelivery(creep: Creep): AnyStoreStructure | null {
  const remembered = creep.memory.deliverTo
    ? Game.getObjectById(creep.memory.deliverTo as Id<AnyStoreStructure>)
    : null;
  if (remembered && remembered.store.getFreeCapacity(RESOURCE_ENERGY)) return remembered;

  // 排除刚取货的地方，否则从 storage 取了又原样送回去，来回空转
  const candidates = logisticsOf(creep.room).demands.filter(entry => entry.id !== creep.memory.withdrawFrom);
  const chosen = chooseEntry(creep.pos.x, creep.pos.y, candidates);
  if (!chosen) return null;

  creep.memory.deliverTo = chosen.id;
  return Game.getObjectById(chosen.id as Id<AnyStoreStructure>);
}

/**
 * 建筑都填满了，就近喂给缺能量的工人。
 *
 * 满载待命本身不亏，hauler 身上的能量不蒸发，等于一个会走路的仓库。亏的是
 * builder 明明站在旁边，却还要丢下工地跑十几步去矿边取货。
 *
 * 只喂近处的：追着满房间跑，路上耗掉的时间比省下的还多，而且会把 hauler
 * 从 spawn 附近拽走，extension 一空就没人及时补。
 */
function nearbyWorker(creep: Creep): Creep | null {
  return creep.pos.findClosestByRange(FIND_MY_CREEPS, {
    filter: other =>
      FEED_ROLES.includes(other.memory.role) &&
      other.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
      creep.pos.getRangeTo(other) <= FEED_RANGE
  });
}

/**
 * 没有任何需求的时候只捡会消失和会溢出的那些货。
 *
 * 否则 hauler 会把 storage 里的能量搬到自己身上原地站着——库存从仓库
 * 挪到 creep 身上，一点用没有，还占着路。
 */
function availableSupplies(room: Room): LogisticsEntry[] {
  const { supplies, demands } = logisticsOf(room);
  if (demands.length > 0) return supplies;

  return supplies.filter(entry => entry.priority <= SUPPLY_PRIORITY.source);
}
