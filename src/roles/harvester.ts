/**
 * harvester：把能量从 source 搬进 spawn 和 extension。
 *
 * 升级 controller 的活已经交给 upgrader，这里只保留一个兜底：
 * 所有储能建筑都满了的时候顺手升级一下，免得 creep 干站着把寿命耗光。
 */

import { gatherEnergy, refreshEnergyState } from "utils/energy";

export function runHarvester(creep: Creep): void {
  refreshEnergyState(creep, "运输");

  if (creep.memory.working) {
    deliverEnergy(creep);
  } else {
    gatherEnergy(creep);
  }
}

function deliverEnergy(creep: Creep): void {
  const targets = creep.room.find(FIND_MY_STRUCTURES, {
    filter: (structure): structure is StructureSpawn | StructureExtension =>
      (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) &&
      structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
  });

  const target = creep.pos.findClosestByPath(targets);
  if (!target) {
    dumpIntoController(creep);
    return;
  }

  if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
  }
}

function dumpIntoController(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) return;

  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, { visualizePathStyle: { stroke: "#88ff88" } });
  }
}
