/**
 * remoteMiner：派驻在邻房能量源旁边，挖出来就丢地上。
 *
 * 和家里的 miner 有两处不同。
 *
 * 一是只带 3 个 WORK。中立房间的源容量 1500、300 tick 再生，平均 5 能量/tick，
 * 3 个 WORK 每 tick 挖 6 点已经超过再生速度，多带的 WORK 只会让它更早把源
 * 挖空然后闲着，白付一份孵化费和通勤费。
 *
 * 二是不修容器也不指望容器。外矿的容器要 creep 在场才能建，而且没人维护就
 * 一直 decay，前期直接丢地上更省事——地上的能量每 tick 只蒸发千分之一，
 * 运输队赶得及。
 */

import { RESERVED_MINER_WORK, activeRemoteSources, commuteOrFlee, isReserved } from "../managers/remote";
import { announce, log } from "../utils/logger";
import { holdPosition } from "../movement/traffic";
import { travelTo } from "../movement/move";

export function runRemoteMiner(creep: Creep): void {
  const assignment = resolveAssignment(creep);
  if (!assignment) {
    announce(creep, "无外矿");
    return;
  }

  if (outgrown(creep, assignment.roomName)) {
    log.info("外矿", `${creep.name} 的 WORK 跟不上已预定的 ${assignment.roomName}，让位给大号`);
    creep.suicide();
    return;
  }

  if (commuteOrFlee(creep, assignment.roomName)) return;

  const source = Game.getObjectById(assignment.sourceId as Id<Source>);
  if (!source) {
    // 站在房间里却拿不到对象，说明记的位置过时了，重新侦察一遍
    delete creep.memory.sourceId;
    return;
  }

  if (!creep.pos.isNearTo(source)) {
    travelTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" } });
    return;
  }

  // 到位就钉住：外矿的位置同样是产出，被路过的运输队挤开一格就少挖一个 tick
  holdPosition(creep);
  announce(creep, "挖");
  creep.harvest(source);
}

/**
 * 房间刚被预定，而自己是预定之前造的小号。
 *
 * 预定把源容量抬回 3000、产能翻倍到 10 能量/tick，3 个 WORK 每 tick 只挖 6 点，
 * 每个再生周期都要漏掉一千二。它还能活一千多 tick，攒下来的亏空比重造一个
 * 5 WORK 的矿工贵好几倍，所以宁可现在就退场——配额立刻空出来，下一个按新
 * 标准孵化。
 *
 * 反过来（预定失效了而自己是大号）不处理：多带的 WORK 只是挖完早点闲着，不亏。
 */
function outgrown(creep: Creep, roomName: string): boolean {
  if (!isReserved(roomName)) return false;

  return creep.body.filter(part => part.type === "work").length < RESERVED_MINER_WORK;
}

/**
 * 认领一个外矿能量源，认下就不换。
 *
 * 换岗对静态矿工是纯亏——跨房间通勤要几十 tick，而它的寿命只有 1500。
 * 所以只在原来认的那个矿彻底不能去了（被占、冷却中）才重新挑。
 */
function resolveAssignment(creep: Creep): { roomName: string; sourceId: string } | undefined {
  const home = Game.rooms[creep.memory.room];
  if (!home) return undefined;

  const available = activeRemoteSources(home);

  const bound = available.find(entry => entry.sourceId === creep.memory.sourceId);
  if (bound) return bound;

  const taken = new Set<string>();
  for (const other of Object.values(Game.creeps)) {
    if (other.memory.role !== "remoteMiner" || other.name === creep.name) continue;
    if (other.memory.sourceId) taken.add(other.memory.sourceId);
  }

  const free = available.find(entry => !taken.has(entry.sourceId));
  if (!free) return undefined;

  creep.memory.sourceId = free.sourceId as Id<Source>;
  creep.memory.targetRoom = free.roomName;
  return free;
}
