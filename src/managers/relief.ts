/**
 * 接班：让下一个人在前一个死掉之前就出发。
 *
 * 等岗位空了才开始孵化，那么"孵化时间 + 走到岗位的时间"这一整段是纯断供。对
 * 矿工来说这段长得离谱：它是 5 个 WORK 配 1 个 MOVE，平地上每走一格要攒 10 点
 * 疲劳而每 tick 只消 2 点，也就是**五 tick 一格**；矿点在十格外就意味着五十 tick
 * 无人采集，再加上二十 tick 孵化，一轮寿命里白丢将近百分之五的产量。
 *
 * 做法是给"快退休的人"额外留一个配额名额：配额算的是在编人数，把即将死掉的那个
 * 仍然计入，同时把上限抬高一个，于是孵化管理器会立刻补人，两人短暂交接，老的死了
 * 名额自然收回。预定员早就在用这套，这里把它抽出来给矿工和搬运工共用。
 */

/** 一个身体部件要 3 tick，对应游戏常量 CREEP_SPAWN_TIME */
const TICKS_PER_PART = 3;

/**
 * 除了孵化和赶路之外再多留的余量。
 *
 * 能量不一定正好凑齐、spawn 可能正忙着别人、路上可能被挤一下。宁可早生几 tick
 * 让两个人短暂重叠，也不要晚生一 tick 让矿停产。
 */
const MARGIN = 20;

/** 孵化这个体型要多少 tick */
export function spawnTicks(creep: Creep): number {
  return creep.body.length * TICKS_PER_PART;
}

/**
 * 平地上走一格要几 tick。
 *
 * 疲劳规则：每走一格，每个非 MOVE 部件（装着货的 CARRY 也算）产生 2 点疲劳，
 * 每个 MOVE 每 tick 消 2 点。所以比值就是非 MOVE 数除以 MOVE 数。
 *
 * 按平地算而不按路算是故意的：估长了只会让接班的早出发几 tick，估短了就是断供。
 */
export function ticksPerStep(creep: Creep): number {
  const move = creep.body.filter(part => part.type === MOVE).length;
  if (move === 0) return Infinity;

  const load = creep.body.length - move;
  return Math.max(1, Math.ceil(load / move));
}

/**
 * 剩下的寿命只够接班的人孵化加赶路了。
 *
 * commute 是接班的人从 spawn 走到岗位要几 tick，由调用方给——只有它知道那个
 * 岗位在哪。算不出来时（比如目标房间还没侦察过）一律当它还能干：判错成"快退休"
 * 的后果是配额永久多一个名额，也就是无休止地孵化，把 spawn 时间全占了。
 */
export function isRetiring(creep: Creep, commute: number): boolean {
  const left = creep.ticksToLive;
  // 还在孵化的没有 ticksToLive，它本身就是刚补的那个
  if (left === undefined) return false;
  if (!Number.isFinite(commute)) return false;

  return left <= spawnTicks(creep) + commute + MARGIN;
}

/**
 * 房间里某个角色有几个人快退休了，配额要为他们各留一个接班名额。
 *
 * 岗位在房间内的角色（矿工、搬运工）用这个；外派角色的通勤是跨房间的，
 * 由 managers/remote 自己算。
 */
export function reliefSlots(room: Room, role: CreepRole): number {
  let slots = 0;

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role !== role || creep.memory.room !== room.name) continue;
    if (isRetiring(creep, commuteInside(room, creep))) slots++;
  }

  return slots;
}

/** 这个 creep 的岗位离 spawn 几 tick */
export function commuteInside(room: Room, creep: Creep): number {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return 0;

  const post = postOf(room, creep);
  // 没有固定岗位的（搬运工就在基地里跑）出生即上岗，只要算孵化时间
  if (!post) return 0;

  return spawn.pos.getRangeTo(post.x, post.y) * ticksPerStep(creep);
}

/** 有固定岗位的角色，它站在哪 */
function postOf(room: Room, creep: Creep): { x: number; y: number } | undefined {
  if (creep.memory.role === "miner") {
    const sourceId = creep.memory.sourceId;
    return sourceId ? room.memory.miningSpots?.[sourceId] : undefined;
  }

  if (creep.memory.role === "upgrader") return creep.memory.station;

  return undefined;
}
