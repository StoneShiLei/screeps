/**
 * 外矿管理：决定去哪些邻房采集，以及什么时候该收手。
 *
 * 外矿的账没有直觉上那么划算。中立房间的能量源容量只有 1500（自家是 3000），
 * 300 tick 再生一次，也就是 5 能量/tick，正好是自家一个源的一半；而运回来的
 * 路程是房内的好几倍。所以这里处处按"够用就好"配置，不追求吃干榨净。
 *
 * 房间的可用性只看一次就记下来：能量源位置和地形永远不变，归属虽然会变，
 * 但那是以天计的事，不值得每 tick 去查。
 */

import { CLAIM_LIFETIME, partsWeight, spawnHeadroom } from "./spawnLoad";
import { announce, log } from "../utils/logger";
import { bodyFor, maxRepeatFor } from "../utils/body";
import { commuteTo, travelTo } from "../movement/move";
import { defendersNeeded, hostilesIn, intrudersIn } from "../roles/defender";
import {
  REMOTE_ROADS_REV,
  maintainRemoteSites,
  planRemoteMiningSpots,
  planRemoteRoads,
  unbuiltRemoteContainers,
  unbuiltRemoteRoads,
  wornContainer,
  wornRoad
} from "../planner/remoteRoads";
import { ROAD_MIN_LEVEL } from "../planner/roomPlanner";
import { costMatrixFor } from "../movement/costMatrix";
import { isRetiring } from "./relief";
import { planBreach } from "../movement/breach";
import { worldRange } from "../utils/distance";

/**
 * 几级开始开外矿。
 *
 * 3 级能开，但这一级其实偏早：能量上限只有 800，运输队造不大；storage 要
 * 4 级才有，运回来的能量只能塞进 spawn、extension 和控制器容器，很容易堵。
 * 之所以还是放在 3 级，是因为再早连一个像样的矿工都派不出去。
 */
/** 几级才能开外矿；旗子认领也看这个，别让 RCL1 分房把名单抢走 */
export const REMOTE_MIN_LEVEL = 3;

/**
 * 打不过才撤人时的冷却。
 *
 * 能打过的武装（按战力 ≤ MAX_REMOTE_GUARDIANS）不进这里，改派 guardian 硬刚。
 * 打不过时再停采：入侵者寿命 1500，等它过期通常比硬刚成建制部队便宜。
 */
const RAID_COOLDOWN = 1500;

/** 外矿抗争最多派几个 guardian；再多就认栽撤人，别把老家产线填进无塔房 */
const MAX_REMOTE_GUARDIANS = 3;

/** 侦察结果的保鲜期。归属会变，但这是以天计的事，不用盯着 */
const SCOUT_REFRESH = 20000;

/** 有人驻守的外矿隔多少 tick 复查一次归属，别每 tick 都去数建筑 */
const WATCH_INTERVAL = 100;

/** 单程超过这么多格就不值得跑，运输队全耗在路上了 */
const MAX_REMOTE_DISTANCE = 90;

/** 中立房间的源：1500 容量、300 tick 再生，平均每 tick 就这么多 */
/** 中立外矿源每 tick 再生量（1500/300） */
export const NEUTRAL_SOURCE_RATE = 5;

/** 预定之后源容量恢复到 3000，产能正好翻倍，和自家房间一样 */
export const RESERVED_SOURCE_RATE = 10;

/**
 * 派往已预定外矿的矿工带几个 WORK。
 *
 * 预定把源容量抬回 3000，平均 10 能量/tick，5 个 WORK 每 tick 正好挖 10 点，
 * 和再生速度严丝合缝。再多是挖空了干等，再少则源一直溢着，白扔产能。
 *
 * 孵化那边照它定体型，矿工自己照它判断要不要给大号让位，所以放在这里共用。
 */
export const RESERVED_MINER_WORK = 5;

/**
 * 几级开始派预定员。
 *
 * 三级就能派：一个 CLAIM 加一个 MOVE 只要 650，RCL3 造出七个 extension 就够。
 * 净增为零，靠提前接班盖空窗。RCL4 预算到 1300 就上两个 CLAIM，能攒余量，
 * 也是抢预定（每 tick 削对方两点）的力气来源。
 */
const RESERVE_MIN_LEVEL = 3;

/**
 * 拆一段墙最多值得花几条命。
 *
 * 拆迁工死了进度还在（墙掉的血不会长回来），换人接着砸就行，所以不必卡在一条命
 * 之内。但也得有个头：一条命的工钱大约 700 能量，而打通之后每 tick 才多赚 5 点，
 * 三条命是本钱和回本速度都还说得过去的边界。
 */
const MAX_BREACH_LIVES = 3;

/** 同时最多几个拆迁工。拆墙纯拼血量，人多只是把同一笔钱花得更快 */
const MAX_DISMANTLERS = 1;

/** 一个 WORK 每 tick 砸 50 点血，对应游戏常量 DISMANTLE_POWER */
const DISMANTLE_PER_WORK = 50;

/** 普通 creep 的寿命，对应 CREEP_LIFE_TIME */
const LIFETIME = 1500;

/** 每趟装卸和绕路的固定开销，估运力时算进往返时间 */
const TRIP_OVERHEAD = 10;

/** 一个外矿最多派几个运输队，再多是路上排队 */
const MAX_HAULERS_PER_REMOTE = 3;

export interface RemoteSource {
  roomName: string;
  sourceId: string;
  x: number;
  y: number;
}

/** 每 tick 算一次就够：名单和限额在一个 tick 内不会变，而这份结果一 tick 要问好几遍 */
const activeCache: { tick: number; rooms: Record<string, RemoteSource[]> } = { tick: -1, rooms: {} };

/**
 * 现在该派人去采的所有外矿能量源。
 *
 * 冷却中和不可用的房间不会出现在结果里，超出等级限额的也不会，所以配额和角色
 * 逻辑都不用自己再判断一遍"这个矿现在还能不能去"。
 */
export function activeRemoteSources(home: Room): RemoteSource[] {
  if (activeCache.tick !== Game.time) {
    activeCache.tick = Game.time;
    activeCache.rooms = {};
  }

  return (activeCache.rooms[home.name] ??= collectActive(home));
}

/**
 * 这个房间还采不采得。
 *
 * `unusable` 记的是侦察时的客观结论，有任何一档都采不了。特别是"被别人预定"：
 * 游戏规则里 controller 被别的玩家预定时，harvest 直接返回 ERR_NOT_OWNER，矿工
 * 站在源边也挖不出一点。这种房间不进采集名单，但可以留在外矿名单里派预定员去
 * 抢预定（attackController 磨掉对方的 ticksToEnd）；磨归零、反手预定成自己的
 * 之后，这里才会重新放行。
 */
function isMinable(memory: RoomMemory): boolean {
  return !memory.unusable;
}

/** 名单上正被别人预定、该派预定员去磨的房间 */
function isContesting(roomName: string): boolean {
  return Memory.rooms[roomName]?.unusable === "reserved";
}

function collectActive(home: Room): RemoteSource[] {
  const found: RemoteSource[] = [];

  for (const roomName of home.memory.remotes ?? []) {
    const memory = Memory.rooms[roomName];
    if (!memory || !isMinable(memory) || isCoolingDown(memory) || needsProbe(memory)) continue;

    for (const [sourceId, spot] of Object.entries(memory.sources ?? {})) {
      found.push({ roomName, sourceId, x: spot.x, y: spot.y });
    }
  }

  // 近的排前面：分派矿工/运力时优先认近源，不截断——开得越多能量越多
  const anchor = home.memory.anchor;
  if (!anchor || found.length <= 1) return found;

  const origin = new RoomPosition(anchor.x, anchor.y, home.name);
  return found.sort((a, b) => worldRange(origin, positionOf(a)) - worldRange(origin, positionOf(b)));
}

function positionOf(source: RemoteSource): RoomPosition {
  return new RoomPosition(source.x, source.y, source.roomName);
}

/** 还在遇袭冷却期里 */
function isCoolingDown(memory: RoomMemory): boolean {
  return memory.raided !== undefined && Game.time - memory.raided < RAID_COOLDOWN;
}

/**
 * 遇袭之后要先派人看一眼才准回去。
 *
 * 冷却结束不等于安全。房间没有视野，我们只知道"1500 tick 前那里有敌人"，
 * 而冷却到点就直接补齐一整套人马的话，矿工和运输队要走几十格才发现敌人还在，
 * 然后转头就跑——一次这样的空跑要赔上上千能量的孵化费和几百 tick 的寿命，
 * 而且冷却会被重新触发，1500 tick 后再来一次，可以无限循环。
 *
 * 所以改成先派侦察兵。它 50 能量、一个 MOVE，进去看一眼就把结论带回来：
 * 清了就全员复工，没清就继续等，代价是一个最便宜的 creep。
 */
function needsProbe(memory: RoomMemory): boolean {
  if (memory.raided === undefined) return false;

  return (memory.cleared ?? 0) < memory.raided;
}

/** 遇袭过、冷却也过了、就等一个人去确认的房间 */
function probeTarget(home: Room): string | undefined {
  return (home.memory.remotes ?? []).find(roomName => {
    const memory = Memory.rooms[roomName];
    return memory !== undefined && isMinable(memory) && !isCoolingDown(memory) && needsProbe(memory);
  });
}

/** 这个外矿是不是正在冷却，面板和控制台都用它判断，免得各自记一份冷却时长 */
export function isRemotePaused(roomName: string): boolean {
  const memory = Memory.rooms[roomName];
  return memory ? isCoolingDown(memory) : false;
}

/** 预定还剩多少 tick，没预定就是 0。配额、体型和面板都看这个数 */
export function reserveLeft(roomName: string): number {
  const ends = Memory.rooms[roomName]?.reserveEnds;
  return ends === undefined ? 0 : Math.max(0, ends - Game.time);
}

/** 这个外矿的源现在是 3000 容量还是 1500 */
export function isReserved(roomName: string): boolean {
  return reserveLeft(roomName) > 0;
}

/**
 * 现在该派预定员去哪些房间。
 *
 * 两拨人：已经采得着的外矿（维持/建立自己的预定），以及名单上被别人预定着的
 * （去 attackController 抢预定）。后者采不了矿，但仍要派人——磨掉对方的预定
 * 是开矿的前提。控制器被墙圈住的两边都不派，到不了那一格。
 */
export function reserveTargets(home: Room): string[] {
  if ((home.controller?.level ?? 0) < RESERVE_MIN_LEVEL) return [];

  const minable = activeRemoteSources(home).map(entry => entry.roomName);
  const contesting = (home.memory.remotes ?? []).filter(roomName => {
    if (!isContesting(roomName)) return false;
    // 遇袭冷却期间别把带 CLAIM 的送去挨打，等清场再说
    return !isCoolingDown(Memory.rooms[roomName] ?? ({} as RoomMemory));
  });

  return [...new Set([...minable, ...contesting])].filter(roomName => !Memory.rooms[roomName]?.breach);
}

/**
 * 现在该派拆迁工去哪些房间。
 *
 * 只挑砸得动的：血量太厚的话，那点预定收益还不够付拆墙的工钱。判断标准是
 * "一条命之内拆得完"——墙不会自己长回来，所以拆到一半死了也不算白干，
 * 但要是连三条命都拆不完，这个房间还是当没预定过来用更划算。
 */
export function breachTargets(home: Room): string[] {
  const targets: string[] = [];
  const budget = breachBudget(home);

  for (const roomName of home.memory.remotes ?? []) {
    const memory = Memory.rooms[roomName];
    if (!memory?.breach?.wall || isCoolingDown(memory)) continue;

    if (memory.breach.hits <= budget) targets.push(roomName);
  }

  return targets;
}

/** 按现在造得出的拆迁工，算它几条命砸得动多少血 */
function breachBudget(home: Room): number {
  const work = bodyFor("dismantler", home.energyCapacityAvailable).filter(part => part === "work").length;
  return breachBudgetFor(work);
}

/**
 * 这么多 WORK 值得去砸多厚的墙。
 *
 * 拆墙的进度是留在墙上的，人死了换个人接着砸，所以不必卡在一条命之内；但也得有个
 * 头——一条命的工钱七百上下，而打通之后每 tick 才多赚 5 点，三条命是本钱和回本
 * 速度都还说得过去的边界。
 *
 * 拆出来的血量还能换回四分之一的能量，十几万血的墙就是三万多能量，比预定本身
 * 值钱得多。但那要给拆迁工配 CARRY、还要有人来运，先不掺进来。
 */
export function breachBudgetFor(workParts: number): number {
  return workParts * DISMANTLE_PER_WORK * LIFETIME * MAX_BREACH_LIVES;
}

/** 还没有拆迁工认领的房间 */
export function unassignedBreachTarget(home: Room): string | undefined {
  const taken = new Set<string>();
  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role === "dismantler" && creep.memory.targetRoom) taken.add(creep.memory.targetRoom);
  }

  return breachTargets(home).find(roomName => !taken.has(roomName));
}

/**
 * 同时最多派几个拆迁工。
 *
 * 一个房间一个就够：拆墙是纯粹的血量除以每 tick 伤害，多派人只是把同一笔工钱
 * 花得更快，而这几百 tick 里家里更需要孵化时间。
 */
export function dismantlerQuota(home: Room): number {
  return Math.min(breachTargets(home).length, MAX_DISMANTLERS);
}

/** 还没有预定员认领、且现在确实需要人的房间，孵化时用它决定新人去哪 */
export function unassignedReserveTarget(home: Room): string | undefined {
  const held = heldReserveTargets(home);
  const dual = canDualClaim(home);

  return reserveTargets(home).find(roomName => {
    if (held.has(roomName)) return false;
    // 双 CLAIM 守自己的预定：余量够撑过通勤就别派，和 reserverQuota 同一条尺
    if (dual && desiredReservers(home, roomName) === 0) return false;
    return true;
  });
}

/**
 * 要养几个预定员。
 *
 * 单 CLAIM（RCL3，净增为零）：每个目标一个，再给快退休的各留一个接班名额——
 * 断一 tick 预定就掉，必须赶在前任走完通勤路之前上路。
 *
 * 双 CLAIM（RCL4+，净增一）：自己的预定按余量补，不按死亡时间。余量够撑过
 * 通勤就不派人；掉到"再晚出发就过期"才补一个去顶。正在抢别人预定的房间仍要
 * 连续有人在场磨，那一档还是按退休接班。
 */
export function reserverQuota(home: Room): number {
  const targets = reserveTargets(home);
  if (targets.length === 0) return 0;

  if (!canDualClaim(home)) {
    return targets.length + retiringReservers(home, targets);
  }

  let wanted = 0;
  for (const roomName of targets) {
    wanted += desiredReservers(home, roomName);
  }
  return wanted;
}

/** 预算能不能买下两个 CLAIM。一组 claim+move = 650，RCL4 的 1300 正好两个 */
function canDualClaim(home: Room): boolean {
  return bodyFor("reserver", home.energyCapacityAvailable).filter(part => part === "claim").length >= 2;
}

/**
 * 双 CLAIM 下这个房间要几个预定员。
 *
 * 抢预定：必须有人持续 attackController，对方预定员一到又会补回去，所以按退休接班。
 * 自己的预定：按余量补，但余量告急时要提前接班——旧逻辑是"人没死就不补"，人一死
 * 再开始孵化+赶路，现场 E27S36 就出现过预定只剩 25 tick、接班的刚踩进门的断档。
 */
function desiredReservers(home: Room, roomName: string): number {
  const living = reserversFor(home, roomName);
  const retiring = living.some(creep => isRetiringReserver(creep, home));
  const fresh = living.some(creep => !isRetiringReserver(creep, home));

  if (isContesting(roomName)) {
    return 1 + (retiring ? 1 : 0);
  }

  const lead = reserveLeadTime(home, roomName);
  const left = reserveLeft(roomName);

  // 库存厚：有人就留一个继续顶高，没人就歇着吃红利
  if (left > lead) return living.length > 0 ? 1 : 0;

  // 库存告急：必须有一个还没退休的；只剩快死的就再加一个接班名额
  if (fresh) return Math.max(1, living.length);
  return 1 + (living.length > 0 ? 1 : 0);
}

/**
 * 从下单孵化到人赶到控制器，要预留多少 tick 的预定余量。
 *
 * 现场断档多半不是通勤估短了，是 spawn 排在建造/升级后面——余量掐着通勤算，
 * 前面一堵车人就过期。排队余量给足，宁可两人短暂重叠，也不要预定掉零。
 */
function reserveLeadTime(home: Room, roomName: string): number {
  const SPAWN_TICKS = 12; // 最多 4 部件
  const SPAWN_QUEUE_SLACK = 200;
  return remoteDistance(home, roomName) + SPAWN_TICKS + SPAWN_QUEUE_SLACK;
}

function reserversFor(home: Room, roomName: string): Creep[] {
  return Object.values(Game.creeps).filter(
    creep =>
      creep.memory.role === "reserver" &&
      creep.memory.room === home.name &&
      creep.memory.targetRoom === roomName
  );
}

/**
 * 还能撑一阵的预定员分别按住了哪个房间。
 *
 * 快退休的一般不占位，名额让给接班的。双 CLAIM 守自己的预定且余量仍厚时例外：
 * 那正是吃库存红利的阶段，退休了也不急着派——只在余量告急时才放开名额。
 */
function heldReserveTargets(home: Room): Set<string> {
  const held = new Set<string>();
  const dual = canDualClaim(home);

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role !== "reserver" || !creep.memory.targetRoom) continue;

    const roomName = creep.memory.targetRoom;
    if (isRetiringReserver(creep, home)) {
      const banked = dual && !isContesting(roomName) && reserveLeft(roomName) > reserveLeadTime(home, roomName);
      if (!banked) continue;
    }

    held.add(roomName);
  }

  return held;
}

function retiringReservers(home: Room, targets: string[]): number {
  const targetSet = new Set(targets);
  return Object.values(Game.creeps).filter(creep => {
    if (creep.memory.role !== "reserver" || creep.memory.room !== home.name) return false;
    if (!creep.memory.targetRoom || !targetSet.has(creep.memory.targetRoom)) return false;
    return isRetiringReserver(creep, home);
  }).length;
}

/**
 * 剩下的寿命只够走完通勤路了，接班的该出发了。
 *
 * 判断规则和房内的矿工共用一份（managers/relief），这里只负责算通勤：
 * 外派人员的岗位在别的房间，只有外矿模块知道那有多远。
 */
function isRetiringReserver(creep: Creep, home: Room): boolean {
  const target = creep.memory.targetRoom;
  if (!target) return false;

  return isRetiring(creep, remoteDistance(home, target));
}

/**
 * 需要派人去建/修外矿基础设施（矿边容器和路）的房间。
 *
 * 交给拓荒者而不是给运输队挂 WORK，是一笔算得清的账。维护本身极便宜：一格路每
 * 1000 tick 掉 100 血，一个 WORK 每 tick 修 100 血只花 1 能量，整条四十格的路线
 * 一千 tick 的衰减也就四十能量。而给运输队挂 WORK 很贵——800 预算下它现在是
 * 8C8M（400 容量），加一个 WORK 还得补一个 MOVE 才能维持满载全速，预算凑不出来，
 * 只能退成 1W 6C 7M，运力直接少四分之一。用 25% 的运力换每千 tick 40 能量的维护，
 * 账是反的。
 *
 * 建造更不适合顺手做：一格路 300 点进度，一个 WORK 每 tick 推 5 点，站着 60 tick
 * 才铺完一格，而那是运输队半个往返。容器同理。
 *
 * 拓荒者本来就会跨房间通勤、就地找能量、建造和修理；能量直接吃矿工产出，等于
 * 外矿自己出钱修自己的路和容器。容器不看老家等级，路仍按 ROAD_MIN_LEVEL 解锁。
 */
export function roadCrewTarget(home: Room): string | undefined {
  const canRoad = (home.controller?.level ?? 0) >= ROAD_MIN_LEVEL;

  for (const roomName of [...new Set(activeRemoteSources(home).map(entry => entry.roomName))]) {
    if (isRemotePaused(roomName)) continue;

    // 没视野时看不出铺没铺、磨没磨，等有人过去再说。矿工和运输队一直在那边跑，
    // 视野不会缺很久
    const room = Game.rooms[roomName];
    if (!room) continue;

    if (unbuiltRemoteContainers(room) > 0 || wornContainer(room)) return roomName;
    if (canRoad && (unbuiltRemoteRoads(room) > 0 || wornRoad(room))) return roomName;
  }

  return undefined;
}

/**
 * 外矿矿位被别人的 creep 占着、需要派协防兵清场的房间。
 *
 * 典型场面：源旁边只有一格能站（E27S36），邻居的矿工钉在我们的容器落点上，
 * 自家 remoteMiner 站在旁边却 harvest 不到。换位不可能，对方又没带武器——
 * 派一个 guardian 过去几刀解决，比停采或加 ATTACK 给矿工划算。
 *
 * 有武装敌人时不走这条：改由 remoteDefenseTarget 按战力抗争，打不过才冷却撤人。
 */
export function remoteEvictTarget(home: Room): string | undefined {
  for (const roomName of [...new Set(activeRemoteSources(home).map(entry => entry.roomName))]) {
    if (isRemotePaused(roomName)) continue;

    const room = Game.rooms[roomName];
    if (!room) continue;
    if (hostilesIn(room).length > 0) continue;

    const spots = room.memory.miningSpots ?? Memory.rooms[roomName]?.miningSpots ?? {};
    for (const spot of Object.values(spots)) {
      if (hostileOnSpot(room, spot.x, spot.y)) return roomName;
    }
  }

  return undefined;
}

/**
 * 打赢这批外矿武装要几个 guardian；打不过返回 undefined（该撤）。
 *
 * 复用 defendersNeeded：按双方出手部件折算，带奶再加一个集火余量。
 * 超过封顶就认栽——无塔外矿硬刚成建制部队是拿 creep 换 creep，老家更亏。
 */
export function remoteDefenseForce(armed: Creep[], budget: number): number | undefined {
  if (armed.length === 0) return undefined;

  const needed = defendersNeeded(armed, budget);
  if (needed > MAX_REMOTE_GUARDIANS) return undefined;
  return needed;
}

/**
 * 外矿里有可打过的武装敌人、需要派 guardian 抗争的房间。
 *
 * 和驱赶（remoteEvictTarget）分开：那边清无武装占位者，这边是真打仗。
 * 打不过的房间已经在 watchRemote 里进冷却，这里扫不到。
 */
export function remoteDefenseTarget(home: Room): { target: string; count: number } | undefined {
  let best: { target: string; count: number } | undefined;

  for (const roomName of home.memory.remotes ?? []) {
    if (Memory.rooms[roomName]?.home !== home.name) continue;
    if (isRemotePaused(roomName)) continue;

    const room = Game.rooms[roomName];
    if (!room) continue;

    const count = remoteDefenseForce(hostilesIn(room), home.energyCapacityAvailable);
    if (count === undefined) continue;
    if (!best || count > best.count) best = { target: roomName, count };
  }

  return best;
}

/** 这一格上有没有外人 */
function hostileOnSpot(room: Room, x: number, y: number): boolean {
  if (typeof room.lookForAt === "function") {
    return room.lookForAt(LOOK_CREEPS, x, y).some(creep => !creep.my);
  }

  // 测试假房间可能没 lookForAt，退回扫一遍敌对 creep
  return room
    .find(FIND_HOSTILE_CREEPS)
    .some(creep => creep.pos.x === x && creep.pos.y === y);
}

/** 还没有矿工认领的外矿源，孵化时用它决定新人去哪 */
export function unassignedRemoteSource(home: Room): RemoteSource | undefined {
  const taken = new Set<string>();
  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role === "remoteMiner" && creep.memory.sourceId) taken.add(creep.memory.sourceId);
  }

  return activeRemoteSources(home).find(entry => !taken.has(entry.sourceId));
}

/**
 * 一个外矿要几个运输队。
 *
 * 算的是"产出追不追得上运力"：源每 tick 产 5 点，运输队跑一趟的时间里源已经
 * 又攒了 5×往返 点，这些必须一趟拉完，否则地上的存货只会越堆越多。
 *
 * 拆成纯函数是因为这里最容易拍脑袋定人数，而距离和体型一变结论就变。
 */
export function haulersForRemote(sources: number, distance: number, capacity: number, rate: number): number {
  if (sources <= 0 || capacity <= 0) return 0;

  const roundTrip = distance * 2 + TRIP_OVERHEAD;
  const perTrip = sources * rate * roundTrip;

  // 向上取整而不是四舍五入。两边的代价不对称：多派一个运输队只是多摊一份孵化费，
  // 而运力差一点点会让矿工的产出一直堆在地上，堆到蒸发速度追上缺口才停——
  // 五十二格的外矿按四舍五入只派一个，运力却只有需求的七成，三成产出白扔。
  return Math.min(MAX_HAULERS_PER_REMOTE * sources, Math.max(1, Math.ceil(perTrip / capacity)));
}

/**
 * 按当前能量上限估运输队的容量。
 *
 * 体型是 CARRY 和 MOVE 一比一，所以每 100 能量买到 50 点容量；再被模板的
 * 重复上限压一道，不然高等级房间会算出一个造不出来的巨无霸。
 */
/**
 * 开这个外矿要占多少孵化预算，单位是部件当量。
 *
 * 三笔账：每个源一个矿工、按距离算出来的运输队、按住控制器的预定员。预定员只有
 * 两个部件却折算成五个当量，因为它 600 tick 就得换一个人。
 *
 * 按"预定之后"的稳态算，而不是按刚开那几百 tick 算。新房间还没预定，此刻的产能
 * 只有一半、运输队也只要一半，照那个数放行的话，等预定员一到位运力需求翻倍，
 * 预算已经超了——而外矿一旦开起来就不会因为超编再收回去。
 */
export function spawnCostOf(home: Room, roomName: string): number {
  const sources = Object.keys(Memory.rooms[roomName]?.sources ?? {}).length;
  const distance = remoteDistance(home, roomName);
  if (sources === 0 || !Number.isFinite(distance)) return Infinity;

  const budget = home.energyCapacityAvailable;
  const reserved = isReserved(roomName) || (home.controller?.level ?? 0) >= RESERVE_MIN_LEVEL;

  const minerParts = bodyFor("remoteMiner", budget, reserved ? RESERVED_MINER_WORK : undefined).length;
  const haulerParts = bodyFor("remoteHauler", budget).length;
  const rate = reserved ? RESERVED_SOURCE_RATE : NEUTRAL_SOURCE_RATE;
  const haulers = haulersForRemote(sources, distance, haulerCapacity(home), rate);

  const reserver = reserved ? partsWeight(bodyFor("reserver", budget).length, CLAIM_LIFETIME) : 0;

  return partsWeight(sources * minerParts + haulers * haulerParts) + reserver;
}

function haulerCapacity(home: Room): number {
  const pairs = Math.min(Math.floor(home.energyCapacityAvailable / 100), maxRepeatFor("remoteHauler"));
  return pairs * CARRY_CAPACITY;
}

/** 全部外矿加起来要几个运输队 */
export function remoteHaulersNeeded(home: Room): number {
  const capacity = haulerCapacity(home);
  const perRoom: Record<string, number> = {};

  for (const entry of activeRemoteSources(home)) {
    perRoom[entry.roomName] = (perRoom[entry.roomName] ?? 0) + 1;
  }

  let total = 0;
  for (const [roomName, count] of Object.entries(perRoom)) {
    // 预定过的房间产能翻倍，运力也得跟着翻，否则矿工挖出来的一半烂在地上
    const rate = isReserved(roomName) ? RESERVED_SOURCE_RATE : NEUTRAL_SOURCE_RATE;
    total += haulersForRemote(count, remoteDistance(home, roomName), capacity, rate);
  }

  return total;
}

/**
 * 挑选并维护外矿名单。
 *
 * 不设房间数硬上限：外矿越多能量越多、建设越快。真正的闸是孵化余量——
 * 排不下编制时暂缓加房；已经开着的不收回，免得人走到半路又召回。
 */
export function runRemoteManager(home: Room): void {
  const level = home.controller?.level ?? 0;
  if (level < REMOTE_MIN_LEVEL) return;

  const remotes = (home.memory.remotes ??= []);

  dropUnusable(home, remotes);

  const candidate = bestCandidate(home, remotes);
  if (!candidate) return;

  // 孵化时间是早期真正的瓶颈，能量够而孵化排不下的时候，多开一个外矿就是让
  // 家里有人死了补不上
  const cost = spawnCostOf(home, candidate);
  const headroom = spawnHeadroom(home);
  if (cost > headroom) {
    log.debug("外矿", () => `${home.name} 暂缓 ${candidate}：要 ${Math.round(cost)} 部件当量，只剩 ${Math.round(headroom)}`);
    return;
  }

  enableRemote(home, candidate);
  log.info("外矿", `${home.name} 启用外矿 ${candidate}`);
}

/**
 * 把房间写进外矿名单，并算好路和矿边容器落点。
 *
 * 旗子 / 控制台手动加外矿也走这里，免得只改了名单却忘了规划。手动那条路越过
 * 自动挑选的评分，指定一个具体房间——被别人预定的也会收进来（派预定员去抢），
 * 被别人占领 / keeper / core 那种硬打不过的仍由调用方拒绝。
 *
 * 若这个房间原先记在别的家的名单里，先从那边摘掉，避免弱分房抢走旗子之后
 * 主家再也看不见、两家 memory.home 互相覆盖。
 */
export function enableRemote(home: Room, target: string): void {
  const memory = (Memory.rooms[target] ??= {} as RoomMemory);

  if (memory.home && memory.home !== home.name) {
    const previous = Game.rooms[memory.home]?.memory.remotes;
    const index = previous?.indexOf(target) ?? -1;
    if (previous && index >= 0) previous.splice(index, 1);
  }

  const remotes = (home.memory.remotes ??= []);
  if (!remotes.includes(target)) remotes.push(target);

  memory.home = home.name;

  // 路线和落点现在就算好存着。跨房间寻路要两万 ops，只在启用这一下跑一次；
  // 容器落点要紧挨着路面，所以路先算
  planRemoteRoads(home, target);
  planRemoteMiningSpots(home, target);
}

/**
 * 把已经不能采、也不值得抢的房间踢出名单。
 *
 * 别人占领、驻进 invader core、没有源、Source Keeper 房间——这些踢出去腾名额。
 * 被别人预定的留下：那是抢预定的目标，预定员会去 attackController 磨，磨归零
 * 再反手预定，采得着之后自然回到正常外矿流程。
 *
 * 自己占下来也要踢——而且这一条只能在这里判。定期复查（surveyRoom）只对
 * 没有归属的房间跑，房间一旦归了自己，主循环就不再把它当外矿看，那份记录
 * 于是永远停在"可用"上：预定员被一趟趟派去预定自己的控制器，运输队还在把
 * 自家的能量当外矿往回搬。
 */
function dropUnusable(home: Room, remotes: string[]): void {
  for (let i = remotes.length - 1; i >= 0; i--) {
    const roomName = remotes[i];
    const memory = Memory.rooms[roomName];
    const mine = Game.rooms[roomName]?.controller?.my === true;

    // 采得着，或者正在被别人预定（留着抢）——都留在名单里
    const keep = !mine && memory && (isMinable(memory) || memory.unusable === "reserved");
    if (keep) continue;

    const reason = mine ? "已经占下来了，它自己就是个家" : (memory?.unusable ?? "没有记录");
    log.info("外矿", `${home.name} 放弃外矿 ${roomName}：${reason}`);
    delete Memory.rooms[roomName]?.home;
    remotes.splice(i, 1);
  }
}

/**
 * 从侦察过的邻房里挑最好的一个。
 *
 * 评分是"每格路程能换来几个能量源"：两个源的房间即使远一点也比一个源的近房
 * 划算，因为路程是矿工和运输队一次性的通勤成本，而能量源是持续产出。
 */
function bestCandidate(home: Room, remotes: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0;

  for (const roomName of Object.values(Game.map.describeExits(home.name) ?? {})) {
    if (!roomName || remotes.includes(roomName)) continue;
    // 自己的房间不是外矿，它有自己的矿工和搬运工
    if (Game.rooms[roomName]?.controller?.my) continue;

    const memory = Memory.rooms[roomName];
    if (!memory?.scouted || memory.unusable) continue;

    const count = Object.keys(memory.sources ?? {}).length;
    if (count === 0) continue;

    const distance = remoteDistance(home, roomName);
    if (distance > MAX_REMOTE_DISTANCE) continue;

    const score = count / distance;
    if (score > bestScore) {
      best = roomName;
      bestScore = score;
    }
  }

  return best;
}

/**
 * 从基地到外矿的大致路程，按房间里各个源的平均值算。
 *
 * 取平均而不是取最近：运输队是每个源都要跑到的，只看最近那个会低估分散型
 * 房间的成本——两个源分别在房间两头时，一趟只顺得上一边。
 *
 * 用直线距离而不是真寻路：这个数只用来排序和估人数，误差十几格不改变结论，
 * 而一次跨房寻路要几千 ops。
 *
 * 但直线距离得自己算：RoomPosition.getRangeTo 碰上别的房间只会返回 Infinity，
 * 那样每个候选房间都会撞上距离上限被剔掉，外矿一个也开不起来。
 */
function remoteDistance(home: Room, roomName: string): number {
  const anchor = home.memory.anchor;
  const sources = Object.values(Memory.rooms[roomName]?.sources ?? {});
  if (!anchor || sources.length === 0) return Infinity;

  const origin = new RoomPosition(anchor.x, anchor.y, home.name);
  let total = 0;
  for (const source of sources) {
    total += worldRange(origin, new RoomPosition(source.x, source.y, roomName));
  }

  return total / sources.length;
}

/**
 * 把当前房间的情况记进 Memory。
 *
 * 由踩进房间的 creep 调用——有视野才看得见能量源。记完之后这个房间就算侦察过，
 * 之后即使没视野也能派人。
 */
export function surveyRoom(room: Room): void {
  const memory = (Memory.rooms[room.name] ??= {});
  const sources: Record<string, { x: number; y: number }> = {};

  for (const source of room.find(FIND_SOURCES)) {
    sources[source.id] = { x: source.pos.x, y: source.pos.y };
  }

  const verdict = judge(room, sources);
  // 驻守的房间会反复复查，结论没变就别吭声，否则日志里全是同一行
  const changed = memory.scouted === undefined || memory.unusable !== verdict;

  memory.sources = sources;
  memory.scouted = Game.time;
  memory.unusable = verdict;

  if (changed) {
    log.info(
      "侦察",
      `${room.name} 能量源 ${Object.keys(sources).length} 个，${verdict ? `不可用（${verdict}）` : "可用"}`
    );
  }
}

/**
 * 有视野时顺手看一眼外矿房间。
 *
 * 由主循环调用，而不是由外派人员自己调用：非战斗 creep 撞见敌人时会先执行
 * 逃跑逻辑，角色代码根本轮不到跑，敌情就永远登记不上，配额也就一直在往
 * 一个正在被清场的房间里补人。
 */
export function watchRemote(room: Room): void {
  const memory = Memory.rooms[room.name];
  if (!memory?.home) return;

  // 只有带武器的才算遇袭。邻居的矿工运输队天天在外矿里穿，见谁都撤的话，
  // 那个房间等于自己让出去——对方一枪没放，我们的人却在冷却期里一直不去
  const home = Game.rooms[memory.home];
  const armed = hostilesIn(room);
  if (armed.length > 0) {
    const force = home ? remoteDefenseForce(armed, home.energyCapacityAvailable) : undefined;

    if (force !== undefined) {
      // 打得过：清掉可能是旧逻辑留下的冷却，派 guardian 抗争；工人贴身仍走 evade
      if (memory.raided !== undefined) {
        log.info("外矿", `${room.name} 武装可打，取消冷却、派 ${force} 个协防兵抗争`);
        delete memory.raided;
      } else {
        log.debug("外矿", () => `${room.name} 有 ${armed.length} 个武装敌人，派 ${force} 个协防兵抗争`);
      }
    } else {
      if (!isCoolingDown(memory)) {
        log.warn("外矿", `${room.name} 有 ${armed.length} 个武装敌人打不过，撤人并冷却 ${RAID_COOLDOWN} tick`);
      }
      memory.raided = Game.time;
    }
  } else {
    // 有人在场且没看见武装敌人，这就是复工需要的那个确认
    if (needsProbe(memory) && !isCoolingDown(memory)) {
      log.info("外矿", `${room.name} 已确认清场，恢复采集`);
    }
    memory.cleared = Game.time;
  }

  // 抢矿的邻居：没占我们矿位就继续采；占了唯一落点时由 remoteEvictTarget 派 guardian 清
  const rivals = intrudersIn(room).length - armed.length;
  if (rivals > 0) {
    const spots = Object.values(room.memory.miningSpots ?? memory.miningSpots ?? {});
    const squatting = spots.some(spot => hostileOnSpot(room, spot.x, spot.y));
    if (squatting) {
      log.warn("外矿", `${room.name} 矿位被邻居占着，派协防兵清场`);
    } else {
      log.debug("外矿", () => `${room.name} 有 ${rivals} 个邻居的经济单位在抢矿，继续采`);
    }
  }

  trackReservation(room, memory);

  // 趁有人在场把容器和路面工地补上。房间不归我们，runRoomPlanner 不管它
  if (home) {
    // 旧外矿可能只有路没有落点：有视野时补算一次
    if (!room.memory.miningSpots && room.memory.sources) {
      planRemoteMiningSpots(home, room.name);
    }
    // 路规划算法升级后重算一遍（比如跨房出口对齐），两万 ops 只跑一次
    if ((memory.remoteRoadsRev ?? 0) < REMOTE_ROADS_REV && memory.sources) {
      planRemoteRoads(home, room.name);
    }
    maintainRemoteSites(room, home.controller?.level ?? 0, ROAD_MIN_LEVEL);
  }

  // 归属变化和 invader core 进驻都不是急事，隔一阵子复查一次就够
  if (Game.time % WATCH_INTERVAL === 0) {
    surveyRoom(room);
    checkControllerAccess(room, memory);
  }
}

/**
 * 控制器还够不够得着。
 *
 * 前人废弃的基地常把控制器所在的凹地整个封起来，人走了墙还在。预定员到不了那一格
 * 就只能站在墙外把寿命耗完，而且一句报错都没有——寻路失败在游戏里是"尽力靠近"，
 * 看上去和正常赶路一模一样。所以这件事必须主动去查，不能等谁来报错。
 *
 * 起点用能量源：矿工能站到那儿，说明那一片是从家里走得到的。要是从源出发都到不了
 * 控制器，那预定员也一样到不了。
 *
 * 一百 tick 查一次。墙不会自己长出来，唯一会变的是被谁拆掉——包括我们自己拆掉。
 */
function checkControllerAccess(room: Room, memory: RoomMemory): void {
  const controller = room.controller;
  if (!controller || controller.owner) return;

  const source = room.find(FIND_SOURCES)[0];
  if (!source) return;

  const open = PathFinder.search(
    source.pos,
    { pos: controller.pos, range: 1 },
    { maxRooms: 1, plainCost: 2, swampCost: 10, roomCallback: () => costMatrixFor(room) }
  );

  if (!open.incomplete) {
    if (memory.breach) {
      log.info("外矿", `${room.name} 通往控制器的路通了，预定恢复`);
      delete memory.breach;
    }
    return;
  }

  const plan = planBreach(source.pos, controller.pos);
  if (!plan) {
    if (!memory.breach) log.warn("外矿", `${room.name} 的控制器拆墙也进不去，放弃预定`);
    memory.breach = { hits: 0, walls: 0 };
    return;
  }

  const wall = { x: plan.wall.pos.x, y: plan.wall.pos.y };
  const known = memory.breach?.wall;
  const sameWall = known && known.x === wall.x && known.y === wall.y;

  memory.breach = { wall, hits: plan.hits, walls: plan.walls };

  // 还是同一段墙就只更新血量，不再吼一遍。这个数每次复查都在掉，面板照着它
  // 画进度；日志只在开工和换目标时说话
  if (sameWall) return;

  log.warn(
    "外矿",
    `${room.name} 的控制器被墙封住：要拆 ${plan.walls} 段共 ${plan.hits} 血，先从 (${wall.x},${wall.y}) 开刀`
  );
}

/**
 * 把预定的到期时刻记下来。
 *
 * 只有预定员在岗时才有视野，也就只有那时候能读到准确值；之后的几百 tick 里
 * 配额和体型都靠这个快照推算，它会随时间自然过期，正好对应预定真的失效。
 */
function trackReservation(room: Room, memory: RoomMemory): void {
  const reservation = room.controller?.reservation;

  if (reservation && reservation.username === username()) {
    const ends = Game.time + reservation.ticksToEnd;
    if (memory.reserveEnds === undefined) log.info("外矿", `${room.name} 预定生效`);
    memory.reserveEnds = ends;
    return;
  }

  if (memory.reserveEnds !== undefined) {
    log.warn("外矿", `${room.name} 预定已失效`);
    delete memory.reserveEnds;
  }
}

/** 这房间到底能不能采 */
function judge(room: Room, sources: Record<string, unknown>): RoomMemory["unusable"] {
  if (Object.keys(sources).length === 0) return "none";

  // Source Keeper 守着的矿要成建制的部队才碰得动，不是这个阶段的事
  if (room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_KEEPER_LAIR }).length > 0) {
    return "keeper";
  }

  if (room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_INVADER_CORE }).length > 0) {
    return "core";
  }

  const controller = room.controller;
  if (controller?.owner && !controller.my) return "owned";

  // 别人预定时 harvest 返回 ERR_NOT_OWNER，采不了；记成 reserved 让采集名单绕开，
  // 但手动加进外矿名单的会派预定员去抢（attackController），不在这里直接放弃
  if (controller?.reservation && controller.reservation.username !== username()) return "reserved";

  return undefined;
}

function username(): string {
  const spawn = Object.values(Game.spawns)[0];
  return spawn?.owner.username ?? "";
}

/**
 * 下一个该去侦察的邻房，没有就返回 undefined。
 *
 * 只看直接相邻的房间。隔着两格的房间运输成本已经高到不划算，先不铺这张网。
 */
export function nextScoutTarget(home: Room): string | undefined {
  // 复工前的确认排在探新房前面：那边有一整套人马在等这个结论
  const probe = probeTarget(home);
  if (probe) return probe;

  const exits = Game.map.describeExits(home.name);
  if (!exits) return undefined;

  for (const roomName of Object.values(exits)) {
    if (!roomName) continue;

    const memory = Memory.rooms[roomName];
    if (!memory?.scouted) return roomName;

    // 已经判死的房间不用回访，归属变了也轮不到我们捡漏
    if (memory.unusable === "keeper" || memory.unusable === "none") continue;
    if (Game.time - memory.scouted > SCOUT_REFRESH) return roomName;
  }

  return undefined;
}

/**
 * 外派人员的共用开场：该撤就撤，不在目标房间就往那边走。
 *
 * 返回 true 表示这一 tick 已经处理完（在赶路或者在撤退），角色逻辑该直接返回。
 */
export function commuteOrFlee(creep: Creep, roomName: string): boolean {
  // 冷却期一律回家。外矿没有塔，在那边打架是拿贵的 creep 换白送的入侵者，
  // 等它自己过期便宜得多
  if (isRemotePaused(roomName)) {
    retreat(creep);
    return true;
  }

  return commuteTo(creep, roomName);
}

/** 撤回基地。身上有货的话回去正好交掉，不算白跑 */
function retreat(creep: Creep): void {
  announce(creep, "撤");

  const home = Game.rooms[creep.memory.room];
  const anchor = home?.memory.anchor;
  if (!anchor) return;

  travelTo(creep, new RoomPosition(anchor.x, anchor.y, creep.memory.room), { range: 5 });
}
