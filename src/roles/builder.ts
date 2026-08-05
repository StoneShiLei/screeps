/**
 * builder：把布局模块拍下的工地建起来。
 *
 * 工地建完之后不让它闲着——直接转去升级 controller，
 * 总比站在原地等下一批工地强。
 */

import { gatherEnergy, refreshEnergyState } from "utils/energy";
import { constructionOrder } from "../planner/roomPlanner";
import { travelTo } from "../movement/move";

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
    // 建造够得着 3 格，走到贴身纯属多跑两步
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
      travelTo(creep, site, { range: 3, visualizePathStyle: { stroke: "#ffff55" } });
    }
    return;
  }

  const controller = creep.room.controller;
  if (!controller) return;

  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    travelTo(creep, controller, { range: 3, visualizePathStyle: { stroke: "#88ff88" } });
  }
}

/**
 * 选工地时优先接着上一个继续建，避免一群 builder 在几个工地之间来回横跳，
 * 每个都建一半谁也完不成。
 *
 * 需要重新挑的时候按建造顺序挑，同一档里才比远近。光挑最近的会让能量源旁的
 * 容器一直排在队尾——而那个容器一天不建好，矿工就一天上不了岗。
 */
function findTarget(creep: Creep): ConstructionSite | null {
  const remembered = creep.memory.siteId ? Game.getObjectById(creep.memory.siteId) : null;
  if (remembered) return remembered;

  let best: ConstructionSite | null = null;
  let bestOrder = Infinity;
  let bestRange = Infinity;

  for (const site of creep.room.find(FIND_MY_CONSTRUCTION_SITES)) {
    const order = constructionOrder(site);
    const range = creep.pos.getRangeTo(site);

    if (order > bestOrder) continue;
    if (order === bestOrder && range >= bestRange) continue;

    best = site;
    bestOrder = order;
    bestRange = range;
  }

  creep.memory.siteId = best?.id;
  return best;
}
