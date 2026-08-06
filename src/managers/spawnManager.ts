/**
 * 孵化管理：维持每个房间各类 creep 的数量。
 * 加新角色时，改 quotaFor 和 SPAWN_PRIORITY 两处就够了，体型交给 bodyFor。
 */

import {
  RESERVED_MINER_WORK,
  activeRemoteSources,
  dismantlerQuota,
  isReserved,
  nextScoutTarget,
  remoteHaulersNeeded,
  reserverQuota,
  unassignedBreachTarget,
  unassignedRemoteSource,
  unassignedReserveTarget
} from "./remote";
import { SUPPLY_PRIORITY, logisticsOf } from "./logistics";
import { claimerQuota, colonyDefenders, expansionAssignment, pioneerQuota } from "./expansion";
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

/** 核心建筑建完、能量没别处去时的升级工人数 */
const UPGRADER_IDLE = 4;

/** 产出被吃光、或只为顶降级时的最低编制 */
const UPGRADER_STARVED = 1;
const BUILDER_STARVED = 1;

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

  const remoteSources = activeRemoteSources(room).length;

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
    remoteMiner: remoteSources,
    remoteHauler: remoteSources > 0 ? remoteHaulersNeeded(room) : 0,
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
    // 矿工挖的能量堆在地上，没人捡就填不进 spawn，光有矿工孵化不出下一个 creep。
    // 搬运工断档时先补一个自给自足的 harvester 把链条接上。
    harvester: counts.hauler === 0 ? 1 : 0,
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

  return colonyDefenders(room)?.count ?? 0;
}

/**
 * 升级工的人数看房间在忙什么。
 *
 * 每个 RCL 先把核心建筑铺完：extension / tower / storage / 容器晚一天，整房
 * 运转差一截。建造期间升级工归零，只在快掉级时留一个顶住；核心建筑清空
 * 之后再把人补回来全力推下一级。
 *
 * 最后再被站位数卡一道：控制器旁边站不下的人只能在外围干等，
 * 既升不了级又白吃孵化费。
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

  // 粮仓满着说明运进来的比用掉的多，这时候压着人数就是让能量烂在容器里
  if (isGranaryFull(room)) return UPGRADER_IDLE;

  return UPGRADER_IDLE;
}

/**
 * 消费端已经把产出吃干了没有。
 *
 * 两个条件一起看才稳。矿边存货低于一趟运力，说明矿工挖出来的当场就被领走；粮仓
 * 同时见底，说明这不是搬运工刚好清空了一轮，而是真的一点余量都不剩。只看其中
 * 任何一个都会误判——粮仓在升级工换班的间隙也会空，矿边存货在搬运工刚取完货的
 * 那一 tick 也是零，而配额抖动的代价是人派出去又派不满，两头都不划算。
 *
 * 粮仓还没建出来时不下这个结论：那时候没有这个信号，宁可让别的闸去管。
 */
function isStarved(room: Room): boolean {
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
 * 那个容器只进不出——只有升级工从里面取——所以它满着是个很干净的信号：
 * 能量供大于求，而 storage 要 RCL4 才有，多出来的现在无处可去。
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
 * harvester 排第二不是因为它效率高，恰恰相反——它只在搬运工断档时才有配额，
 * 那种时候需要的正是一个不依赖别人、自己挖自己送的角色来重启生产链。
 *
 * builder 紧跟本土产线和协防：本级 extension / tower / storage 晚一天，整房
 * 效率差一截。拓荒和搬仓都得让路——主房建筑没铺完就去扶分房，两边都半吊子。
 *
 * 外矿那三个排在全部本土角色之后。外矿是锦上添花，家里的产线还没配齐就
 * 往外派人，等于把本来该变成 extension 的能量拿去补一条更长更脆的运输线。
 */
export const SPAWN_PRIORITY: CreepRole[] = [
  "defender",
  "harvester",
  "miner",
  "hauler",
  // 协防兵排在本土产线三件套之后：老家先保住自己的挖—运—孵化闭环，再谈驰援。
  // 它的配额本身已经卡了"老家没断链、本土没挨打"两道闸；守卫是分房唯一
  // 压过本房建造的外援——没人扛着弱房会被打穿
  "guardian",
  // 本房建造工：每个 RCL 先把核心建筑铺完，再谈升级和对外扩张
  "builder",
  // 占领者便宜且效果不可逆：700 能量换一个永久归属。排在建造之后——
  // 家里 extension 都没齐时占了新房也养不起，但比拓荒者靠前：claim 窗口会被人截胡
  "claimer",
  // 搬仓库有时间窗，但排在本房建造之后：先把家里的 extension 立起来，
  // 搬回来的能量才有地方花、有更大的孵化预算
  "looter",
  // 拓荒者：分房扶持重要，但主房建筑没铺完时配额会被压住（见 pioneerQuota），
  // 就算亮了也排在 builder 后面
  "pioneer",
  "upgrader",
  "scout",
  // 预定员排在外矿的矿工和运输队前面：它一到位，那个房间所有源的产能立刻翻倍，
  // 是整条外矿链上单位投入产出最高的一环
  "reserver",
  "remoteMiner",
  "remoteHauler",
  // 拆迁工排最后。它砸开的那段墙能让整个外矿产能翻倍，但那是几百 tick 之后的事，
  // 而排在它前面的每一个角色都是当下就在产出——真缺人的时候先补产线
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

  const role = pickSpawn(counts, quota, broken);
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
 * 常态就是照 SPAWN_PRIORITY 找第一个缺口。唯一的例外是断链：那时哪怕正挨着打，
 * 也要先把 harvester 抢救回来重启产线，而不是被排在最前的 defender 抢走那点仅剩
 * 的能量——它反正也造不出打得赢的兵，只会让房间一直卡在"孵化不出来"里空转，
 * 这正是 E28S35 死循环的另一半成因。
 */
function pickSpawn(
  counts: Record<CreepRole, number>,
  quota: Record<CreepRole, number>,
  broken: boolean
): CreepRole | undefined {
  if (broken && counts.harvester < quota.harvester) return "harvester";

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
  const body = bodyFor(role, budget, repeatLimitFor(room, role, assignment));
  const name = `${role}_${Game.time}`;

  const result = spawn.spawnCreep(body, name, {
    memory: { role, room: room.name, working: false, ...assignment }
  });

  if (result === OK) {
    const where = assignment.targetRoom ? ` 派往 ${assignment.targetRoom}` : "";
    log.info("孵化", `${room.name} 孵化 ${name}，体型 ${body.length} 部件${where}${isEmergency ? "（应急）" : ""}`);
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

  if (role === "remoteMiner") {
    const source = unassignedRemoteSource(room);
    return source ? { targetRoom: source.roomName, sourceId: source.sourceId as Id<Source> } : {};
  }

  if (role === "dismantler") {
    const target = unassignedBreachTarget(room);
    return target ? { targetRoom: target } : {};
  }

  // 分房只有一个目标，占领者和拓荒者都往那儿去，不用挑
  if (role === "claimer" || role === "pioneer") return expansionAssignment(room);
  if (role === "looter") return lootAssignment(room);

  // 协防兵在孵化那一刻就认下要去的分房；早期防御兵永远留在本土，不带 targetRoom
  if (role === "guardian") {
    const relief = colonyDefenders(room);
    return relief ? { targetRoom: relief.target } : {};
  }

  return {};
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
  const next = SPAWN_PRIORITY.find(role => counts[role] < quota[role]);

  return { next, slots };
}
