/**
 * 开分房：占下一个新房间，再把它扶到能自己造人。
 *
 * 分房和外矿是两笔完全不同的账。外矿是把别人家的能量搬回来，收益立刻到账；
 * 分房前期是纯投入——第一个 spawn 要 15000 能量，那期间新房间一点产出都没有。
 * 但它换来的是一整套独立的产线：两个 3000 容量的源、自己的控制器（GCL 照拿）、
 * 自己的 spawn 和 extension，以及自己那一圈外矿。一个分房的天花板比十个外矿高。
 *
 * 关键的成本控制在于：15000 能量不从老家运。拓荒者带着 WORK 过去就地挖、就地建，
 * 老家只出它们的孵化费（一个 800 能量，几百 tick 造一批）。真要靠运输队把
 * 15000 能量运过两个房间，光路上的损耗就够再造一个 spawn。
 *
 * 进度不存 Memory，每 tick 从游戏状态直接看：
 *   控制器不是自己的      → 还没占下，派占领者
 *   是自己的但没有 spawn  → 派拓荒者，它们自己挖自己建
 *   有 spawn 但还没人手   → 留少量拓荒者帮着起步
 *   自己造得出人了        → 记录撤销，从此它就是个普通的家
 * 这样被人抢了、spawn 被拆了、房间掉级，都不需要额外的复原逻辑。
 */

import { CLAIM_LIFETIME, partsWeight, spawnHeadroom } from "./spawnLoad";
import { blockedByIntruders, demolitionList } from "./demolish";
import { bodyFor } from "../utils/body";
import { hostilesIn } from "../roles/defender";
import { log } from "../utils/logger";
import { roadCrewTarget } from "./remote";
import { worldRange } from "../utils/distance";

/**
 * 几级才开得起分房。
 *
 * 3 级是物理下限而不是保守取值：占领者要一个 CLAIM，600 能量，加一个 MOVE 就是
 * 650——而 2 级的能量上限只有 550，根本孵不出来。同一档上限（800）也刚好够拓荒者
 * 配到四组 WORK CARRY MOVE，每 tick 挖 8 点、建 20 点，是能在合理时间内啃完
 * 15000 能量的最小体型。
 *
 * 敢定在 3 级，是因为分房的大头开销不落在老家：15000 能量由拓荒者在目标房间
 * 就地挖，老家只出它们的孵化费，摊下来每 tick 四点上下。真正会被挤掉的是孵化
 * 时间，而那一道有 spawnHeadroom 兜着——排不下就自动少派人，不会闷着把本土
 * 的补人饿死。
 */
export const EXPAND_MIN_LEVEL = 3;

/** 建 spawn 期间派几个拓荒者 */
const PIONEERS_BUILDING = 4;

/** spawn 建好之后留几个，帮新房把 extension 和容器铺开 */
const PIONEERS_GROWING = 2;

/**
 * 去外矿铺路的只派一个。
 *
 * 铺路是慢工，多派人也快不了多少：四十格的路线要几千能量，而那些能量得从当地
 * 矿工的产出里挤——派两个人只会把运输队该运走的那份分得更薄。
 */
const ROAD_CREW = 1;

/**
 * 增援分房最多派几个兵。
 *
 * 三个是"够压过一支小队"和"别把老家的孵化时间全占了"之间的界线。真要面对成建制
 * 的部队，靠远征兵是打不赢的——那时候该做的是把分房升到 3 级建塔，或者认赔撤出。
 */
const MAX_COLONY_DEFENDERS = 3;

/**
 * 新房间自己有这么多人就算能自理了。
 *
 * 三个人对应我们的补人顺序：一个应急 harvester、一个矿工、一个搬运工，
 * 也就是那条"挖—运—孵化"的闭环刚好接通的时刻。到这一步拓荒者就没有不可替代
 * 的作用了，撤掉记录让老家把编制收回去。
 */
const SELF_SUFFICIENT = 3;

/** 分房离老家最多几格。再远拓荒者一路上就走掉小半条命 */
const MAX_EXPAND_RANGE = 4;

export type ExpansionStage = "claim" | "build" | "grow";

/** 这个家正在开的分房，没有就是 undefined */
export function expansionTarget(home: Room): string | undefined {
  return home.memory.expansion?.target;
}

/**
 * 分房进行到哪一步了，照游戏现状判断。
 *
 * 没有视野一律算"还没占下"：占领者过去自然会带来视野，而在那之前我们确实
 * 不知道那边什么情况。
 */
export function expansionStage(home: Room): ExpansionStage | undefined {
  const target = expansionTarget(home);
  if (!target) return undefined;

  const room = Game.rooms[target];
  if (!room?.controller?.my) return "claim";
  if (room.find(FIND_MY_SPAWNS).length === 0) return "build";

  return "grow";
}

/**
 * 记录该不该撤了。
 *
 * 撤销的条件是新房间能自己造人，而不是"spawn 建好了"：spawn 刚建好那会儿房间
 * 里一个 creep 都没有，能量也是空的，这时候把拓荒者撤走它会一直卡在原地。
 */
export function runExpansionManager(home: Room): void {
  const target = expansionTarget(home);
  if (!target) return;

  const room = Game.rooms[target];
  if (!room?.controller?.my) return;
  if (room.find(FIND_MY_SPAWNS).length === 0) return;
  if (nativeCreeps(target) < SELF_SUFFICIENT) return;

  const ticks = Game.time - (home.memory.expansion?.since ?? Game.time);
  log.info("分房", `${target} 已经能自己造人了，${home.name} 撤销扶持（历时 ${ticks} tick）`);
  delete home.memory.expansion;
}

/**
 * 占领者的配额。
 *
 * 一个就够，而且只在还没占下时才要。占领是一次性动作：claimController 成功那一
 * 瞬间房间就永久归自己了，不像预定还要有人续着。
 */
export function claimerQuota(home: Room): number {
  if (expansionStage(home) !== "claim") return 0;
  if (!hasRoomSlot()) return 0;

  return 1;
}

/**
 * 拓荒者的配额。
 *
 * 上限再被孵化预算卡一道。分房是投入期最长的一笔投资，绝不能为了它把本土的
 * 补人挤掉——外矿那边已经证明过：孵化排不下的时候，账面上能量还够用，人却
 * 一直缺，而且看不出原因。
 */
export function pioneerQuota(home: Room): number {
  const stage = expansionStage(home);
  if (stage === "build") return affordable(home, PIONEERS_BUILDING);
  if (stage === "grow") return affordable(home, PIONEERS_GROWING);

  // 分房那边不忙的时候，这套身体正好去外矿建容器和铺路：一样是跨房间通勤、
  // 就地找能量、建造和修理，不必再造一种角色
  if (roadCrewTarget(home)) return affordable(home, ROAD_CREW);

  return 0;
}

/**
 * 预算允许的话给到 wanted，不允许就维持现有人数。
 *
 * 只封顶不裁员：已经在路上的人裁掉等于白花孵化费，而且新房间那边正等着它。
 */
function affordable(home: Room, wanted: number): number {
  const alive = ourPioneers(home).length;
  if (alive >= wanted) return wanted;

  const each = partsWeight(bodyFor("pioneer", home.energyCapacityAvailable).length);
  const extra = Math.floor(spawnHeadroom(home) / each);
  if (extra <= 0) {
    log.debug("分房", () => `${home.name} 孵化预算排不下更多拓荒者，先维持 ${alive} 个`);
  }

  return Math.min(wanted, alive + Math.max(0, extra));
}

function ourPioneers(home: Room): Creep[] {
  return Object.values(Game.creeps).filter(
    creep => creep.memory.role === "pioneer" && creep.memory.room === home.name
  );
}

/** 新房间自己孵出来的人，不含老家派去的拓荒者 */
function nativeCreeps(target: string): number {
  return Object.values(Game.creeps).filter(creep => creep.memory.room === target).length;
}

/**
 * GCL 还够不够再占一个房间。
 *
 * 超了的话 claimController 会直接返回 ERR_GCL_NOT_ENOUGH，占领者白跑一趟——
 * 六百能量的 CLAIM 加上几百 tick 的路程，不如出发前就查清楚。
 */
function hasRoomSlot(): boolean {
  const owned = Object.values(Game.rooms).filter(room => room.controller?.my).length;
  return owned < Game.gcl.level;
}

/**
 * 定下要开哪个分房。控制台用，顺手把明显不成立的目标拦下来。
 *
 * 只做出发前查得到的检查。目标房间此刻多半还没有视野，里面有没有 invader core、
 * 地形放不放得下 bunker，都得等占领者到了才知道——那种情况留给规划器发现。
 */
export function startExpansion(home: Room, target: string): string {
  const level = home.controller?.level ?? 0;
  if (level < EXPAND_MIN_LEVEL) return `${home.name} 才 ${level} 级，${EXPAND_MIN_LEVEL} 级再开分房`;

  if (!/^[WE]\d+[NS]\d+$/.test(target)) return `${target} 不像房间名`;
  if (target === home.name) return "这就是老家";
  if (Game.rooms[target]?.controller?.my) return `${target} 已经是自己的了`;
  if (!hasRoomSlot()) return `GCL ${Game.gcl.level} 只够占 ${Game.gcl.level} 个房间，先升 GCL`;

  const anchor = home.memory.anchor;
  const range = anchor
    ? worldRange(new RoomPosition(anchor.x, anchor.y, home.name), new RoomPosition(25, 25, target))
    : 0;
  if (range > MAX_EXPAND_RANGE * 50) return `${target} 离 ${home.name} 有 ${range} 格，太远了`;

  home.memory.expansion = { target, since: Game.time };
  log.info("分房", `${home.name} 开始开 ${target}`);

  return `${home.name} → ${target}：先派占领者，占下之后 ${PIONEERS_BUILDING} 个拓荒者过去建 spawn`;
}

export function cancelExpansion(home: Room): string {
  const target = expansionTarget(home);
  if (!target) return `${home.name} 没在开分房`;

  delete home.memory.expansion;
  // 已经派出去的人一起召回：目标没了，它们在那边站着纯粹白吃编制
  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.room !== home.name) continue;
    if (creep.memory.role === "claimer" || creep.memory.role === "pioneer") delete creep.memory.targetRoom;
  }

  log.warn("分房", `${home.name} 取消开 ${target}`);
  return `${home.name} 取消开 ${target}`;
}

/** 一行状态，给面板和控制台共用 */
export function expansionStatus(home: Room): string | undefined {
  const target = expansionTarget(home);
  const stage = expansionStage(home);
  if (!target || !stage) return undefined;

  if (stage === "claim") {
    const claimer = Object.values(Game.creeps).find(
      creep => creep.memory.role === "claimer" && creep.memory.targetRoom === target
    );
    return `${target} 待占领${claimer ? `（占领者在 ${claimer.room.name}）` : ""}`;
  }

  const room = Game.rooms[target];
  const level = room?.controller?.level ?? 0;

  if (stage === "build") {
    const crew = `${ourPioneers(home).length} 拓荒`;

    // 前人的房子占着建筑上限，我们的 spawn 工地根本拍不下来。这个状态最容易看成
    // "规划坏了"，所以要写明白还剩几个要拆
    const junk = room ? demolitionList(room).length : 0;
    if (junk > 0) return `${target} 待拆前人建筑 ${junk} 个（${crew}）`;

    const site = room?.find(FIND_MY_CONSTRUCTION_SITES).find(candidate => candidate.structureType === "spawn");
    const progress = site ? `${Math.round((site.progress / site.progressTotal) * 100)}%` : "选址中";
    return `${target} 建 spawn ${progress}（${crew}）`;
  }

  return `${target} RCL${level}，自有 ${nativeCreeps(target)} 人`;
}

/**
 * 分房需要老家派几个兵。
 *
 * 只管还没有 spawn 的分房：有了 spawn 它自己就能造兵，不用老家跨房间支援。
 *
 * 两种情况都要派。一种是被赖着不走的经济单位堵住了拆迁，一个兵去清场就行。
 * 另一种是真挨打了——新占的房间没有塔，也没有本地 spawn 补人，不派兵就是把
 * 已经投进去的占领者、拓荒者和那个 spawn 工地一起送掉。
 *
 * 挨打时按敌人数量加一个：对方带着治疗单位时，火力必须压过它的回血量才推得动，
 * 打成僵持等于两边一起烧钱而我们还多赔一条运输线。
 */
export function colonyDefenders(home: Room): { target: string; count: number } | undefined {
  const target = expansionTarget(home);
  if (!target) return undefined;

  const room = Game.rooms[target];
  if (!room?.controller?.my) return undefined;
  if (room.find(FIND_MY_SPAWNS).length > 0) return undefined;

  const armed = hostilesIn(room).length;
  if (armed > 0) return { target, count: Math.min(armed + 1, MAX_COLONY_DEFENDERS) };

  return blockedByIntruders(room) ? { target, count: 1 } : undefined;
}

/**
 * 给占领者和拓荒者派活。
 *
 * 分房优先；分房那边不需要人的时候，拓荒者转去外矿建容器和铺路。
 */
export function expansionAssignment(home: Room): Partial<CreepMemory> {
  const target = expansionTarget(home);
  if (target) return { targetRoom: target };

  const road = roadCrewTarget(home);
  return road ? { targetRoom: road } : {};
}

/** 占领者的孵化预算占用，给 CLI 估成本用 */
export function claimerWeight(home: Room): number {
  return partsWeight(bodyFor("claimer", home.energyCapacityAvailable).length, CLAIM_LIFETIME);
}
