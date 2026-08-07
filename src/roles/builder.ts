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
    // 工地什么时候建完都不影响房间存亡，spawn 和 extension 空着却会让补人直接断掉，
    // 所以缺口期间让开矿边容器
    gatherEnergy(creep, true);
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
 * 需要重新挑的时候按建造顺序挑，同一档里才比远近。光挑最近的会打乱
 * extension 优先于矿边容器的顺序。
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
