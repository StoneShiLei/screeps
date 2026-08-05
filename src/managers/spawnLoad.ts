/**
 * 孵化预算：这个房间的 spawn 到底养得起多少人。
 *
 * 早期真正的瓶颈往往不是能量而是孵化时间。一个身体部件要 3 tick，而 creep 活
 * 1500 tick，所以一个 spawn 在一轮寿命里只造得出 500 个部件——这就是常驻编制的
 * 硬上限，跟能量多少没关系。撞上之后每多派一个人，就意味着别处有人死了补不上，
 * 而且账面上一点征兆都没有：能量看着够用，人却一直缺。
 *
 * 前人在这里翻过车：有人在 RCL4 固定开三个外矿源，结果 RCL4 提前三千 tick 到，
 * RCL5 反而晚了三千 tick，因为孵化时间全被外矿吃掉，升级工排不上队。所以这个
 * 数值得实时摆出来看，而不是等哪天发现"人怎么一直不齐"再回头猜。
 */

/** 一个身体部件要几 tick，对应游戏常量 CREEP_SPAWN_TIME */
const TICKS_PER_PART = 3;

/** 普通 creep 的寿命，对应 CREEP_LIFE_TIME */
const LIFETIME = 1500;

/** 带 CLAIM 的 creep 寿命只有这么长，对应 CREEP_CLAIM_LIFE_TIME */
export const CLAIM_LIFETIME = 600;

/** 一个 spawn 在一轮寿命里造得出的部件数，也就是它养得起的常驻编制 */
export const PARTS_PER_SPAWN = LIFETIME / TICKS_PER_PART;

/**
 * 编制占到这个比例就算挤了。
 *
 * 留一成半余量而不是卡满，是因为孵化不可能排得天衣无缝：能量偶尔断一下、
 * 谁死得不巧，都会浪费掉几十 tick。卡满的结果是永远差一点，人一直不齐。
 */
export const CROWDED = 0.85;

/** 忙碌率的平滑系数，时间常数一百 tick 上下 */
const BUSY_SMOOTHING = 0.01;

export interface SpawnLoad {
  /** 现有编制折算成的部件当量 */
  parts: number;
  /** 全部 spawn 加起来养得起多少 */
  capacity: number;
  /** 实测的孵化忙碌率，0 到 1 */
  busy: number;
}

/**
 * 一批部件占多少孵化预算。
 *
 * 折算的是重造频率：带 CLAIM 的 creep 只活 600 tick，同样的体型要造两次半才
 * 盖得住普通 creep 一轮寿命，占的孵化时间就是两倍半。
 *
 * 通勤时间故意不算进来。矿工走在路上那几十 tick 源确实没人挖，但那是产出上的
 * 损失，多派人也补不回来（源边就那么一个位置），和"spawn 忙不忙"是两件事。
 */
export function partsWeight(parts: number, lifetime: number = LIFETIME): number {
  return parts * (LIFETIME / lifetime);
}

/** 维持一个现役 creep 的岗位要占多少预算 */
export function weightOf(creep: Creep): number {
  const claim = creep.body.some(part => part.type === "claim");
  return partsWeight(creep.body.length, claim ? CLAIM_LIFETIME : LIFETIME);
}

/** 每 tick 问好几遍，而一个 tick 内人口不会变 */
const cache: { tick: number; rooms: Record<string, SpawnLoad> } = { tick: -1, rooms: {} };

export function spawnLoadOf(room: Room): SpawnLoad {
  if (cache.tick !== Game.time) {
    cache.tick = Game.time;
    cache.rooms = {};
  }

  return (cache.rooms[room.name] ??= measure(room));
}

function measure(room: Room): SpawnLoad {
  let parts = 0;
  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.room === room.name) parts += weightOf(creep);
  }

  return {
    parts,
    capacity: room.find(FIND_MY_SPAWNS).length * PARTS_PER_SPAWN,
    busy: room.memory.spawnBusy ?? 0
  };
}

/** 还塞得进多少部件当量，负数表示已经超编 */
export function spawnHeadroom(room: Room): number {
  const load = spawnLoadOf(room);
  return load.capacity * CROWDED - load.parts;
}

/** 各角色分别占了多少预算，给控制台看孵化时间到底被谁吃着 */
export function loadByRole(room: Room): Partial<Record<CreepRole, number>> {
  const result: Partial<Record<CreepRole, number>> = {};

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.room !== room.name) continue;

    const role = creep.memory.role;
    result[role] = (result[role] ?? 0) + weightOf(creep);
  }

  return result;
}

/**
 * 采样孵化忙碌率。
 *
 * 编制算的是"该占多少"，这个测的是"实际占了多少"。两者对不上本身就是信号：
 * 忙碌率明显低于编制比例，说明 spawn 想造却造不出来，那是能量没跟上；
 * 忙碌率贴着满而编制还有余量，说明有人死得太勤，多半是谁在半路上被打了。
 */
export function sampleSpawnBusy(room: Room, spawns: StructureSpawn[]): void {
  if (spawns.length === 0) return;

  const busy = spawns.filter(spawn => spawn.spawning).length / spawns.length;
  room.memory.spawnBusy = smoothBusy(room.memory.spawnBusy, busy);
}

/** 指数平滑，单独拆出来是为了能不碰 Game 就测 */
export function smoothBusy(previous: number | undefined, busy: number): number {
  if (previous === undefined) return busy;

  return previous + (busy - previous) * BUSY_SMOOTHING;
}
