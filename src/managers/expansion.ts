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
import { defendersNeeded, hostilesIn } from "../roles/defender";
import { bodyFor } from "../utils/body";
import { hasCoreBuildPending } from "../planner/roomPlanner";
import { log } from "../utils/logger";
import { roadCrewTarget } from "./remote";
import { worldRange } from "../utils/distance";

/**
 * 几级才开得起分房。
 *
 * 3 级是物理下限而不是保守取值：占领者要一个 CLAIM，600 能量，加一个 MOVE 就是
 * 650——而 2 级的能量上限只有 550，根本孵不出来。同一档上限（800）够拓荒者
 * 三组无路满速体（W+C+M+M），每 tick 挖 6 点、建 15 点，跨房满载仍 1t/格。
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
 * 老家有余裕时，拓荒者加派到几个。
 *
 * 基础人数只求把新房带起来，节奏由新房自己两个源的产出定死。但老家攒下一大笔
 * 闲置能量时，那笔能量搁在 storage 里除了升级控制器没别的去处——不如折成孵化费
 * 多派几个拓荒者，让它们在新房就地把前期几千能量的建造和升级一口气啃完，
 * 把最难受的那段前期压到最短。
 *
 * 封在 6 个是新房两个源撑得住的上限：再多也只是挤在源边排队，那份 WORK 白养。
 * 真正能不能加到这个数还有 affordable 那道孵化预算闸兜着，排不下就自动少派。
 */
const PIONEERS_SURGE = 6;

/**
 * spawn 建好之后、有余裕时的加派上限，比建 spawn 那阵克制得多。
 *
 * 建 spawn 是一锤子买卖，值得一口气堆到 6 个抢时间；spawn 建好之后是一段更长的
 * 爬坡——要把房间扶到能自保（有塔）。这段路不能一直占着老家一大把编制，所以
 * 有余裕时也只多派一个：把本该拿去多造一个闲置 upgrader 的那点富余，换成一个
 * 拓荒者去分房接着开荒。数量克制，靠的是它自己的源慢慢长，不是老家一直输血。
 */
const PIONEERS_GROW_SURGE = 3;

/**
 * storage 里攒够这么多能量才算有余裕，可以加派。
 *
 * 卡在 storage 而不是别的信号，是因为余裕的本质就是"能量多到没处花"。两万是
 * 本土产线喂饱之后常见的闲置量级——再卡到十万，加派几乎永远不亮，富余全喂给
 * 闲置 upgrader，分房那边一个拓荒者都多不出来。RCL3 的老家连 storage 都没有，
 * 自然永远不触发加派——它自己都刚够温饱，谈不上接济别人。
 */
const SURGE_ENERGY = 20000;

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
 * 撤销的门槛是新房间能自保，而不是"能造出人"。造得出三个人只说明"挖—运—孵化"
 * 那条闭环刚接通，可房间这时还没有塔——一被入侵者骚扰就得停摆，产线一断又回到
 * 需要外援的原点，来回拉扯永远起不来。所以扶持一直留到它建起塔：塔要 RCL3、
 * 意味着 extension 铺开了、经济也转起来了，从此它能自己扛住入侵者，才算真站稳。
 *
 * 之后万一再挨打，那是 guardian 远程协防那套系统的事，和开荒扶持彻底分开。
 */
export function runExpansionManager(home: Room): void {
  const target = expansionTarget(home);
  if (!target) return;

  const room = Game.rooms[target];
  if (!room?.controller?.my) return;
  if (room.find(FIND_MY_SPAWNS).length === 0) return;
  if (!selfDefending(room)) return;

  const ticks = Game.time - (home.memory.expansion?.since ?? Game.time);
  log.info("分房", `${target} 已经能自保（建起塔了），${home.name} 撤销扶持（历时 ${ticks} tick）`);
  delete home.memory.expansion;
}

/** 分房能不能自保了：建起塔就算。塔要 RCL3、也意味着经济已经转起来 */
function selfDefending(room: Room): boolean {
  return room.find(FIND_MY_STRUCTURES, { filter: structure => structure.structureType === STRUCTURE_TOWER }).length > 0;
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
 *
 * 不单认 expansion 记录：旧逻辑在"造出三个人"时就把记录撤了，弱房还没塔就
 * 被扔回去自己开荒——兵援（colonyDefenders）已经改成扫所有没塔的弱房，经济
 * 扶持也必须同样不依赖那条记录，否则上传之后看起来像策略完全没生效。
 */
export function pioneerQuota(home: Room): number {
  const stage = expansionStage(home);
  // 外矿容器/路缺人时永远留缺口：本房核心建造或分房扶持可以冻结加派，
  // 但不能把这一格也掐掉——矿工产出洒在地上蒸发，比主房晚几天齐 extension 更亏。
  // 现场踩过：E27S36 已拍容器工地，本房有一个 extension 工地就把 pioneer 配额冻 0。
  const roadGap = roadCrewGap(home);

  // 目标正在挨打就先别往里添拓荒者：安全优先，让 guardian（跨房协防）把场清干净
  // 再派工作单位。工作兵冲进交火区只是白送，还占着孵化预算把真正该出的协防挤后头。
  // 只压不裁——路上的人留着，清完场立刻恢复扶持。看不见目标（claim 阶段没视野）
  // 就当安全，不然分房永远开不出来。外矿路队不进火场，缺口照留。
  if (stage === "build" || stage === "grow") {
    const target = expansionTarget(home);
    if (target && underAttack(target)) {
      return affordable(home, ourPioneers(home).length + roadGap);
    }

    // 本房核心建筑没铺完时：建 spawn 那一档仍放行（没 spawn 分房永远起不来），
    // grow / 扶持一律冻结——主房 extension 都没齐就去铺分房，两边都半吊子。
    // 外矿路队仍放行：一格名额，就地吃外矿产出，不跟本房 builder 抢能量。
    if (stage === "grow" && hasCoreBuildPending(home)) {
      return affordable(home, ourPioneers(home).length + roadGap);
    }

    const cap = stage === "build" ? PIONEERS_SURGE : PIONEERS_GROW_SURGE;
    const base = stage === "build" ? PIONEERS_BUILDING : PIONEERS_GROWING;
    return affordable(home, surge(home, base, cap) + roadGap);
  }

  // 没有进行中的分房记录时，扶持弱房和给外矿铺路这两笔活可能同时存在，要相加，
  // 不是二选一——旧写法 colonyBoost 一亮就 return，外矿的容器/路永远排不上人，
  // 表现就是"开了外矿却没人去建 container"。两笔需求各自的分派见 expansionAssignment。
  // 本房核心建筑没铺完：只冻扶持，外矿路队照派。
  if (hasCoreBuildPending(home)) {
    return affordable(home, ourPioneers(home).length + roadGap);
  }

  let wanted = roadCrewTarget(home) ? ROAD_CREW : 0;
  if (colonyBoostTarget(home)) wanted += surge(home, PIONEERS_GROWING, PIONEERS_GROW_SURGE);

  return affordable(home, wanted);
}

/**
 * 需要经济扶持的弱房：已有 spawn、还没塔、比自己弱、在开拓范围内。
 *
 * 和 needsColonyRelief 同口径（没塔 = 还不能自保），但只要"有 spawn"的——
 * 还在建 spawn 的阶段必须走 expansion 记录，那是主动开拓，不是事后接济。
 */
export function colonyBoostTarget(home: Room): string | undefined {
  let best: string | undefined;
  let bestLevel = Infinity;

  for (const room of Object.values(Game.rooms)) {
    if (!needsColonyRelief(home, room)) continue;
    if (room.find(FIND_MY_SPAWNS).length === 0) continue;

    // 正在挨打的房间不是"经济扶持"对象而是"协防"对象：交给 colonyDefenders 出兵，
    // 拓荒者等它清完场再来。安全优先，别把工作单位往火里送。
    if (hostilesIn(room).length > 0) continue;

    const level = room.controller?.level ?? 0;
    if (level < bestLevel) {
      best = room.name;
      bestLevel = level;
    }
  }

  return best;
}

/** 目标房间此刻看得见、且有武装敌人 */
function underAttack(target: string): boolean {
  const room = Game.rooms[target];
  return room ? hostilesIn(room).length > 0 : false;
}

/**
 * 有余裕时把目标人数抬到加派上限 cap，没余裕就维持基础人数。
 *
 * 只抬"想要几个"，抬完照样过 affordable 那道孵化预算闸——余裕说的是能量花不完，
 * 孵化时间够不够是另一回事，两道闸都点头才真加得出人。cap 分阶段给：建 spawn
 * 时敢堆高抢时间，扶持爬坡时压低，只把富余换成一个拓荒者而不是一个闲置 upgrader。
 */
function surge(home: Room, base: number, cap: number): number {
  const stored = home.storage?.store[RESOURCE_ENERGY] ?? 0;
  return stored >= SURGE_ENERGY ? Math.max(base, cap) : base;
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

  if (!target || !stage) {
    // 没有开拓记录也要说清楚：否则面板一片空白，看起来像扶持策略没跑
    const boost = colonyBoostTarget(home);
    if (!boost) return undefined;
    const boostLevel = Game.rooms[boost]?.controller?.level ?? 0;
    return `${boost} RCL${boostLevel} 扶持中（${ourPioneers(home).length} 拓荒，扶到有塔）`;
  }

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

  return `${target} RCL${level}，自有 ${nativeCreeps(target)} 人，${ourPioneers(home).length} 拓荒扶持中`;
}

/**
 * 弱房需要老家派几个兵。
 *
 * 门槛是"有没有塔"，不是"有没有 spawn"。spawn 建好但还没塔的房间（RCL1-2）
 * 自己孵出的兵体型太弱，挨打时仍要老家支援；有塔之后火力是本房的事。
 *
 * 也不限 expansion 记录——扶持撤销后分房仍可能被打。扫所有看得见的己方房间，
 * 只支援比自己等级低、且距离在开拓范围内的。
 *
 * 挨打时按敌人战力折算派几个，不照人头：对方常是一堆小 creep，我方一个满编兵
 * 抵得过好几个，照人头会派出一堆闲兵。带治疗时再加一个压过它的回血量。
 * 拆迁清场仍只对还没有 spawn 的房间跨房派人。
 */
export function colonyDefenders(home: Room): { target: string; count: number } | undefined {
  let best: { target: string; count: number } | undefined;

  for (const room of Object.values(Game.rooms)) {
    if (!needsColonyRelief(home, room)) continue;

    const armed = hostilesIn(room);
    if (armed.length > 0) {
      const count = Math.min(defendersNeeded(armed, home.energyCapacityAvailable), MAX_COLONY_DEFENDERS);
      if (!best || count > best.count) best = { target: room.name, count };
      continue;
    }

    if (room.find(FIND_MY_SPAWNS).length === 0 && blockedByIntruders(room)) {
      if (!best) best = { target: room.name, count: 1 };
    }
  }

  return best;
}

/** 这个房间该不该由 home 跨房驰援 */
function needsColonyRelief(home: Room, room: Room): boolean {
  if (!room.controller?.my || room.name === home.name) return false;
  if (Game.map.getRoomLinearDistance(home.name, room.name) > MAX_EXPAND_RANGE) return false;

  // 只让更强的家去支援，避免两个弱房互相派兵
  if ((home.controller?.level ?? 0) <= (room.controller.level ?? 0)) return false;

  // 有塔就自己扛
  const towered =
    room.find(FIND_MY_STRUCTURES, { filter: structure => structure.structureType === STRUCTURE_TOWER }).length > 0;
  return !towered;
}

/**
 * 给拓荒者派活（占领者由 spawnManager 单独写死分房目标）。
 *
 * 外矿铺路名额永远优先于分房/扶持：矿边没有容器时产出洒地蒸发，比分房早几天
 * 齐 extension 更亏。
 */
export function expansionAssignment(home: Room): Partial<CreepMemory> {
  const road = roadCrewTarget(home);
  if (road && pioneersHeaded(road) < ROAD_CREW) return { targetRoom: road };

  const expansion = expansionTarget(home);
  if (expansion) return { targetRoom: expansion };

  const boost = colonyBoostTarget(home);
  if (boost) return { targetRoom: boost };

  return road ? { targetRoom: road } : {};
}

/** 外矿路队还缺几个名额（已在路上的不算） */
function roadCrewGap(home: Room): number {
  const target = roadCrewTarget(home);
  if (!target) return 0;
  return Math.max(0, ROAD_CREW - pioneersHeaded(target));
}

/** 已经派去这个房间的拓荒者数量，用来在扶持和铺路之间分配名额 */
function pioneersHeaded(target: string): number {
  return Object.values(Game.creeps).filter(
    creep => creep.memory.role === "pioneer" && creep.memory.targetRoom === target
  ).length;
}

/** 占领者的孵化预算占用，给 CLI 估成本用 */
export function claimerWeight(home: Room): number {
  return partsWeight(bodyFor("claimer", home.energyCapacityAvailable).length, CLAIM_LIFETIME);
}
