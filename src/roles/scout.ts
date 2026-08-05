/**
 * scout：一个 MOVE 的侦察兵，专门去踩邻房拿视野。
 *
 * 存在的唯一理由是外矿房间平时没有视野，find(FIND_SOURCES) 返回空数组，
 * 派矿工出门前得先知道那边有几个源、在哪一格、有没有被别人占。
 *
 * 50 能量一个，走一圈把邻房记完就没事干了，所以侦察完不留人，当场自尽：
 * 反正下次要复查时再造一个也就 50 能量。
 */

import { announce, log } from "../utils/logger";
import { nextScoutTarget, surveyRoom } from "../managers/remote";
import { travelTo } from "../movement/move";

export function runScout(creep: Creep): void {
  // 每进一个新房间都顺手记一笔，路过的房间也一样，白得的情报不要浪费
  if (creep.room.name !== creep.memory.room) {
    surveyRoom(creep.room);
  }

  if (creep.memory.targetRoom === creep.room.name) {
    delete creep.memory.targetRoom;
  }

  const home = Game.rooms[creep.memory.room];
  const target = creep.memory.targetRoom ?? (home ? nextScoutTarget(home) : undefined);

  if (!target) {
    retire(creep);
    return;
  }

  creep.memory.targetRoom = target;
  announce(creep, `探${target}`);

  // 奔房间中心，range 20 意味着一进门就算到了——要的只是视野，不是站到哪一格
  travelTo(creep, new RoomPosition(25, 25, target), { range: 20 });
}

/**
 * 探完就自尽，不留着养老。
 *
 * 侦察结果的保鲜期是两万 tick，而它一条命只有一千五，所以"现在没地方可探"
 * 等于"这辈子都不会再有活干"。留着它不只是白吃 CPU：它探完最后一个房间时
 * 人正站在两房交界处，而边缘格是站不住的，引擎会把它来回踢，看着像在巡逻。
 *
 * 也不担心刚死就被重造——配额本身就是"有房间要探才要人"，没活时是零。
 */
function retire(creep: Creep): void {
  log.info("侦察", `${creep.name} 无处可探，退役`);
  creep.suicide();
}
