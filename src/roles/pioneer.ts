/**
 * 拓荒者：在新占的房间里就地挖、就地建，把第一个 spawn 立起来。
 *
 * 它是老家往分房投的唯一一笔实物投入。之后新房间就靠自己那个 spawn 造人了，
 * 所以这批人干的活很具体：先把 15000 能量的 spawn 啃完，再顺手铺开 extension
 * 和容器，直到新房间自己的矿工和搬运工接上班。
 *
 * 为什么不从老家运能量过来：15000 能量要运输队跑几十趟，隔着两个房间，一趟
 * 往返两百 tick，路上的时间成本比就地挖高出好几倍。而这个房间本来就有两个源，
 * 带上 WORK 自己挖才是最短的路。
 *
 * 没有工地的时候升级控制器，不闲着。这不只是找活干：新占的房间是 RCL1，
 * 降级倒计时只有 20000 tick，而 RCL2 能解锁 5 个 extension，直接决定下一批
 * 本地 creep 的体型。
 */

import { DEMAND_PRIORITY, claimDemand, logisticsOf } from "../managers/logistics";
import { announce, log } from "../utils/logger";
import { commuteTo, travelTo } from "../movement/move";
import { wornContainer, wornRoad } from "../planner/remoteRoads";
import { commuteOrFlee } from "../managers/remote";
import { containerAt } from "../utils/structures";
import { demolitionTarget } from "../managers/demolish";
import { energyPiles } from "../managers/loot";
import { refreshEnergyState } from "../utils/energy";

export function runPioneer(creep: Creep): void {
  const roomName = creep.memory.targetRoom;
  if (!roomName) {
    // 分房取消了。它是个正常的 WORK CARRY MOVE，回老家还能当 builder 使，
    // 就地把剩下的寿命用在老家的工地上
    fallBackHome(creep);
    return;
  }

  // 去外矿铺路时要跟着外矿的撤退规则走：那边没有塔，遇袭冷却期站在那儿就是白送。
  // 自己的分房不适用——那是我们的地盘，拆迁和建造都得继续
  const ours = Game.rooms[roomName]?.controller?.my === true;
  if (ours ? commuteTo(creep, roomName) : commuteOrFlee(creep, roomName)) {
    announce(creep, "拓荒");
    return;
  }

  refreshEnergyState(creep, "建造");

  if (creep.memory.working) {
    work(creep);
  } else {
    harvest(creep);
  }
}

/**
 * 先给 spawn 和 extension 补能量，再建造，没有工地就升级控制器。
 *
 * 新房间刚立起 spawn 时最容易卡死：spawn 里只有几十点能量，每 tick 自恢复 1 点，
 * 爬到 300 才能孵第一个人——而八格外往往就躺着前人的 terminal。拓荒者带 CARRY，
 * 取货逻辑本来就会从那些仓库拿，送出去却没人写，等于捧着货站在空 spawn 旁边盖
 * 容器。补孵化能量永远比多盖一栋 extension 急。
 */
function work(creep: Creep): void {
  if (creep.room.controller?.my && feedSpawn(creep)) return;

  const site = pickSite(creep);
  if (site) {
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
      travelTo(creep, site, { range: 3, visualizePathStyle: { stroke: "#ffdd44" } });
    }
    return;
  }

  // 工地清空后转去补磨损。新分房还没有塔，容器和路只能靠人修；容器优先，
  // 矿工站在上面，塌了能量就重新洒一地
  const worn = wornContainer(creep.room) ?? wornRoad(creep.room);
  if (worn) {
    announce(creep, worn.structureType === STRUCTURE_CONTAINER ? "补桶" : "补路");
    if (creep.repair(worn) === ERR_NOT_IN_RANGE) {
      travelTo(creep, worn, { visualizePathStyle: { stroke: "#ffdd44" } });
    }
    return;
  }

  const controller = creep.room.controller;
  // 不是自己的房间就没升级可做。曾经外矿路队会停在这里"待命"等下一趟磨损，
  // 现在外矿基建不归拓荒者了——目标房间没活干就清掉，回去当 builder 把
  // 剩下的寿命花掉，别站在人家房里空转
  if (!controller?.my) {
    delete creep.memory.targetRoom;
    fallBackHome(creep);
    return;
  }

  announce(creep, "升级");
  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    travelTo(creep, controller, { range: 3, visualizePathStyle: { stroke: "#88ff88" } });
  }
}

/** 把能量送进 spawn / extension。有缺口就返回 true，调用方别再干别的 */
function feedSpawn(creep: Creep): boolean {
  const hungry = logisticsOf(creep.room, creep).demands.filter(entry => entry.priority <= DEMAND_PRIORITY.spawn);
  const target = claimDemand(creep, hungry);
  if (!target) return false;

  announce(creep, "填孵");
  if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffffff" } });
  } else {
    delete creep.memory.deliverTo;
  }

  return true;
}

function pickSite(creep: Creep): ConstructionSite | null {
  const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
  if (sites.length === 0) return null;

  const spawn = sites.find(site => site.structureType === STRUCTURE_SPAWN);
  if (spawn) return spawn;

  // 矿边容器比路面优先：一建好矿工的产出就进桶，运输队不用在地上扫
  const container = sites.find(site => site.structureType === STRUCTURE_CONTAINER);
  if (container) return container;

  return creep.pos.findClosestByPath(sites);
}

function hasSite(room: Room): boolean {
  return room.find(FIND_MY_CONSTRUCTION_SITES).length > 0;
}

function demolish(creep: Creep, junk: Structure): void {
  announce(creep, `拆${Math.ceil(junk.hits / 1000)}k`);

  if (creep.dismantle(junk) === ERR_NOT_IN_RANGE) {
    travelTo(creep, junk, { visualizePathStyle: { stroke: "#ff8844" } });
  }
}

/**
 * 找能量，自己挖是最后的选择。
 *
 * 顺序是按"这一趟要花几 tick"排的：地上的废墟墓碑会蒸发，不捡就没了；前人留下的
 * terminal 和 storage 取一次就满仓，而同样的量自己挖要上百 tick——新占的房间里
 * 常常正好有这种存货，那 15000 能量的 spawn 就该拿它来建，而不是让四个人蹲在
 * 矿边啃一千 tick。规则也允许：withdraw 对敌方建筑有效，只要上面没有 rampart。
 */
function harvest(creep: Creep): void {
  // 没有工地要建的时候，拆前人的房子比去挖矿划算得多，而且两件好事一起做：
  // 清掉占着建筑上限的旧房子（那往往正是"没有工地"的原因），同时从拆下来的
  // 建造费里回收能量。空着手来拆才收得到这笔返还，装满了拆就洒在地上了。
  if (!hasSite(creep.room)) {
    const junk = demolitionTarget(creep.room);
    if (junk) {
      demolish(creep, junk);
      return;
    }
  }

  const loot = pickLoot(creep);
  if (loot) {
    const result = loot instanceof Resource ? creep.pickup(loot) : creep.withdraw(loot, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) travelTo(creep, loot, { visualizePathStyle: { stroke: "#ffaa00" } });
    return;
  }

  // 外矿基建时矿边容器是现成的能量桶——修路/建路的材料直接从这里取，
  // 不必跟运输队抢地上那一堆，也不必自己去挖
  const mining = miningEnergy(creep.room);
  if (mining) {
    announce(creep, "取桶");
    if (creep.withdraw(mining, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      travelTo(creep, mining, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
    return;
  }

  const stash = energyPiles(creep.room)[0];
  if (stash) {
    announce(creep, "取货");
    if (creep.withdraw(stash, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      travelTo(creep, stash, { visualizePathStyle: { stroke: "#ffdd44" } });
    }
    return;
  }

  const source = resolveSource(creep);
  if (!source) {
    announce(creep, "没矿");
    return;
  }

  if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
    travelTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" } });
  }
}

type Loot = Resource | Ruin | Tombstone;

function miningEnergy(room: Room): StructureContainer | undefined {
  for (const spot of Object.values(room.memory.miningSpots ?? {})) {
    const container = containerAt(room, spot.x, spot.y);
    if (container && container.store[RESOURCE_ENERGY] > 0) return container;
  }
  return undefined;
}

function pickLoot(creep: Creep): Loot | null {
  const dropped = creep.room
    .find(FIND_DROPPED_RESOURCES)
    .filter(resource => resource.resourceType === RESOURCE_ENERGY && resource.amount >= 50);
  const ruins = creep.room.find(FIND_RUINS).filter(ruin => ruin.store[RESOURCE_ENERGY] > 0);
  const tombs = creep.room.find(FIND_TOMBSTONES).filter(tomb => tomb.store[RESOURCE_ENERGY] > 0);

  return creep.pos.findClosestByPath([...dropped, ...ruins, ...tombs]);
}

/**
 * 绑定一个源，人少的那个优先。
 *
 * 不用房间里通用的那套分配逻辑：那边是按 memory.room 归组的，而拓荒者的
 * memory.room 是老家，在这个房间里会被算成外人，几个人于是全挤到同一个源上。
 */
function resolveSource(creep: Creep): Source | null {
  const bound = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
  if (bound && bound.energy > 0) return bound;

  const sources = creep.room.find(FIND_SOURCES, { filter: source => source.energy > 0 });
  if (sources.length === 0) return null;

  const crowd: Record<string, number> = {};
  for (const other of Object.values(Game.creeps)) {
    if (other.name === creep.name || other.memory.role !== "pioneer") continue;
    if (other.memory.sourceId) crowd[other.memory.sourceId] = (crowd[other.memory.sourceId] ?? 0) + 1;
  }

  const pick = sources.reduce((best, source) => ((crowd[source.id] ?? 0) < (crowd[best.id] ?? 0) ? source : best));
  creep.memory.sourceId = pick.id;
  return pick;
}

/**
 * 目标没了就回老家当 builder 用完剩下的寿命。
 *
 * 自杀太浪费：它身上带着 WORK CARRY MOVE，正是老家工地要的配置，
 * 而孵化费已经付过了。
 */
function fallBackHome(creep: Creep): void {
  if (commuteTo(creep, creep.memory.room)) {
    announce(creep, "回家");
    return;
  }

  if (creep.memory.role === "pioneer") {
    log.info("分房", `${creep.name} 没有分房要拓了，转做 builder`);
    creep.memory.role = "builder";
  }
}
