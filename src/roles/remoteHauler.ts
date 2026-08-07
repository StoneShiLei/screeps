/**
 * remoteHauler：往邻房跑长途，把矿边容器（或地上）的能量搬回基地。
 *
 * 和家里的 hauler 是两种活。家里那个每交一次货就重新问"现在哪里最缺"，因为
 * 它的行程只有十几格，改主意几乎不要钱；这个单程六七十格，中途换主意的代价
 * 是几十 tick 的空跑，所以它认死一个外矿房间，装满就回家、卸完就再去。
 *
 * 取货走物流表：容器建好之后矿边桶会出现在供给表里，地上的散货优先级更高，
 * 过渡期两种来源都能捡，不必单独写一套外矿取货逻辑。
 */

import { activeRemoteSources, commuteOrFlee } from "../managers/remote";
import { claimDemand, claimSupply, isDropped, logisticsOf } from "../managers/logistics";
import { announce } from "../utils/logger";
import { holdPosition } from "../movement/traffic";
import { commuteTo, travelTo } from "../movement/move";

/**
 * spawn / extension 满了、又没有 storage 时，把能量喂给这些会花能量的角色。
 *
 * remoteHauler 顶多带一个用来修路的 WORK，自己消化不掉一车能量，只能 transfer。
 */
const FEED_ROLES: CreepRole[] = ["builder", "upgrader", "pioneer"];

/** build / repair 的射程，对应游戏常量 BUILD_RANGE(3) */
const BUILD_RANGE = 3;

/** 路掉血到这个比例以下才值得修，和 planner/remoteRoads 同口径 */
const ROAD_REPAIR_THRESHOLD = 0.6;

export function runRemoteHauler(creep: Creep): void {
  updateState(creep);

  if (creep.memory.working) {
    deliver(creep);
  } else {
    collect(creep);
  }

  // 放在最后：move 和 build/repair 是两种意图，同一 tick 都做得了，所以顺路
  // 修路一格速度都不掉。RCL4 起体型里那一个 WORK 就是为这件事配的
  tendRoad(creep);
}

/**
 * 顺路把脚下这条线的路建起来、修回去。
 *
 * 只做够得着的那一格，绝不为它改道：运输队的本职是运，绕一格去补三点进度
 * 是把主业赔进去。反过来，正好路过时那几点进度和几十点血是白捡的——
 * 这条线上一直有人往返，积少成多足够抵消 100 血/1000tick 的衰减。
 */
function tendRoad(creep: Creep): void {
  if (creep.store[RESOURCE_ENERGY] === 0) return;
  if (!creep.body?.some(part => part.type === WORK)) return;

  const site = creep.pos
    .findInRange(FIND_MY_CONSTRUCTION_SITES, BUILD_RANGE)
    .find(candidate => candidate.structureType === STRUCTURE_ROAD);
  if (site) {
    creep.build(site);
    return;
  }

  const worn = creep.pos
    .findInRange(FIND_STRUCTURES, BUILD_RANGE)
    .find(
      (structure): structure is StructureRoad =>
        structure.structureType === STRUCTURE_ROAD && structure.hits < structure.hitsMax * ROAD_REPAIR_THRESHOLD
    );
  if (worn) creep.repair(worn);
}

/**
 * 装满了就回家，卸空了就再出门。
 *
 * 和家里的 hauler 一样，换状态时清掉上一段的认领，否则物流系统会一直替它
 * 占着份额，别人就不去了。
 */
function updateState(creep: Creep): void {
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    delete creep.memory.deliverTo;
    announce(creep, "出门");
  } else if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    delete creep.memory.withdrawFrom;
    announce(creep, "回家");
  }
}

function collect(creep: Creep): void {
  const roomName = resolveRemoteRoom(creep);
  if (!roomName) {
    announce(creep, "无外矿");
    if (creep.room.name !== creep.memory.room) commuteTo(creep, creep.memory.room);
    else holdPosition(creep);
    return;
  }

  if (commuteOrFlee(creep, roomName)) return;

  const target = claimSupply(creep, logisticsOf(creep.room, creep).supplies);
  if (!target) {
    // 空手等下一批比空手回家划算：来回一趟几十 tick，矿工每 tick 都在产出
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.working = true;
      delete creep.memory.withdrawFrom;
    } else {
      announce(creep, "等矿");
    }
    return;
  }

  const result = isDropped(target) ? creep.pickup(target) : creep.withdraw(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffaa00" } });
  } else {
    delete creep.memory.withdrawFrom;
  }
}

function deliver(creep: Creep): void {
  const home = Game.rooms[creep.memory.room];
  if (!home) {
    announce(creep, "无家");
    return;
  }

  // 还在外面就先往家走。物流表是按房内坐标挑最近目标的，隔着房间挑不出名堂
  if (creep.room.name !== home.name) {
    const anchor = home.memory.anchor;
    const gate = anchor ? new RoomPosition(anchor.x, anchor.y, home.name) : home.controller?.pos;
    if (gate) travelTo(creep, gate, { range: 5, visualizePathStyle: { stroke: "#ffffff" } });
    return;
  }

  // 建筑缺口优先；满了就喂本房会烧能量的工人（建造/升级），别满载干站
  const structure = claimDemand(creep, logisticsOf(home, creep).demands);
  const worker = structure ? null : hungryWorker(creep);
  const target = structure ?? worker;
  if (!target) {
    announce(creep, "无处卸");
    holdPosition(creep);
    return;
  }

  if (worker) announce(creep, "投喂");

  const result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffffff" } });
  } else {
    delete creep.memory.deliverTo;
  }
}

/**
 * 找一个还装得下能量的建造/升级/拓荒工。
 *
 * 不限距离：远程运输队已经跑完长途，家门口没洞可卸时追工人比干站划算。
 * 本房 hauler 仍用短距投喂，免得被拽离 spawn。
 */
function hungryWorker(creep: Creep): Creep | null {
  return creep.pos.findClosestByRange(FIND_MY_CREEPS, {
    filter: other =>
      FEED_ROLES.includes(other.memory.role) && other.store.getFreeCapacity(RESOURCE_ENERGY) > 0
  });
}

/**
 * 认领一个外矿房间，人少的优先。
 *
 * 按房间摊人而不是按能量源摊：一个房间里两个源的能量都堆在几格之内，
 * 一趟能顺手捡两边的，硬把运输队绑到某个源上反而让它跑空。
 */
function resolveRemoteRoom(creep: Creep): string | undefined {
  const home = Game.rooms[creep.memory.room];
  if (!home) return undefined;

  // 不挑有没有矿边桶：没桶时矿工的产出掉在地上按 ceil(数量/1000) 每 tick 蒸发，
  // 那正是最该有人去拉的时候。物流表里掉落的优先级本来就高于容器
  const rooms = [...new Set(activeRemoteSources(home).map(entry => entry.roomName))];
  if (rooms.length === 0) {
    delete creep.memory.targetRoom;
    return undefined;
  }

  const crowd: Record<string, number> = {};
  for (const roomName of rooms) crowd[roomName] = 0;

  for (const other of Object.values(Game.creeps)) {
    if (other.memory.role !== "remoteHauler" || other.name === creep.name) continue;

    const assigned = other.memory.targetRoom;
    if (assigned && assigned in crowd) crowd[assigned]++;
  }

  const current = creep.memory.targetRoom;
  // 认死一个房间是对的——中途改主意等于空跑几十格。但只在"差一个人头"以内
  // 才粘住：差到两人以上说明编制严重偏科（常见于新开的外矿），空车时放它改派
  if (current && rooms.includes(current) && !creep.memory.working) {
    const lightest = rooms.reduce((best, roomName) => (crowd[roomName] < crowd[best] ? roomName : best));
    if (crowd[current] - crowd[lightest] < 2) return current;
  } else if (current && rooms.includes(current)) {
    return current;
  }

  const chosen = rooms.reduce((best, roomName) => (crowd[roomName] < crowd[best] ? roomName : best), rooms[0]);
  creep.memory.targetRoom = chosen;
  return chosen;
}
