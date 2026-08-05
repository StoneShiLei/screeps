/**
 * builder：把布局模块拍下的工地建起来。
 *
 * 工地建完之后不让它闲着——直接转去升级 controller，
 * 总比站在原地等下一批工地强。
 */

import { gatherEnergy, refreshEnergyState } from "utils/energy";

export function runBuilder(creep: Creep): void {
  refreshEnergyState(creep, "建造");

  if (creep.memory.working) {
    buildOrFallBack(creep);
  } else {
    gatherEnergy(creep);
  }
}

function buildOrFallBack(creep: Creep): void {
  const site = findTarget(creep);

  if (site) {
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
      creep.moveTo(site, { visualizePathStyle: { stroke: "#ffff55" } });
    }
    return;
  }

  const controller = creep.room.controller;
  if (!controller) return;

  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, { visualizePathStyle: { stroke: "#88ff88" } });
  }
}

/**
 * 选工地时优先接着上一个继续建，避免一群 builder 在几个工地之间来回横跳，
 * 每个都建一半谁也完不成。目标没了才重新挑一个最近的。
 */
function findTarget(creep: Creep): ConstructionSite | null {
  const remembered = creep.memory.siteId ? Game.getObjectById(creep.memory.siteId) : null;
  if (remembered) return remembered;

  const site = creep.pos.findClosestByPath(FIND_MY_CONSTRUCTION_SITES);
  creep.memory.siteId = site?.id;
  return site;
}
