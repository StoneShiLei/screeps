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

import { announce, log } from "../utils/logger";
import { commuteTo, travelTo } from "../movement/move";
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

  if (commuteTo(creep, roomName)) {
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
 * 有工地就建，没有就升级控制器。
 *
 * spawn 永远排第一。新房间在 spawn 建成之前是完全不能自理的，其余任何建筑
 * 都得等——一个建好的 extension 在没有 spawn 的房间里毫无意义。
 */
function work(creep: Creep): void {
  const site = pickSite(creep);
  if (site) {
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
      travelTo(creep, site, { range: 3, visualizePathStyle: { stroke: "#ffdd44" } });
    }
    return;
  }

  const controller = creep.room.controller;
  if (!controller) return;

  announce(creep, "升级");
  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    travelTo(creep, controller, { range: 3, visualizePathStyle: { stroke: "#88ff88" } });
  }
}

function pickSite(creep: Creep): ConstructionSite | null {
  const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
  if (sites.length === 0) return null;

  const spawn = sites.find(site => site.structureType === STRUCTURE_SPAWN);
  if (spawn) return spawn;

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
