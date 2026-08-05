/**
 * 孵化管理：维持每个房间各类 creep 的数量。
 * 加新角色时，改 quotaFor 和 SPAWN_PRIORITY 两处就够了，体型交给 bodyFor。
 */

import { SUPPLY_PRIORITY, logisticsOf } from "./logistics";
import { bodyFor } from "../utils/body";
import { hostilesIn } from "../roles/defender";
import { isVisualOn } from "../utils/settings";
import { log } from "../utils/logger";

/** 搬运工的基础人数，再按地上堆了多少货往上加 */
const HAULER_BASE = 2;
const HAULER_MAX = 4;

/** 积压多少能量值得多派一个搬运工 */
const BACKLOG_PER_HAULER = 1500;

/** 同时最多几个防御兵，再多也围不上同一个敌人 */
const MAX_DEFENDERS = 3;

/** 有工地时的升级工人数，压到刚够顶住降级 */
const UPGRADER_BUSY = 2;

/** 没工地时的升级工人数，能量没别处去就全推给控制器 */
const UPGRADER_IDLE = 4;

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

  return {
    defender: defenderQuota(room),
    miner: sources,
    hauler: haulerQuota(room),
    // 矿工挖的能量堆在地上，没人捡就填不进 spawn，光有矿工孵化不出下一个 creep。
    // 搬运工断档时先补一个自给自足的 harvester 把链条接上。
    harvester: counts.hauler === 0 ? 1 : 0,
    upgrader: upgraderQuota(room, sites),
    builder: sites > 0 ? 2 : 0
  };
}

/**
 * 有几个敌人就派几个兵，没敌人就一个不养。
 *
 * 入侵者要等房间累计采满十万能量才刷一次，中间隔着好几万 tick。养一支常备军
 * 意味着每 1500 tick 全额重造一遍，这笔钱拿去造 extension 早就回本了。
 *
 * 上限三个，是因为再多也挤不进入侵者所在的那一格周围，反而把能量抽干，
 * 让本该继续运转的生产线也停了。
 */
function defenderQuota(room: Room): number {
  return Math.min(hostilesIn(room).length, MAX_DEFENDERS);
}

/**
 * 升级工的人数看房间在忙什么。
 *
 * 早期收入撑不起两条战线：两个能量源加起来每 tick 才再生 20 点，而一个
 * 5 WORK 的 builder 全力施工就要烧 25 点。扩建期间把名额让给 builder，
 * 早一天建成 extension 和 container，之后每一 tick 的收入都更高。
 *
 * 但不能压到零——控制器有降级倒计时，没人续着会掉级，前面白干。
 * 工地清空之后再把人补回来，那时候能量没别的去处，全推给控制器。
 *
 * 最后再被站位数卡一道：控制器旁边站不下的人只能在外围干等，
 * 既升不了级又白吃孵化费。
 */
function upgraderQuota(room: Room, sites: number): number {
  const wanted = room.controller?.level === 8 ? RCL8_UPGRADERS : sites > 0 ? UPGRADER_BUSY : UPGRADER_IDLE;

  // 站位还没规划出来时先不封顶，那时升级工本来就是自己跑腿，不占固定位置
  const stations = room.memory.upgradeStations?.length ?? 0;
  return stations > 0 ? Math.min(wanted, stations) : wanted;
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
  // storage 里的存货不算积压，那是攒着备用的，不是等着运走的
  const backlog = logisticsOf(room)
    .supplies.filter(entry => entry.priority <= SUPPLY_PRIORITY.source)
    .reduce((sum, entry) => sum + entry.amount, 0);

  return haulersForBacklog(backlog);
}

/**
 * 缺人时的补充顺序。
 *
 * defender 排最前，因为它只在挨打时才有配额，那种时候没有比它更急的事。
 *
 * harvester 排第二不是因为它效率高，恰恰相反——它只在搬运工断档时才有配额，
 * 那种时候需要的正是一个不依赖别人、自己挖自己送的角色来重启生产链。
 * builder 排在 upgrader 前面：有工地说明正在扩建，早点建完早点受益。
 */
const SPAWN_PRIORITY: CreepRole[] = ["defender", "harvester", "miner", "hauler", "builder", "upgrader"];

export function runSpawnManager(room: Room): void {
  const spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length === 0) return;

  showSpawningProgress(spawns);

  const idleSpawn = spawns.find(spawn => !spawn.spawning);
  if (!idleSpawn) return;

  const counts = countByRole(room);
  const quota = quotaFor(room, counts);
  const role = SPAWN_PRIORITY.find(candidate => counts[candidate] < quota[candidate]);
  if (!role) return;

  spawnCreep(idleSpawn, role, isChainBroken(counts));
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
  const budget = isEmergency ? room.energyAvailable : room.energyCapacityAvailable;
  const body = bodyFor(role, budget, repeatLimitFor(room, role));
  const name = `${role}_${Game.time}`;

  const result = spawn.spawnCreep(body, name, {
    memory: { role, room: room.name, working: false }
  });

  if (result === OK) {
    log.info("孵化", `${room.name} 孵化 ${name}，体型 ${body.length} 部件${isEmergency ? "（应急）" : ""}`);
  }
}

/**
 * 房间等级会改变某些角色的最优规模，体型模板不该自己去读游戏状态，所以在这里换算。
 *
 * 满级房间的能量多到用不完，升级工可以一路堆到把控制器的每 tick 上限吃满；
 * 低等级时预算本来就堆不到那么高，用模板默认值即可。
 */
function repeatLimitFor(room: Room, role: CreepRole): number | undefined {
  if (role !== "upgrader" || room.controller?.level !== 8) return undefined;

  return RCL8_UPGRADE_WORK;
}

function countByRole(room: Room): Record<CreepRole, number> {
  const counts: Record<CreepRole, number> = {
    harvester: 0,
    upgrader: 0,
    builder: 0,
    miner: 0,
    hauler: 0,
    defender: 0
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
