/**
 * 工作型角色获取能量的统一入口。
 *
 * 取货顺序交给物流系统的供给表决定，自己挖是最后的退路。这个顺序很重要：
 * 地上的能量、废墟和墓碑都会随时间蒸发，不抢在它们消失前捡走就是白扔；
 * 容器里的能量是矿工现成挖好的，取一趟就满，比自己站着挖几十 tick 快得多。
 */

import { SUPPLY_PRIORITY, claimSupply, feedingSpawn, isDropped, logisticsOf } from "../managers/logistics";
import { announce } from "./logger";
import { travelTo } from "../movement/move";

/**
 * 根据身上的能量在"采集"和"干活"两种状态之间切换。
 * 放在这里是因为每个工作型角色的切换条件都一样：空了去采，满了去用。
 */
export function refreshEnergyState(creep: Creep, workAction: string): void {
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    announce(creep, "采集");
  } else if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    // 认领没兑现就撒手，否则供给表会一直替它占着这份货
    delete creep.memory.withdrawFrom;
    announce(creep, workAction);
  }
}

/**
 * 去拿能量。
 *
 * yieldToSpawn 表示这个角色愿意让位：spawn 或 extension 还缺货时，它既不动矿边容器
 * （那是搬运工唯一的货源），也不去源边自己挖。
 *
 * 让位必须把这两条一起管住，只挡容器是没用的：源的再生速度是固定的 10 能量/tick，
 * 矿工已经把这个量全吃下了，工人站过去自挖只是从矿工嘴里分走同一份能量，
 * 结果照样是矿边容器不进货、extension 填不上，只是换了个地方抢。
 *
 * 停工的代价是有限的：搬运工一趟就能把 spawn 和 extension 填满，缺口通常几十 tick
 * 就没了，之后自动恢复。而 extension 空着的每一 tick，房间都孵不出下一个 creep。
 *
 * harvester 不让位——它只在搬运工断档时才存在，自己挖自己送正是它被造出来的理由。
 */
export function gatherEnergy(creep: Creep, yieldToSpawn = false): void {
  const yielding = yieldToSpawn && feedingSpawn(creep.room);
  const { supplies } = logisticsOf(creep.room);
  const available = yielding ? supplies.filter(entry => entry.priority !== SUPPLY_PRIORITY.source) : supplies;

  const supply = claimSupply(creep, available);

  if (supply) {
    const result = isDropped(supply) ? creep.pickup(supply) : creep.withdraw(supply, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
      travelTo(creep, supply, { visualizePathStyle: { stroke: "#ffaa00" } });
    } else {
      delete creep.memory.withdrawFrom;
    }
    return;
  }

  if (yielding) {
    // 手上还有半桶就先去干活，别拿着货站着等——和搬运工"没货可取就先去送"同一个道理
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.working = true;
      delete creep.memory.withdrawFrom;
      return;
    }

    announce(creep, "让位");
    return;
  }

  // 房间里没有现成的能量可捡，只能自己下矿
  const source = resolveSource(creep);
  if (!source) return;

  if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
    travelTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" } });
  }
}

/**
 * 取出 creep 绑定的能量源，没有或已枯竭就重新分配一个。
 *
 * 绑定而不是每 tick 现找，是因为 findClosestByPath 要跑完整寻路，
 * 是 Screeps 里最常见的 CPU 浪费来源。
 */
function resolveSource(creep: Creep): Source | null {
  if (creep.memory.sourceId) {
    const bound = Game.getObjectById(creep.memory.sourceId);
    if (bound && bound.energy > 0) return bound;
    // 枯竭或失效，解绑后重新分配，否则会把自己算进负载里
    delete creep.memory.sourceId;
  }

  const source = pickLeastCrowdedSource(creep);
  creep.memory.sourceId = source?.id;
  return source;
}

/**
 * 优先挑当前绑定人数最少的能量源，人数相同时挑近的。
 *
 * 如果单纯挑最近的，同一个 spawn 出生的 creep 会全部涌向同一个 source，
 * 另一个 source 整局闲置，等于白白扔掉一半的能量产出。
 */
function pickLeastCrowdedSource(creep: Creep): Source | null {
  const sources = creep.room.find(FIND_SOURCES_ACTIVE);
  if (sources.length === 0) return null;

  const load = countAssignedCreeps(creep.room);

  let best: Source | null = null;
  let bestLoad = Number.POSITIVE_INFINITY;
  let bestRange = Number.POSITIVE_INFINITY;

  for (const source of sources) {
    const sourceLoad = load[source.id] ?? 0;
    const range = creep.pos.getRangeTo(source);

    if (sourceLoad < bestLoad || (sourceLoad === bestLoad && range < bestRange)) {
      best = source;
      bestLoad = sourceLoad;
      bestRange = range;
    }
  }

  return best;
}

/** 统计房间里每个能量源当前绑了多少 creep */
function countAssignedCreeps(room: Room): Record<string, number> {
  const load: Record<string, number> = {};

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.room !== room.name) continue;
    const id = creep.memory.sourceId;
    if (!id) continue;
    load[id] = (load[id] ?? 0) + 1;
  }

  return load;
}
