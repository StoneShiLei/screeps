/**
 * harvester：目前房间里唯一的角色。
 * 在能量源和 spawn / extension 之间往返搬运，两边都满了就临时去升级 controller。
 */

export function runHarvester(creep: Creep): void {
  updateWorkingState(creep);

  if (creep.memory.working) {
    deliverEnergy(creep);
  } else {
    harvestEnergy(creep);
  }
}

/** 空了就去采集，满了就去送货 */
function updateWorkingState(creep: Creep): void {
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    creep.say("采集");
  } else if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    creep.say("运输");
  }
}

function harvestEnergy(creep: Creep): void {
  const source = findSource(creep);
  if (!source) return;

  if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
    creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
  }
}

/**
 * findClosestByPath 每次调用都要跑一遍寻路，是 Screeps 里最常见的 CPU 浪费来源，
 * 所以把结果记在 memory 里，只有能量源枯竭时才重新找。
 */
function findSource(creep: Creep): Source | null {
  if (creep.memory.sourceId) {
    const cached = Game.getObjectById(creep.memory.sourceId);
    if (cached && cached.energy > 0) return cached;
  }

  const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  creep.memory.sourceId = source?.id;
  return source;
}

function deliverEnergy(creep: Creep): void {
  const targets = creep.room.find(FIND_MY_STRUCTURES, {
    filter: (structure): structure is StructureSpawn | StructureExtension =>
      (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) &&
      structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
  });

  const target = creep.pos.findClosestByPath(targets);
  if (target) {
    if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
    }
    return;
  }

  upgradeController(creep);
}

/**
 * 能量无处可放时的兜底，免得 creep 干站着浪费寿命。
 * 等 upgrader 角色拆出来之后这里就可以去掉了。
 */
function upgradeController(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) return;

  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, { visualizePathStyle: { stroke: "#88ff88" } });
  }
}
