/**
 * miner：钉在能量源旁的容器上，只挖不动。
 *
 * 挖出来的能量会先装进自己口袋，装满后溢出的部分自动落进脚下的容器，
 * 全程不需要调用 transfer，也就不需要为了搬运多带 CARRY 部件。
 * 5 个 WORK 每 tick 挖 10 点，正好等于一个能量源的再生速率。
 */

import { announce } from "../utils/logger";
import { holdPosition } from "../movement/traffic";
import { travelTo } from "../movement/move";

/** 容器掉血到这个比例以下就顺手修一下，前提是身上带了 CARRY */
const REPAIR_THRESHOLD = 0.75;

export function runMiner(creep: Creep): void {
  const source = resolveSource(creep);
  if (!source) {
    announce(creep, "无矿位");
    return;
  }

  const spot = creep.room.memory.miningSpots?.[source.id];
  if (spot && (creep.pos.x !== spot.x || creep.pos.y !== spot.y)) {
    const target = creep.room.getPositionAt(spot.x, spot.y);
    if (target) {
      travelTo(creep, target, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
      // 走的路上顺手挖，只要够得着就不浪费这几 tick
      creep.harvest(source);
      return;
    }
  }

  // 站到位就赖着不走：挪开一格就少挖一个 tick，回来还得再花一个，
  // 而路过的人绕一步几乎没有代价
  holdPosition(creep);

  creep.harvest(source);
  repairFloor(creep);
}

/**
 * 每个 miner 认领一个能量源，认下就不换。
 *
 * 认领的是能量源 id 而不是坐标，因为采集点是从能量源反查出来的，
 * 而且换岗意味着长途跋涉，静态矿工换岗就是纯亏。
 */
function resolveSource(creep: Creep): Source | null {
  if (creep.memory.sourceId) {
    const bound = Game.getObjectById(creep.memory.sourceId);
    if (bound) return bound;
    delete creep.memory.sourceId;
  }

  const taken = new Set<string>();
  for (const other of Object.values(Game.creeps)) {
    if (other.memory.role !== "miner" || other.name === creep.name) continue;
    if (other.memory.sourceId) taken.add(other.memory.sourceId);
  }

  const spots = creep.room.memory.miningSpots ?? {};
  const freeId = Object.keys(spots).find(id => !taken.has(id));

  // 落点还没规划出来时退化成"随便找个没人的源"，至少不会站着发呆
  const source = freeId
    ? Game.getObjectById(freeId as Id<Source>)
    : creep.room.find(FIND_SOURCES).find(candidate => !taken.has(candidate.id)) ?? null;

  creep.memory.sourceId = source?.id;
  return source;
}

/**
 * 修脚下的容器。
 *
 * 容器每 500 tick 掉 5000 血，没人管迟早塌掉。矿工站在上面又刚好有能量，
 * 是全房间修它成本最低的角色——修 5000 血只要 50 能量，还不用跑腿。
 */
function repairFloor(creep: Creep): void {
  if (creep.store[RESOURCE_ENERGY] === 0) return;

  const container = creep.pos
    .lookFor(LOOK_STRUCTURES)
    .find(structure => structure.structureType === STRUCTURE_CONTAINER);

  if (container && container.hits < container.hitsMax * REPAIR_THRESHOLD) {
    creep.repair(container);
  }
}
