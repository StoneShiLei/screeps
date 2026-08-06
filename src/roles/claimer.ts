/**
 * 占领者：走到新房间的控制器旁边，按一下 claimController。
 *
 * 一辈子只干这一件事，成了就自杀。它是整个分房流程里最便宜也最关键的一环——
 * 750 能量换一个永久归属的房间，而在它按下之前，拓荒者过去也没有工地可建。
 */

import { announce, log } from "../utils/logger";
import { commuteTo, travelTo } from "../movement/move";
import { cancelExpansion } from "../managers/expansion";
import { holdPosition } from "../movement/traffic";

export function runClaimer(creep: Creep): void {
  const roomName = creep.memory.targetRoom;
  if (!roomName) {
    // 分房被取消了。CLAIM 部件在别处一点用都没有，留着只是占编制
    announce(creep, "无处可占");
    creep.suicide();
    return;
  }

  if (commuteTo(creep, roomName)) {
    announce(creep, "去占领");
    return;
  }

  const controller = creep.room.controller;
  if (!controller) {
    log.error("分房", `${roomName} 没有控制器，占不了`);
    creep.suicide();
    return;
  }

  if (controller.my) {
    log.info("分房", `${roomName} 已经归自己了，占领者退役`);
    creep.suicide();
    return;
  }

  if (!creep.pos.isNearTo(controller)) {
    travelTo(creep, controller, { visualizePathStyle: { stroke: "#ffdd44" } });
    return;
  }

  // 站定：claimController 要贴身，被路过的人挤开一格就白丢一 tick，
  // 而它的寿命只有 600
  holdPosition(creep);
  announce(creep, "占领");
  handle(creep, creep.claimController(controller), roomName);
}

function handle(creep: Creep, result: ReturnType<Creep["claimController"]>, roomName: string): void {
  if (result === OK) {
    log.info("分房", `${roomName} 占领成功，接下来靠拓荒者把 spawn 建起来`);
    creep.suicide();
    return;
  }

  if (result === ERR_GCL_NOT_ENOUGH) {
    // 出发前查过 GCL，能走到这里说明期间又占了别的房间。继续待着只是白耗，
    // 而且会一直派新的占领者过来重复同一个错误
    log.error("分房", `GCL 不够，占不下 ${roomName}，取消`);
    const home = Game.rooms[creep.memory.room];
    if (home) cancelExpansion(home);
    creep.suicide();
    return;
  }

  if (result === ERR_INVALID_TARGET) {
    // 被别人抢先占了或预定了。抢回来要先用 attackController 把对方的预定打掉，
    // 那是另一套投入，交给人来决定值不值得
    log.error("分房", `${roomName} 的控制器已经被别人占着，换个目标（remote/expand 命令）`);
    return;
  }

  log.warn("分房", `${roomName} claimController 返回 ${result}`);
}
