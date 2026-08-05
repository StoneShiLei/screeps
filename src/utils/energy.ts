/**
 * 工作型角色获取能量的统一入口。
 *
 * 取货顺序交给物流系统的供给表决定，自己挖是最后的退路。这个顺序很重要：
 * 地上的能量、废墟和墓碑都会随时间蒸发，不抢在它们消失前捡走就是白扔；
 * 容器里的能量是矿工现成挖好的，取一趟就满，比自己站着挖几十 tick 快得多。
 */

import { claimSupply, isDropped, logisticsOf } from "../managers/logistics";
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

export function gatherEnergy(creep: Creep): void {
  const supply = claimSupply(creep, logisticsOf(creep.room).supplies);

  if (supply) {
    const result = isDropped(supply) ? creep.pickup(supply) : creep.withdraw(supply, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
      travelTo(creep, supply, { visualizePathStyle: { stroke: "#ffaa00" } });
    } else {
      delete creep.memory.withdrawFrom;
    }
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
