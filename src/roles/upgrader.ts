/**
 * upgrader：专职把能量灌进 controller。
 *
 * 拆出来是因为让 harvester 兼职升级时，它会被"填 spawn"的活反复打断，
 * controller 的升级进度完全取决于 spawn 什么时候恰好填满。
 *
 * 控制器旁边的容器建好之后就改成静态升级：每人认领一个站位钉住，
 * 每 tick 先从脚边的容器取一点再全部灌进控制器，来回跑的那段路彻底省掉。
 */

import { gatherEnergy, refreshEnergyState } from "utils/energy";
import { containerAt } from "../utils/structures";
import { holdPosition } from "../movement/traffic";
import { travelTo } from "../movement/move";

/**
 * 容器连续空这么多 tick 才放弃站位出门自己找。
 *
 * 数量级来自搬运工的往返周期：从矿边到控制器一个来回大致就是这么久，
 * 短暂断货是正常波动，为此跑一趟矿区，回来的路上容器早又满了，两头耽误。
 * 但要是物流真断了（搬运工全死、矿工停工），死等就是白白耗掉一条命，
 * 所以得留这个出口。
 */
const IDLE_TOLERANCE = 20;

export function runUpgrader(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) return;

  const spot = creep.room.memory.upgradeSpot;
  const container = spot ? containerAt(creep.room, spot.x, spot.y) : undefined;

  if (container && !hasGivenUp(creep, container)) {
    upgradeFromContainer(creep, controller, container);
    return;
  }

  // 容器还没建好，或者空太久了，只能自己跑腿
  releaseStation(creep);
  refreshEnergyState(creep, "升级");

  if (creep.memory.working) {
    moveAndUpgrade(creep, controller);
  } else {
    // 和 builder 同一条让位规则：控制器有两万 tick 的降级余量，extension 一空
    // 房间当场就孵不出人
    gatherEnergy(creep, true);
  }
}

/**
 * 容器空了多久，久到该出门了没有。
 *
 * 只要还能拿到能量就把计数清零，所以"断断续续有货"不会累积成放弃。
 */
function hasGivenUp(creep: Creep, container: StructureContainer): boolean {
  const hasEnergy = container.store[RESOURCE_ENERGY] > 0 || creep.store[RESOURCE_ENERGY] > 0;

  if (hasEnergy) {
    delete creep.memory.idleTicks;
    return false;
  }

  creep.memory.idleTicks = (creep.memory.idleTicks ?? 0) + 1;
  return creep.memory.idleTicks > IDLE_TOLERANCE;
}

/**
 * 站到自己的站位上升级。
 *
 * 站位在规划时就限制在容器 1 格以内，而容器离控制器不超过 2 格，所以站位
 * 一定同时够得着两边——取能量和升级是两种不同的 intent，同一 tick 可以都发出，
 * 站定之后再也不用挪窝。
 */
function upgradeFromContainer(creep: Creep, controller: StructureController, container: StructureContainer): void {
  // 上一轮跑腿时认领的货得撒手。物流系统按认领扣在途量，而静态升级根本不会去取那份
  // 货——留着就等于永久替它占位：矿边容器里只剩一百来点时，这一扣足以让整条供给从
  // 供给表里消失，搬运工于是报"无货源"，站在有货的容器旁边不动
  delete creep.memory.withdrawFrom;

  const station = claimStation(creep);

  if (station && (creep.pos.x !== station.x || creep.pos.y !== station.y)) {
    const target = creep.room.getPositionAt(station.x, station.y);
    if (target) {
      travelTo(creep, target, { range: 0, visualizePathStyle: { stroke: "#88ff88" } });
      // 路上只要够得着就先升着，别浪费这几 tick
      creep.upgradeController(controller);
      return;
    }
  }

  // 没有规划站位时退化成贴着容器站，至少别站到射程外去
  if (!station && creep.pos.getRangeTo(container) > 1) {
    travelTo(creep, container, { range: 1, visualizePathStyle: { stroke: "#88ff88" } });
    return;
  }

  holdPosition(creep);

  // 只在快见底时才伸手取，省下的 intent 就是省下的 CPU
  const perTick = creep.getActiveBodyparts(WORK);
  if (creep.store[RESOURCE_ENERGY] < perTick) {
    creep.withdraw(container, RESOURCE_ENERGY);
  }

  creep.upgradeController(controller);
}

/**
 * 认领一个没人占的站位，认下就不换。
 *
 * 不分配的话几个升级工会一起挤向离自己最近的那一格，互相别着走不动，
 * 到头来谁都得绕远路。认领之后各站各的，路径一次算完就再不变。
 */
function claimStation(creep: Creep): { x: number; y: number } | undefined {
  const stations = creep.room.memory.upgradeStations ?? [];
  if (stations.length === 0) return undefined;

  const mine = creep.memory.station;
  if (mine && stations.some(station => station.x === mine.x && station.y === mine.y)) return mine;

  const taken = new Set<string>();
  for (const other of Object.values(Game.creeps)) {
    if (other.name === creep.name || other.memory.role !== "upgrader") continue;
    if (other.memory.station) taken.add(`${other.memory.station.x},${other.memory.station.y}`);
  }

  const free = stations.find(station => !taken.has(`${station.x},${station.y}`));
  creep.memory.station = free;
  return free;
}

function releaseStation(creep: Creep): void {
  delete creep.memory.station;
}

function moveAndUpgrade(creep: Creep, controller: StructureController): void {
  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    travelTo(creep, controller, { range: 3, visualizePathStyle: { stroke: "#88ff88" } });
  }
}
