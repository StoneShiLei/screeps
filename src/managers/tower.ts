/**
 * 塔的行为：先开火，再治疗，闲下来才修东西。
 *
 * 塔是房间里唯一不需要人操心就能持续输出的东西，但也只有被调用时才动——
 * 建好之后不写这段代码，它就只是个漂亮的摆设。
 */

import { hostilesIn, intrudersIn } from "../roles/defender";
import { isPlanned } from "../planner/roomPlanner";

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
 * 墙不进修理名单。
 *
 * hitsMax 是三亿，塔修一次 800 点，放开修就是把房间所有能量无限期倒进
 * 一堵永远修不满的墙。完整的外墙血量目标是以后的事。
 *
 * rampart 另算：图纸上盖在 spawn / 塔上的那几格有明确的软上限，见
 * rampartHitsTarget——不修的话 300 hits/100 tick 的衰减会把新建的城墙啃光，
 * 白花建造的能量。
 *
 * 写字面量而不是 STRUCTURE_* 常量：那些常量只在游戏运行时存在，模块顶层
 * 引用会让单元测试在加载阶段就崩掉。
 */
const SKIP_REPAIR: StructureConstant[] = ["constructedWall"];

/**
 * 图纸上的 rampart 修到这个血量就停。
 *
 * RCL5 才开始盖；一万够挡零星骚扰，再高就按等级抬。绝不能用 hitsMax——
 * 那是三亿，塔会把整房能量砸进去。
 */
export function rampartHitsTarget(level: number): number {
  if (level >= 6) return 100_000;
  if (level >= 5) return 50_000;
  return 10_000;
}

/**
 * 塔伤害随距离衰减：≤5 满伤 600，≥20 只剩 150，每炮固定耗 10 能量。
 * ≥20 伤害不再降，再远开枪纯属被遛塔骗能量。
 *
 * 开火距离不能写死太短：分房里 bunker 和 controller 常隔十几格（E28S35
 * spawn→controller 就是 18），敌人又从 controller 方向进——卡 15 等于放任
 * 入口。默认以 20 为底，再按「塔到己方 controller + 入口余量」抬高。
 *
 * 抢矿邻居更严：打不死人，只在 SNIPE 内划得来时才开枪。
 */
const ENGAGE_RANGE_FLOOR = 20;
/** controller 再往外多打几格，盖住入口走廊，不只盖住控制器那一格 */
const CONTROLLER_COVER = 5;
const SNIPE_RANGE = 10;

/** 这座塔打武装敌人该用多远；纯函数便于单测 */
export function towerEngageRange(towerPos: RoomPosition, controller?: { my?: boolean; pos: RoomPosition } | null): number {
  if (!controller?.my) return ENGAGE_RANGE_FLOOR;
  return Math.max(ENGAGE_RANGE_FLOOR, towerPos.getRangeTo(controller.pos) + CONTROLLER_COVER);
}

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
  // 抢矿的邻居也在名单里，只是排在武装敌人后面、而且只打近处的
  const intruders = intrudersIn(room).filter(creep => !hostiles.includes(creep));
  const wounded = room.find(FIND_MY_CREEPS, { filter: creep => creep.hits < creep.hitsMax });
  const busy = hostiles.length > 0 || intruders.length > 0 || wounded.length > 0;
  const damaged = !busy && Game.time % REPAIR_INTERVAL === 0 ? repairTargets(room) : [];

  for (const tower of towers) {
    const energy = tower.store.getUsedCapacity(RESOURCE_ENERGY);
    const action = chooseTowerAction(
      { pos: tower.pos, energy, engageRange: towerEngageRange(tower.pos, room.controller) },
      { hostiles, intruders, wounded, damaged }
    );

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
  tower: { pos: RoomPosition; energy: number; engageRange?: number },
  targets: { hostiles: Creep[]; intruders?: Creep[]; wounded: Creep[]; damaged: Structure[] }
): TowerAction {
  // 只在 engageRange 内开火；同档里打最近的——几座塔挨着选最近≈集火，
  // 敌方带奶时分散火力等于一个都打不死。
  const engageRange = tower.engageRange ?? ENGAGE_RANGE_FLOOR;
  const hostile = nearestInRange(tower.pos, targets.hostiles, engageRange);
  if (hostile) return { kind: "attack", target: hostile };

  // 武装敌人清完（或不在射程）才轮到抢矿的，而且得在更划算的距离上
  const intruder = nearestInRange(tower.pos, targets.intruders ?? [], SNIPE_RANGE);
  if (intruder) return { kind: "attack", target: intruder };

  const patient = nearest(tower.pos, targets.wounded);
  if (patient) return { kind: "heal", target: patient };

  if (tower.energy <= REPAIR_RESERVE) return { kind: "idle" };

  const broken = weakest(targets.damaged);
  return broken ? { kind: "repair", target: broken } : { kind: "idle" };
}

function nearest<T extends { pos: RoomPosition }>(from: RoomPosition, candidates: T[]): T | undefined {
  return nearestInRange(from, candidates, Infinity);
}

function nearestInRange<T extends { pos: RoomPosition }>(
  from: RoomPosition,
  candidates: T[],
  maxRange: number
): T | undefined {
  let best: T | undefined;
  let bestRange = Infinity;

  for (const candidate of candidates) {
    const range = from.getRangeTo(candidate.pos);
    if (range > maxRange || range >= bestRange) continue;
    best = candidate;
    bestRange = range;
  }

  return best;
}

/**
 * 按相对目标血量的残血比例挑最惨的那个。
 *
 * 不用绝对血量——不然永远轮不到血条短的容器。rampart 的 hitsMax 是三亿，
 * 若按 hitsMax 算比例，任何掉了一点的 rampart 都会永远压过路和容器，
 * 所以改用我们自己定的软上限。
 */
function weakest(structures: Structure[]): Structure | undefined {
  let best: Structure | undefined;
  let bestRatio = 1;

  for (const structure of structures) {
    const goal = hitsGoal(structure);
    if (goal <= 0) continue;
    const ratio = structure.hits / goal;
    if (ratio < bestRatio) {
      best = structure;
      bestRatio = ratio;
    }
  }

  return best;
}

function hitsGoal(structure: Structure): number {
  if (structure.structureType === "rampart") {
    return rampartHitsTarget(structure.room?.controller?.level ?? 0);
  }
  return structure.hitsMax;
}

/**
 * 值得修的东西：图纸上有、而且是自己的。
 *
 * 从"全房间凡是掉血又不是墙的都修"收紧到这一条，是因为占领带旧基地的房间之后
 * 那种写法会闹出两件荒唐事：
 *
 * 一是替对方维护地产。前主人留下的 extension、storage、terminal 都还立在那里，
 * 我们的塔一建好就开始拿自己的能量修它们。
 *
 * 二是和拆迁工对着干。dismantle 把血量打下来，被拆到一半的建筑就成了"掉血了"，
 * 塔跟着修回去——两边烧同一份能量互相抵消，而且从现象上完全看不出为什么拆不动。
 *
 * 路和容器没有归属字段，前人的和自己的从对象上分不出来，只能靠图纸认。
 */
function repairTargets(room: Room): Structure[] {
  return room.find(FIND_STRUCTURES, { filter: structure => isWorthRepairing(room, structure) });
}

function isWorthRepairing(room: Room, structure: Structure): boolean {
  if (SKIP_REPAIR.includes(structure.structureType)) return false;

  if (structure.structureType === "rampart") {
    // 只修图纸上盖在 spawn / 塔上的那些，修到软上限为止
    if (!("my" in structure) || !structure.my) return false;
    if (!isPlanned(room, "rampart", structure.pos.x, structure.pos.y)) return false;
    return structure.hits < rampartHitsTarget(room.controller?.level ?? 0);
  }

  if (structure.hits >= structure.hitsMax) return false;

  // 有主的东西只修自己的
  if ("my" in structure) return structure.my === true;

  // 无主的（路、容器）看位置在不在图纸上
  return isPlanned(room, structure.structureType, structure.pos.x, structure.pos.y);
}
