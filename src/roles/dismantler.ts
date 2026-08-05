/**
 * dismantler：去外矿砸开挡在控制器前面的那段墙。
 *
 * 前人废弃的基地会把控制器所在的凹地封起来，人走了墙还在——中立房间的墙不衰减、
 * 也没人修，就那么永久堵着。预定员到不了控制器那一格，这个房间的源就永远只有
 * 1500 容量，等于白丢一半产出。
 *
 * 这活只干一次。墙掉的血不会长回来，砸通之后预定员自然能进去，拆迁工也就不再孵化。
 * 所以它按需存在：外矿名单里有房间记着 breach 才有配额，砸完配额自己归零。
 *
 * 顺带一提，拆墙会把砸掉血量的四分之一变成能量还给拆迁工——十几万血的墙就是三万
 * 多能量，比预定本身值钱得多。但那要给它配 CARRY，还要有人把货运回去，现在不掺。
 */

import { announce, log } from "../utils/logger";
import { breachTargets, commuteOrFlee } from "../managers/remote";
import { holdPosition } from "../movement/traffic";
import { travelTo } from "../movement/move";
import { wallStillThere } from "../movement/breach";

export function runDismantler(creep: Creep): void {
  const roomName = resolveTarget(creep);
  if (!roomName) {
    // 活干完了。配额已经归零，它只是还没死；留着就是在外矿站着白吃孵化预算，
    // 而这几百 tick 的孵化时间家里正等着用
    if (creep.memory.targetRoom) retire(creep);
    else announce(creep, "无墙可拆");
    return;
  }

  if (commuteOrFlee(creep, roomName)) return;

  const spot = Memory.rooms[roomName]?.breach?.wall;
  if (!spot) return;

  const wall = wallStillThere(roomName, spot);
  if (!wall) {
    // 这一段砸没了。下一段在哪要由复查重新算，它比这里看得全：拆开一段之后
    // 最省的那条路可能整个换了方向
    log.info("外矿", `${roomName} 的 (${spot.x},${spot.y}) 已拆开`);
    delete Memory.rooms[roomName].breach;
    return;
  }

  if (!creep.pos.isNearTo(wall)) {
    travelTo(creep, wall, { visualizePathStyle: { stroke: "#ff8844" } });
    return;
  }

  // 站定：砸墙要贴身，被路过的人挤开一格就白丢一 tick
  holdPosition(creep);
  announce(creep, `拆${Math.ceil(wall.hits / 1000)}k`);
  creep.dismantle(wall);
}

function retire(creep: Creep): void {
  log.info("外矿", `${creep.name} 没有墙要拆了，退役`);
  creep.suicide();
}

/**
 * 认死一个房间。
 *
 * 通勤几十 tick，中途改主意就是白跑；而且这活本来就是一次性的，砸到一半换目标
 * 等于两边都没通。只有原来那个房间不用拆了才重新挑。
 */
function resolveTarget(creep: Creep): string | undefined {
  const home = Game.rooms[creep.memory.room];
  if (!home) return undefined;

  const current = creep.memory.targetRoom;
  if (current && breachTargets(home).includes(current)) return current;

  const free = breachTargets(home)[0];
  if (free) creep.memory.targetRoom = free;

  return free;
}
