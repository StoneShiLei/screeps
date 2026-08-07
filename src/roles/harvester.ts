/**
 * harvester：把能量从 source 搬进 spawn 和 extension。
 *
 * 常态只在搬运工断档时救急（本房自挖自送）。RCL1 外矿也用它：绑 targetRoom /
 * sourceId 后跨房挖、运回本房；spawn/extension 满了就升级，免得堵在身上。
 */

import { commuteOrFlee } from "../managers/remote";
import { commuteTo, travelTo } from "../movement/move";
import { announce } from "../utils/logger";
import { gatherEnergy, refreshEnergyState } from "../utils/energy";

export function runHarvester(creep: Creep): void {
  refreshEnergyState(creep, "运输");

  if (creep.memory.targetRoom && creep.memory.sourceId) {
    runRemoteHarvester(creep);
    return;
  }

  if (creep.memory.working) {
    deliverEnergy(creep);
  } else {
    gatherEnergy(creep);
  }
}

/**
 * 跨房自挖自送：空载去外矿，满载回本房；本房投递口满了就升级。
 */
function runRemoteHarvester(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;
  if (!targetRoom) return;

  if (creep.memory.working) {
    if (creep.room.name !== creep.memory.room) {
      announce(creep, "回送");
      commuteTo(creep, creep.memory.room);
      return;
    }

    deliverEnergy(creep);
    return;
  }

  // 遇袭冷却：空载直接撤，别往雷区里闯
  if (commuteOrFlee(creep, targetRoom)) return;

  const source = Game.getObjectById(creep.memory.sourceId as Id<Source>);
  if (!source) {
    delete creep.memory.sourceId;
    return;
  }

  if (!creep.pos.isNearTo(source)) {
    travelTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" } });
    return;
  }

  announce(creep, "挖");
  creep.harvest(source);
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
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffffff" } });
  }
}

function dumpIntoController(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller?.my) return;

  announce(creep, "升");
  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    travelTo(creep, controller, { range: 3, visualizePathStyle: { stroke: "#88ff88" } });
  }
}
