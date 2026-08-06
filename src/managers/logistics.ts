/**
 * 物流系统：每 tick 现算"谁缺能量"和"谁有能量"两张表，hauler 从里面自己挑活。
 *
 * 任务不落 Memory。落盘的任务队列一旦 creep 半路阵亡就会留下僵尸任务，
 * 还得写一套回收逻辑；现算的代价只是每 tick 扫一遍房间，换来的是永远不会脏。
 *
 * 防止多个 hauler 扑同一个目标靠**扣减在途量**：算某个目标还缺多少时，
 * 把所有已经认领它的 hauler 身上的货先减掉。取货端同理，扣掉正在赶来的空余容量。
 */

import { isPlanned } from "../planner/roomPlanner";
import { isVisualOn } from "../utils/settings";

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
   *
   * 没有这一档的时候它是个死物：不在需求表里，永远没人填，却照样每 100 tick
   * 掉血、照样要人修。
   */
  buffer: 4
};

/** 供给方优先级，数字越小越先取 */
export const SUPPLY_PRIORITY = {
  /** 会随时间蒸发，不捡就没了 */
  dropped: 0,
  /** 墓碑和废墟也会消失 */
  decaying: 0,
  /** 能量源旁的容器，满了矿工就得停工 */
  source: 1,
  /** 基地内的缓冲容器 */
  buffer: 2,
  /** 动用库存是最后的手段 */
  storage: 3
};

/** tower 装到这个比例以上就不再补，免得 hauler 为了几十点能量反复跑 */
const TOWER_REFILL_THRESHOLD = 0.8;

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
 * 这是全房间唯一一条"填不上就什么都干不了"的需求：孵化和补人全指着它，空着的时候
 * 建造和升级快一点慢一点都无所谓。所以它有缺口时，自己不采集的角色要让开矿边容器
 * ——那是搬运工唯一的货源。
 */
export function feedingSpawn(room: Room): boolean {
  return logisticsOf(room).demands.some(entry => entry.priority <= DEMAND_PRIORITY.spawn);
}

/** 这个目标现在还有多少能量能拿 */
export function amountIn(target: LogisticsTarget): number {
  return isDropped(target) ? target.amount : target.store[RESOURCE_ENERGY];
}

/**
 * 从供给表里挑一个目标去取货，并登记认领。
 *
 * 登记这一步不只是给 hauler 用的：任何 creep 认领之后，它的空余容量都会
 * 从供给表里扣掉，别人就不会再扑同一堆能量。房间里躺着几十个废墟时，
 * 没有这层登记的话所有 creep 会一起冲向最近的那个。
 */
export function claimSupply(creep: Creep, supplies: LogisticsEntry[]): LogisticsTarget | null {
  const remembered = creep.memory.withdrawFrom
    ? Game.getObjectById(creep.memory.withdrawFrom as Id<LogisticsTarget>)
    : null;
  if (remembered && amountIn(remembered) > 0) return remembered;

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
 * 和 claimSupply 对称。先看认领过的那个还算不算数，不算了再挑新的——顺序不能反：
 * 需求表里已经扣掉了自己认领的那份，直接挑新目标的话，自己刚认领的目标会因为
 * "已经不缺了"而落选，于是每 tick 换一个目标来回跑。
 */
export function claimDemand(creep: Creep, demands: LogisticsEntry[]): AnyStoreStructure | null {
  const remembered = creep.memory.deliverTo
    ? Game.getObjectById(creep.memory.deliverTo as Id<AnyStoreStructure>)
    : null;
  if (remembered && remembered.store.getFreeCapacity(RESOURCE_ENERGY)) return remembered;

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
 * 直线距离在 bunker 里会骗人。基地内部的 extension 是一条条斜带，中间只留一格
 * 宽的路，两个直线距离 2 格的 extension 常常隔着一整排别的建筑，绕过去要走六七步。
 * 照直线挑，hauler 装填时就会在基地里来回横穿：明明脚边那个没填，却先去了
 * "看起来更近"的对岸。
 *
 * 只在同一档优先级里比路程，跨档不比——优先级表达的是紧迫程度，比距离重要。
 * 寻路只在换目标那一 tick 跑（认领之后会一直记着），所以这笔开销摊得很薄。
 */
function chooseReachable(creep: Creep, entries: LogisticsEntry[]): LogisticsEntry | undefined {
  const fallback = chooseEntry(creep.pos.x, creep.pos.y, entries);
  if (!fallback) return undefined;

  // 表是别的房间的（外派人员在回家路上就会这样），跨房间寻路又贵又没意义
  const sample = Game.getObjectById(fallback.id as Id<LogisticsTarget>);
  if (!sample || sample.room?.name !== creep.room.name) return fallback;

  const group = entries.filter(entry => entry.amount > 0 && entry.priority === fallback.priority);
  if (group.length < 2) return fallback;

  const byCell = new Map(group.map(entry => [`${entry.x},${entry.y}`, entry]));
  const goals = group.map(entry => new RoomPosition(entry.x, entry.y, creep.room.name));

  // range 1 是必须的：extension 那一格本身站不进去，要求走到目标格上会直接判无路。
  // ignoreCreeps 让结果稳定，否则同伴挪一步就换一个目标
  const closest = creep.pos.findClosestByPath(goals, { ignoreCreeps: true, range: 1 });
  if (!closest) return fallback;

  return byCell.get(`${closest.x},${closest.y}`) ?? fallback;
}

/**
 * 挑一个最划算的目标：先看优先级，同优先级里挑最近的（直线）。
 *
 * 不按"缺口大小"排序是有意的。优先级已经表达了紧迫程度，
 * 再掺进缺口大小只会让 hauler 舍近求远去填一个大但不急的坑。
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
 * 把供需状态画在房间里：需求点标红色缺口，供给点标绿色存量，
 * 每个 hauler 和它的目标之间连一条线。
 *
 * 运力够不够、是不是全堵在某一个环节，扫一眼房间就知道，不用翻日志。
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

/** 一个房间一个 tick 只算一次，房间里所有 hauler 共用这份结果 */
const cache: Record<string, CachedLogistics> = {};

export function logisticsOf(room: Room): RoomLogistics {
  const cached = cache[room.name];
  if (cached && cached.tick === Game.time) return cached;

  const reservations = collectReservations(room);
  const result: CachedLogistics = {
    tick: Game.time,
    supplies: deductReservations(collectSupplies(room), reservations.pickups),
    demands: deductReservations(collectDemands(room), reservations.deliveries)
  };

  cache[room.name] = result;
  return result;
}

/**
 * 把已经认领的活折算成在途量。
 *
 * 送货端扣的是 creep 身上的货，取货端扣的是它的空余容量——
 * 它到了就会把那么多货取走，后来者不该再指望这部分。
 *
 * 不限角色：builder 和 upgrader 去捡废墟时也会登记，一起纳入这套避让。
 */
function collectReservations(room: Room): { pickups: Reservation[]; deliveries: Reservation[] } {
  const pickups: Reservation[] = [];
  const deliveries: Reservation[] = [];

  for (const creep of Object.values(Game.creeps)) {
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
 * 这个 creep 的认领算不算在这个房间头上。
 *
 * 只认此刻就站在这个房间里的。在途量的全部意义是"它马上就到，别人不用再来"，
 * 隔着两个房间的认领不满足这个前提，只会把需求表锁死。
 *
 * 这条曾经写成"归属本房间的也算"，代价是隔壁房间里一个 looter 就能让老家的
 * 某个 extension 永远填不上：looter 的 memory.room 是老家，它带着上一趟的
 * deliverTo 去外矿装货，往返一百多 tick 里那个 extension 在需求表里一直显示
 * 已被认领，于是没有任何 hauler 去填它，而认领它的人在另一个房间搬货。
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

  // 容器没有归属，不在 FIND_MY_STRUCTURES 里，得单独遍历
  const miningSpots = Object.values(room.memory.miningSpots ?? {});

  for (const structure of room.find(FIND_STRUCTURES)) {
    if (structure.structureType !== STRUCTURE_CONTAINER) continue;

    const { x, y } = structure.pos;
    if (upgradeSpot && x === upgradeSpot.x && y === upgradeSpot.y) {
      pushIfHungry(demands, structure, DEMAND_PRIORITY.controller);
      continue;
    }

    // 矿边的容器只出不进。往里送就成了死循环：矿工挖满、搬运工搬走、
    // 搬运工又发现它缺货再送回来
    if (miningSpots.some(spot => spot.x === x && spot.y === y)) continue;

    // 只填图纸上的。占领带旧基地的房间时地上会留着前人的容器，往里送货
    // 等于替对方囤粮
    if (!isPlanned(room, STRUCTURE_CONTAINER, x, y)) continue;

    pushIfHungry(demands, structure, DEMAND_PRIORITY.buffer);
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

  for (const structure of room.find(FIND_STRUCTURES)) {
    if (structure.structureType === STRUCTURE_CONTAINER) {
      // 控制器旁的容器是升级工的粮仓，只进不出
      if (upgradeSpot && structure.pos.x === upgradeSpot.x && structure.pos.y === upgradeSpot.y) continue;

      const priority = isMiningSpot(structure.pos.x, structure.pos.y)
        ? SUPPLY_PRIORITY.source
        : SUPPLY_PRIORITY.buffer;
      pushIfStocked(supplies, structure, priority);
    } else if (structure.structureType === STRUCTURE_STORAGE) {
      pushIfStocked(supplies, structure, SUPPLY_PRIORITY.storage);
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

function pushIfStocked(entries: LogisticsEntry[], holder: AnyStoreStructure | Tombstone | Ruin, priority: number): void {
  const available = holder.store[RESOURCE_ENERGY];
  if (available < MIN_PICKUP_AMOUNT) return;

  entries.push({ id: holder.id, x: holder.pos.x, y: holder.pos.y, amount: available, priority });
}
