/**
 * upgrader：专职把能量灌进 controller。
 *
 * 拆出来是因为让 harvester 兼职升级时，它会被"填 spawn"的活反复打断，
 * controller 的升级进度完全取决于 spawn 什么时候恰好填满。
 */

import { gatherEnergy, refreshEnergyState } from "utils/energy";

export function runUpgrader(creep: Creep): void {
  refreshEnergyState(creep, "升级");

  if (creep.memory.working) {
    upgradeController(creep);
  } else {
    gatherEnergy(creep);
  }
}

function upgradeController(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) return;

  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, { visualizePathStyle: { stroke: "#88ff88" } });
  }
}
