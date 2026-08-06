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
import { travelTo } from "../movement/move";

export function runRemoteHauler(creep: Creep): void {
  updateState(creep);

  if (creep.memory.working) {
    deliver(creep);
  } else {
    collect(creep);
  }
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

  const target = claimDemand(creep, logisticsOf(home, creep).demands);
  if (!target) {
    announce(creep, "无处卸");
    return;
  }

  const result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, target, { visualizePathStyle: { stroke: "#ffffff" } });
  } else {
    delete creep.memory.deliverTo;
  }
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

  const rooms = [...new Set(activeRemoteSources(home).map(entry => entry.roomName))];
  if (rooms.length === 0) return undefined;

  const current = creep.memory.targetRoom;
  if (current && rooms.includes(current)) return current;

  const crowd: Record<string, number> = {};
  for (const roomName of rooms) crowd[roomName] = 0;

  for (const other of Object.values(Game.creeps)) {
    if (other.memory.role !== "remoteHauler" || other.name === creep.name) continue;

    const assigned = other.memory.targetRoom;
    if (assigned && assigned in crowd) crowd[assigned]++;
  }

  const chosen = rooms.reduce((best, roomName) => (crowd[roomName] < crowd[best] ? roomName : best), rooms[0]);
  creep.memory.targetRoom = chosen;
  return chosen;
}
