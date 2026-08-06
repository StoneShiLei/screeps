/**
 * reserver：站在外矿的控制器旁边按住它，把源的容量从 1500 抬回 3000。
 *
 * 这是外矿唯一一个"什么都不产出却回本最快"的角色。中立房间的源只有 1500 容量、
 * 300 tick 再生，也就是 5 能量/tick；预定之后恢复到 3000，产能整整翻倍。一个源
 * 白得 5 能量/tick，而预定员摊到寿命上才 1.1——单源房间也划得来，双源等于白捡。
 *
 * 带 CLAIM 的 creep 寿命只有 600 tick，不到普通 creep 的一半，而且没法用 spawn
 * 续命，所以它注定是个反复重造的消耗品。这笔账已经算进上面那个 1.1 里了。
 */

import { announce, log } from "../utils/logger";
import { commuteOrFlee, reserveTargets, unassignedReserveTarget } from "../managers/remote";
import { holdPosition } from "../movement/traffic";
import { travelTo } from "../movement/move";

export function runReserver(creep: Creep): void {
  const roomName = resolveTarget(creep);
  if (!roomName) {
    // 名单里没地方可去了。原来的目标被墙封住是最常见的原因：那种房间再站过去
    // 也够不着控制器，与其占着人口名额白耗 600 tick，不如就地退役把配额让出来
    if (creep.memory.targetRoom) retire(creep);
    else announce(creep, "无需预定");
    return;
  }

  if (commuteOrFlee(creep, roomName)) return;

  const controller = creep.room.controller;
  if (!controller) return;

  // 这个房间已经归我们了。预定自己的房间是无效操作，而且再没有必要——
  // 归属本身就把源的容量抬到了 3000
  if (controller.my) {
    log.info("外矿", `${creep.room.name} 已经是自己的房间，不用预定了`);
    creep.suicide();
    return;
  }

  if (!creep.pos.isNearTo(controller)) {
    travelTo(creep, controller, { range: 1, visualizePathStyle: { stroke: "#aa66ff" } });
    return;
  }

  // 到位就钉住。预定每 tick 都要重新调用一次，被挤开一格就断一 tick 的续期
  holdPosition(creep);
  announce(creep, "预定");

  const result = creep.reserveController(controller);
  if (result === ERR_INVALID_TARGET) {
    // 被别人抢先占了或者预定了。定期复查会把这个房间踢出名单，这里只管说一声
    log.warn("外矿", `${creep.room.name} 的控制器预定不了，已被别人占住`);
  }
}

function retire(creep: Creep): void {
  log.info("外矿", `${creep.name} 的目标 ${creep.memory.targetRoom ?? "?"} 预定不了了，退役`);
  creep.suicide();
}

/**
 * 认死一个房间，不换。
 *
 * 通勤要一百多 tick，占它寿命的两成，中途改主意就等于这趟白跑。只有原来那个
 * 房间彻底不用预定了（被踢出名单、进了冷却）才重新挑。
 */
function resolveTarget(creep: Creep): string | undefined {
  const home = Game.rooms[creep.memory.room];
  if (!home) return undefined;

  const current = creep.memory.targetRoom;
  if (current && reserveTargets(home).includes(current)) return current;

  // 和孵化时的分配用同一个判断，免得两处对"这个房间有人了吗"给出不同答案
  const free = unassignedReserveTarget(home);
  if (free) creep.memory.targetRoom = free;

  return free;
}
