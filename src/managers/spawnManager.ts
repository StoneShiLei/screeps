/**
 * 孵化管理：维持每个房间各类 creep 的数量。
 * 加新角色时，改 quotaFor 和 SPAWN_PRIORITY 两处就够了，体型交给 bodyFor。
 */

import {
  NEUTRAL_SOURCE_RATE,
  RESERVED_MINER_WORK,
  RESERVED_SOURCE_RATE,
  activeRemoteSources,
  dismantlerQuota,
  isReserved,
  nextScoutTarget,
  remoteCoreTarget,
  remoteDefenseTarget,
  remoteEvictTarget,
  remoteHarvestersNeeded,
  remoteHaulersNeeded,
  reserverQuota,
  unassignedBreachTarget,
  unassignedRemoteHarvesterSource,
  unassignedRemoteSource,
  unassignedReserveTarget
} from "./remote";
import { SUPPLY_PRIORITY, logisticsOf } from "./logistics";
import {
  claimerQuota,
  colonyDefenders,
  expansionAssignment,
  expansionTarget,
  pioneerQuota
} from "./expansion";
import { hostilesIn, localDefenderCount } from "../roles/defender";
import { lootAssignment, looterQuota } from "./loot";
import { blockedByIntruders } from "./demolish";
import { bodyFor } from "../utils/body";
import { containerAt } from "../utils/structures";
import { hasCoreBuildPending } from "../planner/roomPlanner";
import { isVisualOn } from "../utils/settings";
import { log } from "../utils/logger";
import { needsDowngradeShield } from "../utils/controller";
import { reliefSlots } from "./relief";
import { sampleSpawnBusy } from "./spawnLoad";

/** 搬运工的基础人数，再按地上堆了多少货往上加 */
const HAULER_BASE = 2;
const HAULER_MAX = 4;

/** 积压多少能量值得多派一个搬运工 */
const BACKLOG_PER_HAULER = 1500;

/** 同时最多几个防御兵，再多也围不上同一个敌人 */
const MAX_DEFENDERS = 3;

/** 升级工编制硬顶：再多也站不满粮仓一圈，且收入很少撑得住 */
const UPGRADER_MAX = 4;

/** 产出被吃光、或只为顶降级时的最低编制 */
const UPGRADER_STARVED = 1;
const BUILDER_STARVED = 1;

/** 本房源每 tick 再生（3000/300），和预定外矿同速 */
const OWN_SOURCE_RATE = 10;

/**
 * 常态下升级最多吃掉收入的这一份，剩下留给 spawn / 路 / 外矿运力。
 *
 * 4 个 8 WORK 静态升级工要 32/tick，双矿只有 20——不砍编制就只能罚站等粮。
 */
const UPGRADE_SHARE = 0.55;

/** 仓里囤得多或粮仓满时可以提高份额，把余量烧成 GCL */
const UPGRADE_SHARE_SURPLUS = 0.85;

/** storage 超过这个算有盈余，可以多养几个升级工 */
const STORAGE_SURPLUS = 10000;

/** 有建造任务时的建造工人数：升级停手省下的能量正好多养一个 */
const BUILDER_BUSY = 3;

/**
 * 矿边存货低于这个数就算"挖出来当场被领走"。
 *
 * 数量级取一个搬运工一趟的运力：低于这个数，搬运工连一趟满载都装不出来，
 * 说明产出在落地的那一刻就被消费端领走了。
 */
const STARVED_BACKLOG = 500;

/** 控制器旁的粮仓低于这个数算见底，只够一个升级工烧几十 tick */
const GRANARY_LOW = 200;

/**
 * 满级之后的升级工人数和体型。
 *
 * RCL8 的控制器每 tick 最多只吃 15 点能量，超出的部分直接丢掉。所以一个
 * 15 WORK 的升级工就把上限吃满了，再派人来纯粹是站着领工资。省下来的
 * 能量该拿去造兵、囤货或者攒 GCL 开新房间。
 *
 * 人还是要留一个：满级房间降级要 20 万 tick 才见底，看着遥远，但真掉一级
 * 全房间的建筑上限跟着缩水，代价远大于养这一个人。
 */
const RCL8_UPGRADERS = 1;
const RCL8_UPGRADE_WORK = 15;


/**
 * 每个房间期望的各角色数量。
 *
 * 从第一个 creep 起就是挖运分离，不等容器建好。矿工不带 CARRY，挖出来的能量
 * 直接掉在脚下，有容器就进容器、没有就堆在地上等人捡——地上的能量每 tick
 * 只蒸发千分之一，而两个钉在矿边的矿工比三个来回跑的 harvester 快好几倍，
 * 这点损耗完全值得。
 *
 * builder 是按需的：没有工地时一个都不要，免得白吃能量。
 */
function quotaFor(room: Room, counts: Record<CreepRole, number>): Record<CreepRole, number> {
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
  const sources = room.find(FIND_SOURCES).length;
  const level = room.controller?.level ?? 0;

  const remoteSources = activeRemoteSources(room).length;
  // RCL1：跨房 harvester 自挖自送；RCL2+：remoteMiner + remoteHauler
  const earlyRemote = level < 2;
  const splitRemote = !earlyRemote && remoteSources > 0;

  return {
    defender: defenderQuota(room),
    // 远程协防：独立兵种、独立预算，老家有余裕时才去替弱小分房扛一阵
    guardian: guardianQuota(room, counts),
    // 接班名额：矿工走到矿边要几十 tick（5 个 WORK 配 1 个 MOVE，平地五 tick 一格），
    // 等它死了才开始孵化，那一整段是纯停产
    miner: sources + reliefSlots(room, "miner"),
    hauler: haulerQuota(room) + reliefSlots(room, "hauler"),
    // 侦察兵只在真有房间要探时才派，五十能量的东西不值得常备
    scout: nextScoutTarget(room) ? 1 : 0,
    remoteMiner: splitRemote ? remoteSources : 0,
    remoteHauler: splitRemote ? remoteHaulersNeeded(room) : 0,
    // 一个房间一个预定员，预定是按房间生效的，源再多也只要按住一次；
    // 换人那一趟会短暂地多出一个，接班的得赶在预定断档前走完通勤路
    reserver: reserverQuota(room),
    // 拆迁工是一次性投资：外矿的控制器被前人的墙圈住时才有配额，砸通了就归零
    dismantler: dismantlerQuota(room),
    // 分房那两个也是一次性的：占领者只要一个、按一下就退役，拓荒者等新房
    // 自己造得出人就撤。配额里已经含了孵化预算那道闸
    claimer: claimerQuota(room),
    pioneer: pioneerQuota(room),
    // 搬空前人仓库是限时的白捡收入，抢完归零
    looter: looterQuota(room),
    // 搬运工断档时先补一个本房应急 harvester；RCL1 外矿另加路程定编的跨房名额
    harvester: (counts.hauler === 0 ? 1 : 0) + (earlyRemote ? remoteHarvestersNeeded(room) : 0),
    upgrader: upgraderQuota(room, sites),
    // 产出被吃光时留一个就够：两个 builder 每 tick 烧 10 点，正好是一个能量源的
    // 全部再生量，而工地慢几百 tick 建完不影响房间存活
    builder: sites > 0 ? (isStarved(room) ? BUILDER_STARVED : BUILDER_BUSY) : 0
  };
}

/**
 * 本土早期防御兵的配额，只管自己房间，跨房驰援是 guardian 的事。
 *
 * 只打系统入侵者，且按战力折算派几个：对方常是一堆小 creep，一个满编兵抵得过
 * 好几个，照人头派会造一堆闲兵。场上有敌对玩家时直接归零——地面兵打不过玩家，
 * 硬孵只会把重启产线的能量喂掉，把自己拖进死循环，那种仗交给塔和 rampart。
 *
 * 入侵者要等房间累计采满十万能量才刷一次，中间隔着好几万 tick。养一支常备军
 * 意味着每 1500 tick 全额重造一遍，这笔钱拿去造 extension 早就回本了。
 *
 * 上限三个，是因为再多也挤不进入侵者所在的那一格周围，反而把能量抽干，
 * 让本该继续运转的生产线也停了。
 */
function defenderQuota(room: Room): number {
  const count = localDefenderCount(hostilesIn(room), room.energyCapacityAvailable, MAX_DEFENDERS);
  if (count > 0) return count;

  // 没有武装敌人，但有赖着不走的外人堵住了拆迁：destroy 见到任何敌对 creep
  // 就拒绝，而对方失去归属之后往往就地停摆，站着等老死能占一千五百 tick。
  // 派一个兵去清场比等便宜得多——它们是矿工和运输队，一个攻击部件都没有
  return blockedByIntruders(room) ? 1 : 0;
}

/**
 * 远程协防兵的配额：老家有余裕时替弱小分房扛一阵。
 *
 * 和早期防御兵彻底分开：这是"帮别人"，前提是自己先站得稳。老家自身产线断了、
 * 或者本土正在挨打，一律不外派——先把自己的火扑了。满足前提之后，派几个、派去
 * 哪，交给 colonyDefenders 按分房的敌情算。
 */
function guardianQuota(room: Room, counts: Record<CreepRole, number>): number {
  if (isChainBroken(counts)) return 0;
  if (hostilesIn(room).length > 0) return 0;

  const relief = colonyDefenders(room);
  const defend = remoteDefenseTarget(room);
  const core = remoteCoreTarget(room);
  const evict = remoteEvictTarget(room);

  // 分房驰援、外矿抗争、清核、驱赶可能同时亮且房间不同，缺口相加
  let wanted = relief?.count ?? 0;
  if (defend) {
    if (!relief || relief.target !== defend.target) wanted += defend.count;
    else wanted = Math.max(wanted, defend.count);
  }
  const tasked = new Set<string>();
  if (relief) tasked.add(relief.target);
  if (defend) tasked.add(defend.target);
  if (core && !tasked.has(core)) {
    wanted += 1;
    tasked.add(core);
  }
  if (evict && !tasked.has(evict)) wanted += 1;
  return wanted;
}

/**
 * 升级工的人数看房间在忙什么，再按可持续收入封顶。
 *
 * 每个 RCL 先把核心建筑铺完；建造期间归零，只在快掉级时留一个。
 * 核心建完后不再写死 4 人——钉站多 WORK 的静态升级工按人头线性烧能量，
 * 必须用本房+外矿收入卡编制，否则粮仓见底只能罚站。
 *
 * 最后再被站位数卡一道：控制器旁边站不下的人只能在外围干等。
 */
function upgraderQuota(room: Room, sites: number): number {
  if (room.controller?.level === 8) return RCL8_UPGRADERS;

  const wanted = desiredUpgraders(room, sites);

  // 站位还没规划出来时先不封顶，那时升级工本来就是自己跑腿，不占固定位置
  const stations = room.memory.upgradeStations?.length ?? 0;
  return stations > 0 ? Math.min(wanted, stations) : wanted;
}

function desiredUpgraders(room: Room, sites: number): number {
  // 快掉级时无论在不在建造，都得留一个人顶——掉一级建筑上限跟着缩，比慢建惨
  if (needsDowngradeShield(room)) return UPGRADER_STARVED;

  // 还在铺本级核心建筑：一个升级工都不养，能量全给 builder
  if (sites > 0 || hasCoreBuildPending(room)) return 0;

  // 产出被吃光时收到最低，别让编制卡在超编状态把矿边抽干
  if (isStarved(room)) return UPGRADER_STARVED;

  const work = Math.max(
    1,
    bodyFor("upgrader", room.energyCapacityAvailable).filter(part => part === "work").length
  );
  const surplus =
    (room.storage?.store[RESOURCE_ENERGY] ?? 0) >= STORAGE_SURPLUS || isGranaryFull(room);

  return Math.min(upgradersAffordable(upgradeIncome(room), work, surplus), UPGRADER_MAX);
}

/**
 * 按可持续收入算养得起几个升级工。
 *
 * wanted = max(1, floor(income × share / workPerCreep))
 */
export function upgradersAffordable(income: number, workPerCreep: number, surplus: boolean): number {
  const work = Math.max(1, workPerCreep);
  const share = surplus ? UPGRADE_SHARE_SURPLUS : UPGRADE_SHARE;
  return Math.max(1, Math.floor((income * share) / work));
}

/** 本房源 + 在采外矿的每 tick 再生合计 */
export function upgradeIncome(room: Room): number {
  let income = room.find(FIND_SOURCES).length * OWN_SOURCE_RATE;

  for (const entry of activeRemoteSources(room)) {
    income += isReserved(entry.roomName) ? RESERVED_SOURCE_RATE : NEUTRAL_SOURCE_RATE;
  }

  return income;
}

/**
 * 消费端已经把产出吃干了没有。
 *
 * 矿边存货低 + 粮仓见底才算吃紧。有 storage 且仓里还有余量时不算——能量进仓
 * 之后矿边 backlog 会掉、粮仓也可能低，那是物流在囤货，不是产线塌了。
 *
 * 粮仓还没建出来时不下这个结论：那时候没有这个信号，宁可让别的闸去管。
 */
function isStarved(room: Room): boolean {
  const stored = room.storage?.store[RESOURCE_ENERGY] ?? 0;
  if (stored >= GRANARY_LOW) return false;

  const granary = granaryEnergy(room);
  if (granary === undefined) return false;

  return granary < GRANARY_LOW && sourceBacklog(room) < STARVED_BACKLOG;
}

/** 控制器旁那个容器里还剩多少能量，容器还没建就返回 undefined */
function granaryEnergy(room: Room): number | undefined {
  const spot = room.memory.upgradeSpot;
  if (!spot) return undefined;

  return containerAt(room, spot.x, spot.y)?.store[RESOURCE_ENERGY];
}

/**
 * 控制器旁的容器是不是满了。
 *
 * 那个容器只进不出——只有升级工从里面取——所以它满着说明运进来的不比烧掉的少。
 * 有 storage 之后溢出进仓，这个信号仍表示升级侧吃得饱，用来维持编制即可。
 */
function isGranaryFull(room: Room): boolean {
  const spot = room.memory.upgradeSpot;
  if (!spot) return false;

  const container = containerAt(room, spot.x, spot.y);
  return container !== undefined && container.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
}

/**
 * 等着被运走的存货：地上的、废墟墓碑里的、矿边容器里的。
 *
 * storage 里的存货不算，那是攒着备用的，不是等着运走的。搬运工人数和"产出被
 * 吃光了没有"共用这一个口径，两处的判断才不会互相打脸。
 */
function sourceBacklog(room: Room): number {
  return logisticsOf(room)
    .supplies.filter(entry => entry.priority <= SUPPLY_PRIORITY.source)
    .reduce((sum, entry) => sum + entry.amount, 0);
}

/**
 * 按积压量决定派几个搬运工。
 *
 * 固定人数很难拍准：矿工体型、矿到基地的距离、房间里有没有废墟可捡，
 * 每一样都会改变运力需求。直接看"有多少货没人运"最省心，运不完就加人，
 * 搬空了自然回落。
 */
export function haulersForBacklog(backlog: number): number {
  return Math.min(HAULER_BASE + Math.floor(backlog / BACKLOG_PER_HAULER), HAULER_MAX);
}

function haulerQuota(room: Room): number {
  return haulersForBacklog(sourceBacklog(room));
}

/**
 * 缺人时的补充顺序。
 *
 * defender 排最前，因为它只在挨打时才有配额，那种时候没有比它更急的事。
 *
 * harvester 排第二：应急重启产线，以及 RCL1 跨房自挖自送。
 *
 * 本房闭环之后立刻 scout → 外矿挖运：邻房不探就自动加不了外矿；挖运再往后会被
 * 建造/升级挤掉。预定紧跟外矿挖运。协防与建造仍压过占领/拓荒/升级。
 */
export const SPAWN_PRIORITY: CreepRole[] = [
  "defender",
  "harvester",
  "miner",
  "hauler",
  // 先探邻房，自动加外矿才有候选
  "scout",
  "remoteMiner",
  "remoteHauler",
  "reserver",
  // 协防：老家闭环 + 外矿编制之后；配额本身已卡"没断链、本土没挨打"
  "guardian",
  "builder",
  "claimer",
  "looter",
  "pioneer",
  "upgrader",
  // 拆迁工排最后：砸墙回本慢，真缺人时先补产线
  "dismantler"
];

export function runSpawnManager(room: Room): void {
  const spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length === 0) return;

  showSpawningProgress(spawns);
  // 采样要赶在下面那个 return 前面：spawn 正忙的 tick 恰恰是最该记一笔的，
  // 放到后面就只统计得到空闲的那些 tick，忙碌率会永远是零
  sampleSpawnBusy(room, spawns);

  const idleSpawn = spawns.find(spawn => !spawn.spawning);
  if (!idleSpawn) return;

  const counts = countByRole(room);
  const quota = quotaFor(room, counts);
  const broken = isChainBroken(counts);

  const role = pickSpawn(counts, quota, broken, hasCoreBuildPending(room));
  if (!role) return;

  // 战斗兵绝不用应急小体型：一个凑合出来的小兵照样打不过，只是把重启产线的
  // 能量喂掉。断链时该抢救的是自给自足的 harvester，不是往火里填注定要死的兵
  spawnCreep(idleSpawn, role, broken && !isCombat(role));
}

/** 战斗兵种：本土防御和远程协防，孵化时不走应急路线 */
function isCombat(role: CreepRole): boolean {
  return role === "defender" || role === "guardian";
}

/**
 * 挑这一 tick 该孵谁。
 *
 * 常态就是照 SPAWN_PRIORITY 找第一个缺口。两个例外：
 *   1. 断链时先救 harvester——哪怕正挨着打也不让排最前的 defender 抢走仅剩的能量，
 *      它反正造不出打得赢的兵，只会让房间卡在"孵化不出来"里空转。
 *   2. 本房核心建筑还没齐时，builder 插到 remoteHauler 前面——外矿运输编制在
 *      RCL2 小体型下动辄五六个，照表排会把 extension 工地饿到永远铺不完，
 *      RCL 上不去运输体型也大不了，恶性循环。矿工照派，先把本房底座垒起来。
 */
function pickSpawn(
  counts: Record<CreepRole, number>,
  quota: Record<CreepRole, number>,
  broken: boolean,
  corePending = false
): CreepRole | undefined {
  if (broken && counts.harvester < quota.harvester) return "harvester";
  if (corePending && counts.builder < quota.builder) return "builder";

  return SPAWN_PRIORITY.find(candidate => counts[candidate] < quota[candidate]);
}

/**
 * 生产链是不是断了。
 *
 * 断链的时候必须改用"当前可用能量"造个小的：按能量上限造的大 creep 需要
 * extension 全填满才凑得齐料，而填 extension 这件事本身就得有人干，
 * 没人干就永远凑不齐，房间会一直卡在孵化不出来的状态里。
 *
 * 两条链任意一条断了都算：没人采集则能量断流，没人搬运则 extension 填不上。
 * harvester 两件事都干，所以它还活着的时候两条链都不算断。
 */
function isChainBroken(counts: Record<CreepRole, number>): boolean {
  const noHarvest = counts.harvester === 0 && counts.miner === 0;
  const noHaul = counts.harvester === 0 && counts.hauler === 0;

  return noHarvest || noHaul;
}

function spawnCreep(spawn: StructureSpawn, role: CreepRole, isEmergency: boolean): void {
  const room = spawn.room;
  const assignment = assignmentFor(room, role);
  const budget = isEmergency ? room.energyAvailable : room.energyCapacityAvailable;
  // 传入 RCL：本房 hauler/builder 在平原路解锁前（RCL<4）改用无路满速体型
  const body = bodyFor(role, budget, repeatLimitFor(room, role, assignment), room.controller?.level);
  const name = `${role}_${Game.time}`;

  const result = spawn.spawnCreep(body, name, {
    memory: { role, room: room.name, working: false, ...assignment }
  });

  if (result === OK) {
    const where = assignment.targetRoom ? ` 派往 ${assignment.targetRoom}` : "";
    log.debug("孵化", `${room.name} 孵化 ${name}，体型 ${body.length} 部件${where}${isEmergency ? "（应急）" : ""}`);
  }
}

/**
 * 外派角色在孵化那一刻就把去处定下来。
 *
 * 不留给它出生后自己挑，是因为体型要按目标房间来定：已预定的房间源容量翻倍，
 * 矿工得多带 WORK 才追得上产量。而体型在 spawnCreep 调用的瞬间就固定了，
 * 等它出生后再认领已经来不及改。
 */
function assignmentFor(room: Room, role: CreepRole): Partial<CreepMemory> {
  if (role === "reserver") {
    const target = unassignedReserveTarget(room);
    return target ? { targetRoom: target } : {};
  }

  if (role === "harvester") {
    // 搬运工断档时第一个 harvester 留本房救急，别绑外矿把产线救火的人派走
    if (needsHomeEmergencyHarvester(room)) return {};

    const source = unassignedRemoteHarvesterSource(room);
    return source ? { targetRoom: source.roomName, sourceId: source.sourceId as Id<Source> } : {};
  }

  if (role === "remoteMiner") {
    const source = unassignedRemoteSource(room);
    return source ? { targetRoom: source.roomName, sourceId: source.sourceId as Id<Source> } : {};
  }

  if (role === "dismantler") {
    const target = unassignedBreachTarget(room);
    return target ? { targetRoom: target } : {};
  }

  // 占领者只认分房目标；拓荒者还可能去外矿铺路/扶持弱房，见 expansionAssignment
  if (role === "claimer") {
    const target = expansionTarget(room);
    return target ? { targetRoom: target } : {};
  }
  if (role === "pioneer") return expansionAssignment(room);
  if (role === "looter") return lootAssignment(room);

  // 协防兵认分房驰援、外矿抗争或驱赶；早期防御兵永远留在本土，不带 targetRoom
  if (role === "guardian") {
    const targetRoom = pickGuardianTarget(room);
    return targetRoom ? { targetRoom } : {};
  }

  return {};
}

/** 搬运工断档且还没有留守本房的应急 harvester */
function needsHomeEmergencyHarvester(room: Room): boolean {
  let haulers = 0;
  let homeHarvesters = 0;

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.room !== room.name) continue;
    if (creep.memory.role === "hauler") haulers++;
    if (creep.memory.role === "harvester" && !creep.memory.targetRoom) homeHarvesters++;
  }

  return haulers === 0 && homeHarvesters === 0;
}

/**
 * 协防兵下一趟该去哪：分房驰援 → 外矿武装抗争 → 清 0 级 Invader Core → 外矿驱赶。
 *
 * 孵化认领和清场后重新派活共用这一份，免得闲兵停在分房门口、外矿却没人去打。
 */
function pickGuardianTarget(home: Room): string | undefined {
  const relief = colonyDefenders(home);
  const defend = remoteDefenseTarget(home);
  const core = remoteCoreTarget(home);
  const evict = remoteEvictTarget(home);
  const headed = (target: string) =>
    Object.values(Game.creeps).some(
      creep =>
        creep.memory.role === "guardian" &&
        creep.memory.room === home.name &&
        creep.memory.targetRoom === target
    );

  if (relief && !headed(relief.target)) return relief.target;
  if (defend && !headed(defend.target)) return defend.target;
  if (core && !headed(core)) return core;
  if (evict && !headed(evict)) return evict;
  if (relief) return relief.target;
  if (defend) return defend.target;
  if (core) return core;
  if (evict) return evict;
  return undefined;
}

/** 清场后丢掉 targetRoom 的协防兵，有新活就重新挂上 */
export function ensureGuardianDuty(creep: Creep): void {
  if (creep.memory.targetRoom) return;
  const home = Game.rooms[creep.memory.room];
  if (!home) return;

  const target = pickGuardianTarget(home);
  if (target) creep.memory.targetRoom = target;
}

/**
 * 房间状态会改变某些角色的最优规模，体型模板不该自己去读游戏状态，所以在这里换算。
 *
 * 满级房间的能量多到用不完，升级工可以一路堆到把控制器的每 tick 上限吃满；
 * 低等级时预算本来就堆不到那么高，用模板默认值即可。
 */
function repeatLimitFor(room: Room, role: CreepRole, assignment: Partial<CreepMemory>): number | undefined {
  if (role === "upgrader" && room.controller?.level === 8) return RCL8_UPGRADE_WORK;

  // 预定过的外矿源是 3000 容量、平均 10 能量/tick，3 个 WORK 每 tick 只挖 6 点，
  // 追不上再生速度，源会一直是满的——白放着一半产能不要
  if (role === "remoteMiner" && assignment.targetRoom && isReserved(assignment.targetRoom)) {
    return RESERVED_MINER_WORK;
  }

  return undefined;
}

function countByRole(room: Room): Record<CreepRole, number> {
  const counts: Record<CreepRole, number> = {
    harvester: 0,
    upgrader: 0,
    builder: 0,
    miner: 0,
    hauler: 0,
    defender: 0,
    guardian: 0,
    scout: 0,
    remoteMiner: 0,
    remoteHauler: 0,
    reserver: 0,
    dismantler: 0,
    claimer: 0,
    pioneer: 0,
    looter: 0
  };

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.room !== room.name) continue;
    // 旧版本代码留下的 creep 可能带着已经不存在的角色名
    if (creep.memory.role in counts) counts[creep.memory.role]++;
  }

  return counts;
}

function showSpawningProgress(spawns: StructureSpawn[]): void {
  if (!isVisualOn("spawn")) return;

  for (const spawn of spawns) {
    if (!spawn.spawning) continue;
    spawn.room.visual.text(`孵化中 ${spawn.spawning.name}`, spawn.pos.x + 1, spawn.pos.y, {
      align: "left",
      opacity: 0.7
    });
  }
}

/** 给控制台 quota 命令用：看各角色配额与实到人数 */
export function roomPopulation(room: Room): { counts: Record<CreepRole, number>; quota: Record<CreepRole, number> } {
  const counts = countByRole(room);
  return { counts, quota: quotaFor(room, counts) };
}

export interface SpawnSlot {
  role: CreepRole;
  count: number;
  quota: number;
  deficit: number;
}

/**
 * 按真实孵化顺序排出编制表。
 *
 * 面板和 quota() 都看这份：谁缺人、下一个造谁，和 spawn 实际挑活用的是同一条
 * SPAWN_PRIORITY，不会出现"面板说缺运、实际却在造升级工"的错位。
 */
export function spawnQueue(room: Room): { next: CreepRole | undefined; slots: SpawnSlot[] } {
  const counts = countByRole(room);
  const quota = quotaFor(room, counts);
  const slots = SPAWN_PRIORITY.filter(role => quota[role] > 0 || counts[role] > 0).map(role => ({
    role,
    count: counts[role],
    quota: quota[role],
    deficit: Math.max(0, quota[role] - counts[role])
  }));
  const next = pickSpawn(counts, quota, isChainBroken(counts), hasCoreBuildPending(room));

  return { next, slots };
}
