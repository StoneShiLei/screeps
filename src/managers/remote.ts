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
import { hostilesIn, intrudersIn } from "../roles/defender";
import { costMatrixFor } from "../movement/costMatrix";
import { planBreach } from "../movement/breach";
import { worldRange } from "../utils/distance";

/**
 * 几级开始开外矿。
 *
 * 3 级能开，但这一级其实偏早：能量上限只有 800，运输队造不大；storage 要
 * 4 级才有，运回来的能量只能塞进 spawn、extension 和控制器容器，很容易堵。
 * 之所以还是放在 3 级，是因为再早连一个像样的矿工都派不出去。
 */
const REMOTE_MIN_LEVEL = 3;

/**
 * 各等级最多同时开几个外矿房间。
 *
 * 限额跟着能量上限走，而不是跟着"附近有几个空房"走。3 级时一个外矿就能把
 * 运输队的预算吃满，开两个只会让两边都缺人，两个矿都堆在地上蒸发。
 */
const REMOTE_LIMIT: Record<number, number> = { 3: 1, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4 };

/**
 * 各等级最多同时采几个外矿能量源。
 *
 * 真正花钱的是源而不是房间：一个房间里两个源就是两套矿工加两倍运力，而它们
 * 常常分散在房间两端，运输队一趟只顺得上一边。三级时这笔开销够造一个
 * extension，为了外矿把扩建停下来是笔亏账，所以先只采最近的那一个。
 */
const REMOTE_SOURCE_LIMIT: Record<number, number> = { 3: 1, 4: 2, 5: 4, 6: 6, 7: 8, 8: 8 };

/**
 * 撞见敌人后停多久。
 *
 * 入侵者的寿命是 1500 tick，等它自己过期比派兵去打便宜得多——外矿没有塔，
 * 在那边打架等于拿 creep 换 creep，而我们的 creep 更贵。
 */
const RAID_COOLDOWN = 1500;

/** 侦察结果的保鲜期。归属会变，但这是以天计的事，不用盯着 */
const SCOUT_REFRESH = 20000;

/** 有人驻守的外矿隔多少 tick 复查一次归属，别每 tick 都去数建筑 */
const WATCH_INTERVAL = 100;

/** 单程超过这么多格就不值得跑，运输队全耗在路上了 */
const MAX_REMOTE_DISTANCE = 90;

/** 中立房间的源：1500 容量、300 tick 再生，平均每 tick 就这么多 */
const NEUTRAL_SOURCE_RATE = 5;

/** 预定之后源容量恢复到 3000，产能正好翻倍，和自家房间一样 */
const RESERVED_SOURCE_RATE = 10;

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
 * 三级就能派，因为一个 CLAIM 加一个 MOVE 只要 650 能量，RCL3 造出七个 extension
 * 就够了。净增为零的预定员照样让房间处于"被预定"状态，源容量就是 3000——攒余量
 * 只对换人的空窗有意义，而空窗可以靠提前孵化接班的人来盖。
 *
 * 这也是目前跑得最快的那批 bot 的做法：抢在 RCL3 就把外矿产能翻倍，而不是等到
 * RCL4 才凑得出两个 CLAIM 的大号。
 */
const RESERVE_MIN_LEVEL = 3;

/**
 * 提前多少 tick 孵化接班的预定员。
 *
 * 带 CLAIM 的 creep 只活 600 tick，而通勤要花掉一截。等在岗的死了才开始造下一个，
 * 那么整段通勤时间里房间都是没预定的状态；源的容量是在再生那一刻定的，断档正好
 * 撞上再生，那一轮就白少 1500 能量。
 *
 * 余量给到二十 tick：够孵化（五个部件以内）加上几 tick 的能量凑齐时间。
 */
const RELIEF_MARGIN = 20;

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

function collectActive(home: Room): RemoteSource[] {
  const found: RemoteSource[] = [];

  for (const roomName of home.memory.remotes ?? []) {
    const memory = Memory.rooms[roomName];
    if (!memory || memory.unusable || isCoolingDown(memory) || needsProbe(memory)) continue;

    for (const [sourceId, spot] of Object.entries(memory.sources ?? {})) {
      found.push({ roomName, sourceId, x: spot.x, y: spot.y });
    }
  }

  const limit = REMOTE_SOURCE_LIMIT[home.controller?.level ?? 0] ?? 0;
  if (found.length <= limit) return found;

  // 超额时留近的：远的那个源要另配一整套人马，产出却一点不多
  const anchor = home.memory.anchor;
  if (!anchor) return found.slice(0, limit);

  const origin = new RoomPosition(anchor.x, anchor.y, home.name);
  return found
    .sort((a, b) => worldRange(origin, positionOf(a)) - worldRange(origin, positionOf(b)))
    .slice(0, limit);
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
    return memory !== undefined && !memory.unusable && !isCoolingDown(memory) && needsProbe(memory);
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
 * 预定把源容量从 1500 抬回 3000，一个源就多出 5 能量/tick，而预定员摊到寿命上
 * 是 2.2 能量/tick——单源房间也划得来，双源房间等于白捡一倍产出。所以只要够得着
 * 就全预定，不再按房间挑。
 */
export function reserveTargets(home: Room): string[] {
  if ((home.controller?.level ?? 0) < RESERVE_MIN_LEVEL) return [];

  return [...new Set(activeRemoteSources(home).map(entry => entry.roomName))].filter(
    // 控制器被墙圈住的房间先不派人。预定员到不了那一格，派过去就是站在墙外
    // 把 600 tick 的寿命耗光，还白占一个人口名额
    roomName => !Memory.rooms[roomName]?.breach
  );
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

/** 还没有预定员认领的房间，孵化时用它决定新人去哪 */
export function unassignedReserveTarget(home: Room): string | undefined {
  const held = heldReserveTargets(home);
  return reserveTargets(home).find(roomName => !held.has(roomName));
}

/**
 * 要养几个预定员。
 *
 * 每个目标房间一个，再给快退休的那些各留一个名额：它们还活着，还占着人口数，
 * 名额不多留就要等它们死了才开始孵化，而那时候接班的还得走完通勤路。
 */
export function reserverQuota(home: Room): number {
  const targets = reserveTargets(home);
  if (targets.length === 0) return 0;

  return targets.length + retiringReservers(home);
}

/** 还能撑一阵的预定员分别按住了哪个房间。快退休的不算，名额得让给接班的 */
function heldReserveTargets(home: Room): Set<string> {
  const held = new Set<string>();

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role !== "reserver" || !creep.memory.targetRoom) continue;
    if (isRetiring(creep, home)) continue;

    held.add(creep.memory.targetRoom);
  }

  return held;
}

function retiringReservers(home: Room): number {
  return Object.values(Game.creeps).filter(
    creep => creep.memory.role === "reserver" && creep.memory.room === home.name && isRetiring(creep, home)
  ).length;
}

/** 剩下的寿命只够走完通勤路了，接班的该出发了 */
function isRetiring(creep: Creep, home: Room): boolean {
  const target = creep.memory.targetRoom;
  if (!target) return false;

  const left = creep.ticksToLive;
  // 还在孵化的没有 ticksToLive，它本身就是刚派出去的那个
  if (left === undefined) return false;

  // 距离算不出来时一律当它还能干。判成快退休的后果是配额永久多一个名额，
  // 也就是无休止地孵化预定员，把 spawn 时间全占了
  const commute = remoteDistance(home, target);
  if (!Number.isFinite(commute)) return false;

  return left <= commute + RELIEF_MARGIN;
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
 * 只在需要的时候跑：名单满了就什么都不做，所以稳定期这个函数几乎不花钱。
 */
export function runRemoteManager(home: Room): void {
  const level = home.controller?.level ?? 0;
  if (level < REMOTE_MIN_LEVEL) return;

  const limit = REMOTE_LIMIT[level] ?? 0;
  const remotes = (home.memory.remotes ??= []);

  dropUnusable(home, remotes);
  if (remotes.length >= limit) return;

  const candidate = bestCandidate(home, remotes);
  if (!candidate) return;

  // 孵化时间是早期真正的瓶颈，能量够而孵化排不下的时候，多开一个外矿就是让
  // 家里有人死了补不上。已经开着的不因为超编收回——那会来回抖动，人派出去
  // 走到半路又召回，两头的钱都白花
  const cost = spawnCostOf(home, candidate);
  const headroom = spawnHeadroom(home);
  if (cost > headroom) {
    log.debug("外矿", () => `${home.name} 暂缓 ${candidate}：要 ${Math.round(cost)} 部件当量，只剩 ${Math.round(headroom)}`);
    return;
  }

  remotes.push(candidate);
  Memory.rooms[candidate].home = home.name;
  log.info("外矿", `${home.name} 启用外矿 ${candidate}`);
}

/**
 * 把已经不能采的房间踢出名单。
 *
 * 别人来占了、来预定了、驻进了 invader core 都算。踢出去之后名额空出来，
 * 下一轮自然会挑别的房间补上。
 */
function dropUnusable(home: Room, remotes: string[]): void {
  for (let i = remotes.length - 1; i >= 0; i--) {
    const memory = Memory.rooms[remotes[i]];
    if (memory && !memory.unusable) continue;

    log.warn("外矿", `${home.name} 放弃外矿 ${remotes[i]}：${memory?.unusable ?? "没有记录"}`);
    delete Memory.rooms[remotes[i]]?.home;
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
  const armed = hostilesIn(room);
  if (armed.length > 0) {
    if (!isCoolingDown(memory)) {
      log.warn("外矿", `${room.name} 有 ${armed.length} 个武装敌人，撤人并冷却 ${RAID_COOLDOWN} tick`);
    }
    memory.raided = Game.time;
  } else {
    // 有人在场且没看见武装敌人，这就是复工需要的那个确认
    if (needsProbe(memory) && !isCoolingDown(memory)) {
      log.info("外矿", `${room.name} 已确认清场，恢复采集`);
    }
    memory.cleared = Game.time;
  }

  // 抢矿的邻居只记一笔，不撤人。真要赶走它得靠塔或者兵，那是另一回事
  const rivals = intrudersIn(room).length - armed.length;
  if (rivals > 0) {
    log.debug("外矿", () => `${room.name} 有 ${rivals} 个邻居的经济单位在抢矿，继续采`);
  }

  trackReservation(room, memory);

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

  // 别人预定的房间照采是能采，但那是明摆着抢，而且他的 creep 就在旁边
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
