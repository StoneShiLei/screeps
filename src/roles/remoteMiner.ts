/**
 * remoteMiner：派驻在邻房能量源旁边，站在矿边容器上挖。
 *
 * 和家里的 miner 有两处不同。
 *
 * 一是只带 3 个 WORK。中立房间的源容量 1500、300 tick 再生，平均 5 能量/tick，
 * 3 个 WORK 每 tick 挖 6 点已经超过再生速度，多带的 WORK 只会让它更早把源
 * 挖空然后闲着，白付一份孵化费和通勤费。
 *
 * 二是矿边容器归它自己管——建也是它、修也是它。它已经站在落点上，已经有 WORK，
 * 而且 3 个 WORK 每 tick 挖 6 点、源只回 5 点，本身就有余力；无主房间的容器每
 * 100 tick 掉 5000 血，一个 WORK 每 tick 修 100 血只花 1 能量，摊下来半点能量/tick。
 * 为这点活专派一个跨房拓荒者，等于把已经付过的钱再付一遍。
 *
 * 预算不够配 CARRY 时（450 以下，加了 CARRY 就只剩 2 个 WORK）它退回纯挖：
 * 能量掉在脚下，有容器就自动收进去，没有就堆在地上等运输队捡。
 */

import { RESERVED_MINER_WORK, activeRemoteSources, commuteOrFlee, isReserved } from "../managers/remote";
import { announce, log } from "../utils/logger";
import { holdPosition } from "../movement/traffic";
import { travelTo } from "../movement/move";

/** 容器掉血到这个比例以下就顺手修，和本房 miner 同一口径 */
const REPAIR_THRESHOLD = 0.75;

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

  const spot = creep.room.memory.miningSpots?.[source.id];
  if (spot && (creep.pos.x !== spot.x || creep.pos.y !== spot.y)) {
    const target = creep.room.getPositionAt(spot.x, spot.y);
    if (target) {
      travelTo(creep, target, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
      creep.harvest(source);
      return;
    }
  }

  if (!creep.pos.isNearTo(source)) {
    travelTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" } });
    return;
  }

  // 到位就钉住：外矿的位置同样是产出，被路过的运输队挤开一格就少挖一个 tick
  holdPosition(creep);

  // 挖和建/修可以同一 tick 做完：harvest 和 build 各占一次意图，互不冲突。
  // 先挖再花，口袋里的能量才是这一 tick 刚到手的
  creep.harvest(source);
  if (!tendContainer(creep)) announce(creep, "挖");
}

/**
 * 建或修脚下的矿边容器，做了事就返回 true。
 *
 * 建容器要 5000 能量，等于这个源一千 tick 的全部产出，所以工地什么时候拍
 * 由 maintainRemoteSites 按等级把关；矿工只负责"有工地就推进度"。
 */
function tendContainer(creep: Creep): boolean {
  if (creep.store[RESOURCE_ENERGY] === 0) return false;

  const here = creep.pos.lookFor(LOOK_STRUCTURES);
  const container = here.find(
    (structure): structure is StructureContainer => structure.structureType === STRUCTURE_CONTAINER
  );

  if (container) {
    if (container.hits >= container.hitsMax * REPAIR_THRESHOLD) return false;
    announce(creep, "补桶");
    creep.repair(container);
    return true;
  }

  const site = creep.pos.lookFor(LOOK_CONSTRUCTION_SITES)[0];
  if (!site || site.structureType !== STRUCTURE_CONTAINER) return false;

  announce(creep, "建桶");
  creep.build(site);
  return true;
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
