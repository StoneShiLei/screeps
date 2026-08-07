/**
 * hauler：只搬不挖，活儿从物流系统现领。
 *
 * 和 builder、upgrader 那种"认准一件事干到底"的角色不同，hauler 每次
 * 交完货就重新问一遍"现在哪里最缺"，所以房间里的能量流向能随时调整——
 * 造兵的时候优先喂 spawn，被打的时候优先喂 tower，不用改一行代码。
 */

import {
  DEMAND_PRIORITY,
  LogisticsEntry,
  SUPPLY_PRIORITY,
  claimDemand,
  claimSupply,
  isDropped,
  logisticsOf
} from "../managers/logistics";
import { announce } from "../utils/logger";
import { holdPosition } from "../movement/traffic";
import { travelTo } from "../movement/move";

/**
 * 闲下来的运力优先喂这些角色。
 *
 * pioneer 也在内：老家派去扶持分房的拓荒者，人就站在分房里、是 my creep，分房
 * 自己的搬运工却不认它，于是它只能自己跑去挖矿捡货，一半时间耗在找饭上——扶持
 * 的意义正是让它专心建 spawn/extension 和升级，把能量喂到嘴边才划算。它在外矿
 * 铺路时那边没有搬运工，照旧自给，不受影响。
 */
const FEED_ROLES: CreepRole[] = ["builder", "upgrader", "pioneer"];

/**
 * 超过这个距离就不值得专门跑一趟去喂。
 *
 * 只在建筑需求都清掉之后才走投喂。绝不能反过来让投喂压过 extension。
 */
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
 *
 * 上一趟卸完、身上还有货但没装满时：若房间里仍有可取的货，先补满再接下单。
 * 否则半载跑去填下一个 extension，等于把空着的 CARRY 白运一趟。
 * 正在认领的送货单不打断（deliverTo 还在就继续送）。
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
  } else if (
    creep.memory.working &&
    !creep.memory.deliverTo &&
    creep.store[RESOURCE_ENERGY] > 0 &&
    creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
    availableSupplies(creep).length > 0
  ) {
    creep.memory.working = false;
    announce(creep, "补货");
  }
}

function deliver(creep: Creep): void {
  const target = resolveDelivery(creep) ?? nearbyWorker(creep);
  if (!target) {
    // 钉住：没意图的 creep 会被交通层推来推去，看起来像来回晃
    announce(creep, "待命");
    holdPosition(creep);
    return;
  }

  const result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffffff" } });
  } else {
    // 送完或目标满了：清掉认领，下一 tick 重新挑（可能同目标继续补）
    delete creep.memory.deliverTo;
  }
}

function pickUp(creep: Creep): void {
  const target = claimSupply(creep, availableSupplies(creep));

  if (!target) {
    // 没货可取但身上有存货时改去送货，免得半满的 hauler 一直闲着
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.working = true;
      delete creep.memory.withdrawFrom;
    } else {
      announce(creep, "无货源");
      holdPosition(creep);
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
 * 挑送货目标。
 *
 * logisticsOf 传入自己：扣减在途量时跳过本 creep，否则自己的货会把目标
 * 从需求表里扣没，claimDemand 每 tick 换一个新目标。
 */
function resolveDelivery(creep: Creep): AnyStoreStructure | null {
  const { demands } = logisticsOf(creep.room, creep);
  const candidates = demands.filter(entry => entry.id !== creep.memory.withdrawFrom);
  return claimDemand(creep, candidates);
}

/**
 * 建筑都填够了，就近喂给缺能量的工人。
 *
 * 只喂近处的：追着满房间跑会把 hauler 从 spawn 附近拽走。
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
 * 否则 hauler 会把 storage 里的能量搬到自己身上原地站着。
 */
function availableSupplies(creep: Creep): LogisticsEntry[] {
  const { supplies, demands } = logisticsOf(creep.room, creep);
  return filterHaulerSupplies(supplies, demands);
}

/**
 * 搬运工这一趟能碰哪些货源。
 *
 * - 缓冲桶：只有 spawn / extension / tower 急缺时才掏，别为了灌 storage 把工人近粮端走
 * - storage：只有 spawn / tower / 粮仓急缺时才动库存；只剩囤仓时禁止取，防仓内自转
 * - 完全没需求：只捡掉落和矿边，别掏家底
 */
export function filterHaulerSupplies(supplies: LogisticsEntry[], demands: LogisticsEntry[]): LogisticsEntry[] {
  const spawnOrTower = demands.some(entry => entry.priority <= DEMAND_PRIORITY.tower);
  let usable = spawnOrTower ? supplies : supplies.filter(entry => entry.priority !== SUPPLY_PRIORITY.buffer);

  const needsStock = demands.some(entry => entry.priority < DEMAND_PRIORITY.storage);
  if (!needsStock) {
    usable = usable.filter(entry => entry.priority !== SUPPLY_PRIORITY.storage);
  }

  if (demands.length > 0) return usable;

  return usable.filter(entry => entry.priority <= SUPPLY_PRIORITY.source);
}
