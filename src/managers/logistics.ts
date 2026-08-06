/**
 * 物流系统：每 tick 现算"谁缺能量"和"谁有能量"两张表，hauler 从里面自己挑活。
 *
 * 任务不落 Memory。落盘的任务队列一旦 creep 半路阵亡就会留下僵尸任务，
 * 还得写一套回收逻辑；现算的代价只是每 tick 扫一遍房间，换来的是永远不会脏。
 *
 * 防止多个 hauler 扑同一个目标靠**扣减在途量**：算某个目标还缺多少时，
 * 把所有已经认领它的 hauler 身上的货先减掉。取货端同理，扣掉正在赶来的空余容量。
 *
 * 认领时要在扣减里把自己排除掉——否则自己的在途量把目标扣到消失，下一 tick
 * 以为目标没了，又去挑一个新的，表现为搬运工在房间里来回换目标晃悠。
 */

import { hasCoreBuildPending, isPlanned } from "../planner/roomPlanner";
import { isVisualOn } from "../utils/settings";
import { needsDowngradeShield } from "../utils/controller";

/** 需求方优先级，数字越小越先送 */
export const DEMAND_PRIORITY = {
  /** 不填就断供，没有比这更急的 */
  spawn: 0,
  extension: 0,
  tower: 1,
  /** 控制器旁的容器，升级工的粮仓 */
  controller: 2,
  /** 兜底，实在没处送才往里塞 */
  storage: 3,
  /**
   * 基地内的缓冲容器，排在最后。
   *
   * 它的用处是让 spawn 旁边随时有一桶现成的能量，补 extension 不用跑到矿边去；
   * 但那是"别处都不缺了"之后才谈得上的奢侈，所以优先级压在 storage 之后。
   */
  buffer: 4
};

/** 供给方优先级，数字越小越先取 */
export const SUPPLY_PRIORITY = {
  /** 会随时间蒸发，不捡就没了 */
  dropped: 0,
  /** 墓碑和废墟也会消失 */
  decaying: 0,
  /**
   * 自有房间里前人留下的 storage / terminal。
   *
   * 不再生、还占着建筑上限，抽干之后正好拆掉腾位置；比矿边容器还急。
   */
  salvage: 1,
  /** 能量源旁的容器，满了矿工就得停工 */
  source: 2,
  /** 基地内的缓冲容器 */
  buffer: 3,
  /** 动用库存是最后的手段 */
  storage: 4
};

/** tower 装到这个比例以上就不再补，免得 hauler 为了几十点能量反复跑 */
const TOWER_REFILL_THRESHOLD = 0.8;

/**
 * 控制器粮仓 / 缓冲桶补到这个量为止。
 *
 * 曾经这里是一对滞回阈值：低于 LOW(500) 才进需求表、高于 LOW 才算供给。结果是
 * 桶稳定卡在 500 上下——搬运工一趟送满就撒手认领，下一趟回来桶已经 542，不再
 * 进需求表；工人那边可取的只有 42 点，低于起送量，于是桶里明明写着五百多，
 * builder 却报"无货源"站着不动。两条线画在同一个数上，中间那段谁都碰不了。
 *
 * 现在只留一条线：低于它就一直挂在需求表里（优先级压在 spawn / tower 之下，
 * 抢不到急件的运力才会去填），桶里的货工人随便取。搬运工不会拿它空转——见
 * hauler 的 availableSupplies，除非有比缓冲桶更急的需求，否则不从桶里往外掏。
 */
const CONTAINER_REFILL_HIGH = 1500;

/** 低于这个量的供给不值得专门跑一趟 */
const MIN_PICKUP_AMOUNT = 50;

/** 供需表里的条目背后可能是建筑，也可能是墓碑、废墟或者地上的一堆能量 */
export type LogisticsTarget = AnyStoreStructure | Resource | Tombstone | Ruin;

export interface LogisticsEntry {
  id: string;
  x: number;
  y: number;
  /** 需求表里是还缺多少，供给表里是还能取多少，都已扣掉在途量 */
  amount: number;
  priority: number;
}

export interface RoomLogistics {
  supplies: LogisticsEntry[];
  demands: LogisticsEntry[];
}

/** 地上的一堆能量要用 pickup 捡，装在建筑或墓碑里的要用 withdraw 取 */
export function isDropped(target: LogisticsTarget): target is Resource {
  return "amount" in target;
}

/**
 * spawn 和 extension 还缺不缺能量。
 *
 * 这是全房间唯一一条"填不上就什么都干不了"的需求：孵化和补人全指着它。
 */
export function feedingSpawn(room: Room): boolean {
  return logisticsOf(room).demands.some(entry => entry.priority <= DEMAND_PRIORITY.spawn);
}

/**
 * 房间里此刻有没有本土搬运工。
 *
 * 只认站在这个房间、角色是 hauler 的。remoteHauler 不算。
 */
export function hasHaulers(room: Room): boolean {
  return Object.values(Game.creeps).some(
    creep => creep.memory.role === "hauler" && creep.room.name === room.name
  );
}

/**
 * 缓冲容器这一档该排多靠前。
 *
 * 有建造任务时提到原控制器粮仓那一档：建造工人就近取货，比跑矿边快；
 * 控制器粮仓在建造期会被关掉（见 collectDemands），所以不会和升级抢。
 * 没建造任务时退回最后一档。
 */
export function bufferDemandPriority(sites: number): number {
  return sites > 0 ? DEMAND_PRIORITY.controller : DEMAND_PRIORITY.buffer;
}

/** 建造优先期间要不要给控制器粮仓补货：只在快掉级时才补 */
function shouldFeedGranary(room: Room, sites: number): boolean {
  if (sites === 0 && !hasCoreBuildPending(room)) return true;
  return needsDowngradeShield(room);
}

/** 这个目标现在还有多少能量能拿 */
export function amountIn(target: LogisticsTarget): number {
  return isDropped(target) ? target.amount : target.store[RESOURCE_ENERGY];
}

/**
 * 从供给表里挑一个目标去取货，并登记认领。
 *
 * 调用方应传入 logisticsOf(room, creep) 的供给——把自己排除在扣减之外，
 * 否则自己的空余容量会把货源扣没，下一 tick 又换目标。
 */
export function claimSupply(creep: Creep, supplies: LogisticsEntry[]): LogisticsTarget | null {
  const remembered = creep.memory.withdrawFrom
    ? Game.getObjectById(creep.memory.withdrawFrom as Id<LogisticsTarget>)
    : null;

  if (remembered && supplyStillOpen(remembered, creep.room) && supplies.some(entry => entry.id === remembered.id)) {
    return remembered;
  }

  const chosen = chooseReachable(creep, supplies);
  if (!chosen) {
    delete creep.memory.withdrawFrom;
    return null;
  }

  creep.memory.withdrawFrom = chosen.id;
  return Game.getObjectById(chosen.id as Id<LogisticsTarget>);
}

/**
 * 从需求表里挑一个目标去送货，并登记认领。
 *
 * 粘住旧目标的条件：
 * 1. 建筑客观上还收得下能量（容器按 HIGH 算，不是按需求表）
 * 2. 表里没有比它更急的档
 *
 * 不要求旧目标还在需求表里——自己的在途量经常正好把它扣没；要求在表里
 * 就会每 tick 换目标。更急的档出现时（比如粮仓途中 spawn 空了）才改道。
 */
export function claimDemand(creep: Creep, demands: LogisticsEntry[]): AnyStoreStructure | null {
  const remembered = creep.memory.deliverTo
    ? Game.getObjectById(creep.memory.deliverTo as Id<AnyStoreStructure>)
    : null;

  if (remembered && demandStillOpen(remembered)) {
    const mine = demandPriorityOf(remembered, creep.room);
    if (mine !== undefined && !demands.some(entry => entry.priority < mine)) {
      return remembered;
    }
  }

  const chosen = chooseReachable(creep, demands);
  if (!chosen) {
    delete creep.memory.deliverTo;
    return null;
  }

  creep.memory.deliverTo = chosen.id;
  return Game.getObjectById(chosen.id as Id<AnyStoreStructure>);
}

/** 某个 creep 对某个目标的认领，用来扣减在途量 */
export interface Reservation {
  targetId: string;
  amount: number;
}

/**
 * 扣掉已被认领的份额。
 *
 * 这是整套物流最容易出错的地方：不扣的话，三个 hauler 会同时冲向同一个
 * 只缺 50 能量的 extension，两个白跑。
 */
export function deductReservations(entries: LogisticsEntry[], reservations: Reservation[]): LogisticsEntry[] {
  const claimed: Record<string, number> = {};
  for (const reservation of reservations) {
    claimed[reservation.targetId] = (claimed[reservation.targetId] ?? 0) + reservation.amount;
  }

  return entries
    .map(entry => ({ ...entry, amount: entry.amount - (claimed[entry.id] ?? 0) }))
    .filter(entry => entry.amount > 0);
}

/**
 * 挑目标，同优先级里按真正要走几步算最近。
 *
 * 直线距离在 bunker 里会骗人。只在同一档优先级里比路程，跨档不比。
 * 寻路只在换目标那一 tick 跑（认领之后会一直记着）。
 */
function chooseReachable(creep: Creep, entries: LogisticsEntry[]): LogisticsEntry | undefined {
  const fallback = chooseEntry(creep.pos.x, creep.pos.y, entries);
  if (!fallback) return undefined;

  const sample = Game.getObjectById(fallback.id as Id<LogisticsTarget>);
  if (!sample || sample.room?.name !== creep.room.name) return fallback;

  const group = entries.filter(entry => entry.amount > 0 && entry.priority === fallback.priority);
  if (group.length < 2) return fallback;

  const byCell = new Map(group.map(entry => [`${entry.x},${entry.y}`, entry]));
  const goals = group.map(entry => new RoomPosition(entry.x, entry.y, creep.room.name));

  // range 1：extension 那一格站不进去。ignoreCreeps 让结果稳定
  const closest = creep.pos.findClosestByPath(goals, { ignoreCreeps: true, range: 1 });
  if (!closest) return fallback;

  return byCell.get(`${closest.x},${closest.y}`) ?? fallback;
}

/**
 * 挑一个最划算的目标：先看优先级，同优先级里挑最近的（直线）。
 */
export function chooseEntry(fromX: number, fromY: number, entries: LogisticsEntry[]): LogisticsEntry | undefined {
  let best: LogisticsEntry | undefined;
  let bestPriority = Infinity;
  let bestRange = Infinity;

  for (const entry of entries) {
    if (entry.amount <= 0) continue;

    const range = Math.max(Math.abs(entry.x - fromX), Math.abs(entry.y - fromY));
    if (entry.priority > bestPriority) continue;
    if (entry.priority === bestPriority && range >= bestRange) continue;

    best = entry;
    bestPriority = entry.priority;
    bestRange = range;
  }

  return best;
}

/**
 * 把供需状态画在房间里。
 */
export function visualizeLogistics(room: Room): void {
  if (!isVisualOn("logistics")) return;

  const { supplies, demands } = logisticsOf(room);
  const visual = room.visual;

  for (const demand of demands) {
    visual.text(`-${demand.amount}`, demand.x, demand.y - 0.5, { font: 0.35, color: "#ff8888" });
  }
  for (const supply of supplies) {
    visual.text(`+${supply.amount}`, supply.x, supply.y - 0.5, { font: 0.35, color: "#88ff88" });
  }

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role !== "hauler" || creep.memory.room !== room.name) continue;

    const delivering = Boolean(creep.memory.deliverTo);
    const targetId = creep.memory.deliverTo ?? creep.memory.withdrawFrom;
    const target = targetId ? Game.getObjectById(targetId as Id<LogisticsTarget>) : null;
    if (!target) continue;

    visual.line(creep.pos, target.pos, {
      color: delivering ? "#ffffff" : "#ffaa00",
      opacity: 0.25,
      lineStyle: "dashed"
    });
  }
}

interface CachedLogistics extends RoomLogistics {
  tick: number;
}

/** 一个房间一个 tick 只算一次；带 ignore 时按 creep 名分开缓存 */
const cache: Record<string, CachedLogistics> = {};

/**
 * 房间供需表。
 *
 * @param ignore 认领时传入自己，扣减在途量时跳过它，避免把自己的目标扣没
 */
export function logisticsOf(room: Room, ignore?: Creep): RoomLogistics {
  const key = ignore ? `${room.name}:${ignore.name}` : room.name;
  const cached = cache[key];
  if (cached && cached.tick === Game.time) return cached;

  const reservations = collectReservations(room, ignore?.name);
  const result: CachedLogistics = {
    tick: Game.time,
    supplies: deductReservations(collectSupplies(room), reservations.pickups),
    demands: deductReservations(collectDemands(room), reservations.deliveries)
  };

  cache[key] = result;
  return result;
}

/**
 * 把已经认领的活折算成在途量。
 *
 * 送货端扣的是 creep 身上的货，取货端扣的是它的空余容量。
 * ignoreName 跳过正在做决定的那个 creep。
 */
function collectReservations(
  room: Room,
  ignoreName?: string
): { pickups: Reservation[]; deliveries: Reservation[] } {
  const pickups: Reservation[] = [];
  const deliveries: Reservation[] = [];

  for (const creep of Object.values(Game.creeps)) {
    if (ignoreName && creep.name === ignoreName) continue;
    if (!concerns(creep, room.name)) continue;

    if (creep.memory.deliverTo) {
      deliveries.push({ targetId: creep.memory.deliverTo, amount: creep.store[RESOURCE_ENERGY] });
    }
    if (creep.memory.withdrawFrom) {
      pickups.push({ targetId: creep.memory.withdrawFrom, amount: creep.store.getFreeCapacity() });
    }
  }

  return { pickups, deliveries };
}

/**
 * 只认此刻就站在这个房间里的。
 *
 * 隔着房间的认领不满足"马上就到"，只会把需求表锁死。
 */
function concerns(creep: Creep, roomName: string): boolean {
  return creep.room.name === roomName;
}

function collectDemands(room: Room): LogisticsEntry[] {
  const demands: LogisticsEntry[] = [];
  const upgradeSpot = room.memory.upgradeSpot;

  for (const structure of room.find(FIND_MY_STRUCTURES)) {
    if (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) {
      pushIfHungry(demands, structure, DEMAND_PRIORITY.spawn);
    } else if (structure.structureType === STRUCTURE_TOWER) {
      const store = structure.store;
      const filled = store[RESOURCE_ENERGY] / store.getCapacity(RESOURCE_ENERGY);
      if (filled < TOWER_REFILL_THRESHOLD) pushIfHungry(demands, structure, DEMAND_PRIORITY.tower);
    } else if (structure.structureType === STRUCTURE_STORAGE) {
      pushIfHungry(demands, structure, DEMAND_PRIORITY.storage);
    }
  }

  const miningSpots = Object.values(room.memory.miningSpots ?? {});
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  const bufferPriority = bufferDemandPriority(sites);

  for (const structure of room.find(FIND_STRUCTURES)) {
    if (structure.structureType !== STRUCTURE_CONTAINER) continue;

    const { x, y } = structure.pos;
    if (upgradeSpot && x === upgradeSpot.x && y === upgradeSpot.y) {
      // 建造优先：别把能量灌进升级工的嘴，除非快掉级了
      if (shouldFeedGranary(room, sites)) {
        pushContainerDemand(demands, structure, DEMAND_PRIORITY.controller);
      }
      continue;
    }

    if (miningSpots.some(spot => spot.x === x && spot.y === y)) continue;
    if (!isPlanned(room, STRUCTURE_CONTAINER, x, y)) continue;

    pushContainerDemand(demands, structure, bufferPriority);
  }

  return demands;
}

function collectSupplies(room: Room): LogisticsEntry[] {
  const supplies: LogisticsEntry[] = [];
  const miningSpots = Object.values(room.memory.miningSpots ?? {});
  const isMiningSpot = (x: number, y: number) => miningSpots.some(spot => spot.x === x && spot.y === y);
  const upgradeSpot = room.memory.upgradeSpot;

  for (const resource of room.find(FIND_DROPPED_RESOURCES)) {
    if (resource.resourceType !== RESOURCE_ENERGY || resource.amount < MIN_PICKUP_AMOUNT) continue;
    supplies.push({
      id: resource.id,
      x: resource.pos.x,
      y: resource.pos.y,
      amount: resource.amount,
      priority: SUPPLY_PRIORITY.dropped
    });
  }

  for (const tombstone of room.find(FIND_TOMBSTONES)) {
    pushIfStocked(supplies, tombstone, SUPPLY_PRIORITY.decaying);
  }
  for (const ruin of room.find(FIND_RUINS)) {
    pushIfStocked(supplies, ruin, SUPPLY_PRIORITY.decaying);
  }

  const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  // 建造期不往粮仓灌（shouldFeedGranary=false），升级工也停手——那桶里剩的货
  // 再不开放供给就会一直锁着（e28s36 的 518 就是这么卡死的）。开放成缓冲档，
  // 给 builder / 搬运工抽空去造；恢复喂粮仓之后仍是升级工私产，谁都别掏。
  const drainGranary = Boolean(upgradeSpot) && !shouldFeedGranary(room, sites);

  for (const structure of room.find(FIND_STRUCTURES)) {
    if (structure.structureType === STRUCTURE_CONTAINER) {
      if (upgradeSpot && structure.pos.x === upgradeSpot.x && structure.pos.y === upgradeSpot.y) {
        if (drainGranary) pushIfStocked(supplies, structure, SUPPLY_PRIORITY.buffer);
        continue;
      }

      if (isMiningSpot(structure.pos.x, structure.pos.y)) {
        pushIfStocked(supplies, structure, SUPPLY_PRIORITY.source);
      } else {
        // 桶里的货全都能拿：它就是给工人现取现用的，留底反而把工人饿住
        pushIfStocked(supplies, structure, SUPPLY_PRIORITY.buffer);
      }
    } else if (structure.structureType === STRUCTURE_STORAGE || structure.structureType === STRUCTURE_TERMINAL) {
      if (!room.controller?.my) continue;
      if (!("my" in structure)) continue;

      if (structure.my) {
        if (structure.structureType === STRUCTURE_STORAGE) {
          pushIfStocked(supplies, structure, SUPPLY_PRIORITY.storage);
        }
      } else {
        pushIfStocked(supplies, structure, SUPPLY_PRIORITY.salvage);
      }
    }
  }

  return supplies;
}

function pushIfHungry(
  entries: LogisticsEntry[],
  structure: AnyStoreStructure | StructureContainer,
  priority: number
): void {
  const missing = structure.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;
  if (missing <= 0) return;

  entries.push({ id: structure.id, x: structure.pos.x, y: structure.pos.y, amount: missing, priority });
}

/** 没装满 HIGH 就一直挂着，缺口按补到 HIGH 算 */
function pushContainerDemand(entries: LogisticsEntry[], structure: StructureContainer, priority: number): void {
  const energy = structure.store[RESOURCE_ENERGY];
  const missing = Math.min(CONTAINER_REFILL_HIGH - energy, structure.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0);
  if (missing <= 0) return;

  entries.push({ id: structure.id, x: structure.pos.x, y: structure.pos.y, amount: missing, priority });
}

function pushIfStocked(entries: LogisticsEntry[], holder: AnyStoreStructure | Tombstone | Ruin, priority: number): void {
  const available = holder.store[RESOURCE_ENERGY];
  if (available < MIN_PICKUP_AMOUNT) return;

  entries.push({ id: holder.id, x: holder.pos.x, y: holder.pos.y, amount: available, priority });
}

/**
 * 已经认领的送货目标还收不收得下。
 *
 * 容器按 HIGH 判断：没到 HIGH 仍算开口，上路之后允许一直补满，
 * 否则送到一半就撒手，下一趟又得重跑。
 */
function demandStillOpen(structure: AnyStoreStructure): boolean {
  if (structure.structureType === STRUCTURE_CONTAINER) {
    return structure.store[RESOURCE_ENERGY] < CONTAINER_REFILL_HIGH;
  }

  if (structure.structureType === STRUCTURE_TOWER) {
    const cap = structure.store.getCapacity(RESOURCE_ENERGY);
    if (!cap) return false;
    return structure.store[RESOURCE_ENERGY] / cap < TOWER_REFILL_THRESHOLD;
  }

  return (structure.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0;
}

/** 这个建筑在需求表里该是哪一档；不是我们该送的就返回 undefined */
function demandPriorityOf(structure: AnyStoreStructure, room: Room): number | undefined {
  if (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) {
    return DEMAND_PRIORITY.spawn;
  }
  if (structure.structureType === STRUCTURE_TOWER) return DEMAND_PRIORITY.tower;
  if (structure.structureType === STRUCTURE_STORAGE) return DEMAND_PRIORITY.storage;

  if (structure.structureType === STRUCTURE_CONTAINER) {
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
    const spot = room.memory.upgradeSpot;
    if (spot && structure.pos.x === spot.x && structure.pos.y === spot.y) {
      // 和 collectDemands 同一道闸：建造期不认控制器粮仓，免得粘着旧认领继续灌
      return shouldFeedGranary(room, sites) ? DEMAND_PRIORITY.controller : undefined;
    }

    const mining = Object.values(room.memory.miningSpots ?? {});
    if (mining.some(s => s.x === structure.pos.x && s.y === structure.pos.y)) return undefined;
    if (!isPlanned(room, STRUCTURE_CONTAINER, structure.pos.x, structure.pos.y)) return undefined;

    return bufferDemandPriority(sites);
  }

  return undefined;
}

/** 已经认领的取货目标还有没有货 */
function supplyStillOpen(target: LogisticsTarget, room: Room): boolean {
  if (isDropped(target)) return target.amount >= MIN_PICKUP_AMOUNT;

  if (isStoreContainer(target)) {
    const spot = room.memory.upgradeSpot;
    if (spot && target.pos.x === spot.x && target.pos.y === spot.y) {
      // 喂粮仓期间是升级工私产；建造期抽空时才允许继续认领
      const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
      if (shouldFeedGranary(room, sites)) return false;
    }
  }

  return target.store[RESOURCE_ENERGY] >= MIN_PICKUP_AMOUNT;
}

function isStoreContainer(target: LogisticsTarget): target is StructureContainer {
  // 字面量：STRUCTURE_* 在测试加载阶段可能还是 any
  return "structureType" in target && target.structureType === "container";
}
