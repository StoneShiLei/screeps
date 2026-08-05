/**
 * 塔的行为：先开火，再治疗，闲下来才修东西。
 *
 * 塔是房间里唯一不需要人操心就能持续输出的东西，但也只有被调用时才动——
 * 建好之后不写这段代码，它就只是个漂亮的摆设。
 */

import { hostilesIn } from "../roles/defender";

/**
 * 修理的能量下限。
 *
 * 塔满能量 1000，开一炮 10 点。留住 500 意味着任何时候都还有五十炮的存量，
 * 不会出现"刚把路修完，入侵者进门时塔是空的"这种事。
 */
const REPAIR_RESERVE = 500;

/**
 * 隔多少 tick 找一次修理目标。
 *
 * 找目标要遍历全房建筑，是这个模块里唯一称得上贵的操作，而衰减是以百 tick
 * 计的慢过程，没必要每 tick 盯着。开火和治疗不受这个间隔限制。
 */
const REPAIR_INTERVAL = 10;

/**
 * 墙和城墙不进修理名单。
 *
 * 它们的 hitsMax 是三亿，塔修一次 800 点，放开修就是把房间所有能量
 * 无限期倒进一堵永远修不满的墙。防御工事该按当前威胁单独定血量目标，
 * 那是以后的事。
 *
 * 写字面量而不是 STRUCTURE_* 常量：那些常量只在游戏运行时存在，模块顶层
 * 引用会让单元测试在加载阶段就崩掉。
 */
const SKIP_REPAIR: StructureConstant[] = ["constructedWall", "rampart"];

export type TowerAction =
  | { kind: "attack"; target: Creep }
  | { kind: "heal"; target: Creep }
  | { kind: "repair"; target: Structure }
  | { kind: "idle" };

export function runTowers(room: Room): void {
  const towers = room.find<StructureTower>(FIND_MY_STRUCTURES, {
    filter: structure => structure.structureType === STRUCTURE_TOWER
  });
  if (towers.length === 0) return;

  const hostiles = hostilesIn(room);
  const wounded = room.find(FIND_MY_CREEPS, { filter: creep => creep.hits < creep.hitsMax });
  const damaged = idle(hostiles, wounded) && Game.time % REPAIR_INTERVAL === 0 ? repairTargets(room) : [];

  for (const tower of towers) {
    const energy = tower.store.getUsedCapacity(RESOURCE_ENERGY);
    const action = chooseTowerAction({ pos: tower.pos, energy }, { hostiles, wounded, damaged });

    switch (action.kind) {
      case "attack":
        tower.attack(action.target);
        break;
      case "heal":
        tower.heal(action.target);
        break;
      case "repair":
        tower.repair(action.target);
        break;
      default:
        break;
    }
  }
}

/**
 * 决定这座塔这一 tick 干什么。
 *
 * 敌人排在伤员前面：把伤害源头打掉才是真止损，边挨打边治疗只是在比谁的
 * 能量先见底，而入侵者的能量是白送的。
 *
 * 拆成纯函数是为了能直接对着优先级写测试，不用搭一个房间出来。
 */
export function chooseTowerAction(
  tower: { pos: RoomPosition; energy: number },
  targets: { hostiles: Creep[]; wounded: Creep[]; damaged: Structure[] }
): TowerAction {
  // 塔伤害随距离衰减，5 格内满伤 600，20 格外只剩 150，所以永远打最近的。
  // 基地里几座塔挨得很近，各自选最近的结果基本就是集火——这正是想要的，
  // 敌方带治疗时把伤害分散到两个目标上，等于一个都打不死。
  const hostile = nearest(tower.pos, targets.hostiles);
  if (hostile) return { kind: "attack", target: hostile };

  const patient = nearest(tower.pos, targets.wounded);
  if (patient) return { kind: "heal", target: patient };

  if (tower.energy <= REPAIR_RESERVE) return { kind: "idle" };

  const broken = weakest(targets.damaged);
  return broken ? { kind: "repair", target: broken } : { kind: "idle" };
}

function idle(hostiles: Creep[], wounded: Creep[]): boolean {
  return hostiles.length === 0 && wounded.length === 0;
}

function nearest<T extends { pos: RoomPosition }>(from: RoomPosition, candidates: T[]): T | undefined {
  let best: T | undefined;
  let bestRange = Infinity;

  for (const candidate of candidates) {
    const range = from.getRangeTo(candidate.pos);
    if (range < bestRange) {
      best = candidate;
      bestRange = range;
    }
  }

  return best;
}

/** 按残血比例挑最惨的那个，而不是绝对血量——不然永远轮不到血条短的容器 */
function weakest(structures: Structure[]): Structure | undefined {
  let best: Structure | undefined;
  let bestRatio = 1;

  for (const structure of structures) {
    const ratio = structure.hits / structure.hitsMax;
    if (ratio < bestRatio) {
      best = structure;
      bestRatio = ratio;
    }
  }

  return best;
}

function repairTargets(room: Room): Structure[] {
  return room.find(FIND_STRUCTURES, {
    filter: structure => structure.hits < structure.hitsMax && !SKIP_REPAIR.includes(structure.structureType)
  });
}
