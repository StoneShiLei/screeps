/**
 * defender：家里进了人才孵化，打完就自然老死。
 *
 * 常备军在 Screeps 里是笔烂账——入侵者要等房间累计采够十万能量才会来一次，
 * 平时养着的兵每 1500 tick 就得重造一遍，那笔钱够多造好几个 extension。
 * 所以配额直接挂在"房间里有几个敌人"上，没敌人时是零。
 *
 * 代价是遇袭那一刻手上一个兵都没有，得现造。真正扛住第一波的是塔，
 * defender 是给塔补刀、以及三级前还没塔时的应急手段。
 */

import { announce, log } from "../utils/logger";
import { commuteTo, travelTo } from "../movement/move";
import { bodyFor } from "../utils/body";
import { costMatrixFor } from "../movement/costMatrix";
import { requestMove } from "../movement/traffic";

/** 敌人离得比这还远就先不管，省得被牵着满房间跑，离开塔的火力范围 */
const CHASE_RANGE = 20;

/**
 * 开始逃命的距离（寻路步数，不是直线）。
 *
 * 入侵者远程射程 3，再留反应和堵路余量。隔墙直线很近但绕不过来的不算威胁。
 *
 * 停逃必须更远（FLEE_CLEAR），否则刚跑出触发圈就回头干活，
 * 下一 tick 又进圈——表现为"逃着逃着就不逃了"，最后被追上磨死。
 */
const FLEE_TRIGGER = 8;

/** 撤到离所有武装敌人至少这么远（寻路）才允许停逃、恢复干活 */
const FLEE_CLEAR = 14;

/** 撤退 / 测威胁距离时一次最多算这么多步 */
const FLEE_OPS = 2000;

/**
 * 会打人的部件。
 *
 * HEAL 也算：单独一个奶妈伤不了我们，但它出现就说明这是支战斗队伍，
 * 后面跟着的才是真正要命的。
 *
 * 写字符串字面量而不是 ATTACK 那些全局常量：常量只在游戏运行时存在，
 * 模块顶层引用会让单元测试加载阶段就崩。
 */
const WEAPONS: BodyPartConstant[] = ["attack", "ranged_attack", "heal"];

/**
 * 系统 NPC 的用户名。
 *
 * 只有这些才是本土早期防御兵该打的对象：入侵者按房间累计采集量周期性刷新，
 * 体型小、来了就走，几个便宜的地面兵加塔就能收拾。Source Keeper 待在中立矿房，
 * 我们不占那种房间，列上只是把它一并归到"这不是玩家"这一类。
 */
const NPC_USERNAMES = ["Invader", "Source Keeper"];

interface RoomThreat {
  /** 带武器的敌人。逃跑、孵化防御兵、外矿撤退都只认这些 */
  armed: Creep[];
  /** 房间里所有敌对 creep，含对方的矿工和运输队 */
  all: Creep[];
  towered: boolean;
}

/**
 * 这个敌对 creep 打得死人吗。
 *
 * 分清"敌人"和"竞争者"是有代价的教训：邻居的 worker 和 transport 一个 ATTACK
 * 都没带，纯粹是去采矿运货的，而我们原来见到任何敌对 creep 就给房间记上遇袭、
 * 停 1500 tick、把全部外派人员撤回来。邻居那边天天有人路过，于是那个外矿等于
 * 被我们自己永久让了出去——对方一枪没放。
 *
 * 带 WORK 的确实能拆我们的建筑，但那是塔该管的事（一发 10 能量），不值得让
 * 整条产线停摆，更不值得放弃一个房间。
 */
function isArmed(creep: Creep): boolean {
  return creep.body.some(part => WEAPONS.includes(part.type));
}

/**
 * 本 tick 各房间的敌情。
 *
 * 遇袭时房间里每个 creep 都要问一遍"有敌人吗、有塔吗"，各自 find 一遍
 * 就是几十次全房遍历。查一次存下来，这一 tick 里谁问都是同一个答案。
 */
let threats: { tick: number; rooms: Record<string, RoomThreat> } = { tick: -1, rooms: {} };

function threatOf(room: Room): RoomThreat {
  if (threats.tick !== Game.time) threats = { tick: Game.time, rooms: {} };

  return (threats.rooms[room.name] ??= scanThreat(room));
}

function scanThreat(room: Room): RoomThreat {
  const all = room.find(FIND_HOSTILE_CREEPS);
  const armed = all.filter(isArmed);

  // 平安无事时就别去数塔了，那是全房遍历，而绝大多数 tick 都平安无事
  const towered =
    armed.length > 0 &&
    room.find(FIND_MY_STRUCTURES, { filter: structure => structure.structureType === STRUCTURE_TOWER }).length > 0;

  return { armed, all, towered };
}

/** 带武器的敌人。配额和撤退判断用这个 */
export function hostilesIn(room: Room): Creep[] {
  return threatOf(room).armed;
}

/** 房间里全部敌对 creep，包括手无寸铁的矿工运输队。塔照打不误，反正一发才 10 能量 */
export function intrudersIn(room: Room): Creep[] {
  return threatOf(room).all;
}

/**
 * 打赢这批敌人要派几个兵。
 *
 * 不再一个敌人配一个兵——对方的 creep 往往比我们的小，一个满编 defender 的火力
 * 能盖过好几个杂兵，照人头派兵会造出一堆闲着的。改按战力折算：把双方"能出手
 * 的部件"（攻击、远程、治疗）各算一分，敌方总战力除以我方一个兵的战力向上取整，
 * 才是真正压得过对面的头数。
 *
 * 敌方带治疗时再加一个：治疗会把分散的伤害奶回去，得多一个兵集火才压得过它的
 * 回血。这一个是"够不够快打死"的余量，前面那道除法只保证"打不打得过"。
 *
 * budget 是负责孵化的那个房间的可用能量——本土防守用本房的，跨房驰援用老家的，
 * 因为兵是从那里造出来的，战力也就照那里的体型算。
 */
export function defendersNeeded(hostiles: Creep[], budget: number): number {
  if (hostiles.length === 0) return 0;

  const enemyPower = hostiles.reduce((sum, hostile) => sum + combatParts(hostile.body.map(part => part.type)), 0);
  const ownPower = Math.max(1, combatParts(bodyFor("defender", budget)));

  const healed = hostiles.some(hostile => hostile.body.some(part => part.type === "heal"));
  return Math.ceil(enemyPower / ownPower) + (healed ? 1 : 0);
}

/** 能在战斗里出手的部件数，TOUGH 那种纯血包不算火力 */
function combatParts(body: BodyPartConstant[]): number {
  return body.filter(part => WEAPONS.includes(part)).length;
}

/** 这个敌人是不是敌对玩家的（不是系统 NPC） */
function isPlayer(creep: Creep): boolean {
  return !NPC_USERNAMES.includes(creep.owner?.username ?? "");
}

/**
 * 还有没有能出手的部件。
 *
 * ATTACK 被啃光的兵是走的尸体：部件不会再长回来（renew 也补不回被打掉的部件），
 * 站在那儿既打不动人、又占着编制让替补孵不出来。判据是"身上还有没有 hits>0 的
 * 武器部件"，PART_ORDER 把 TOUGH 垫在最前、ATTACK 在后，所以血包掉光才轮到它。
 */
export function stillArmed(creep: Creep): boolean {
  return creep.body.some(part => WEAPONS.includes(part.type) && part.hits > 0);
}

/**
 * 缴械了就自尽。
 *
 * 这是"没治疗、攻击件被打光还赖着不走"的解法：我们走的是廉价一次性防御兵、
 * 全靠塔兜底的路子，加治疗凑小队是另一套复杂度，不划算。让残废的兵退场，
 * 腾出编制让 spawn 立刻补一个满编的，比养着一具走不动刀的空壳强。
 */
function retireIfDisarmed(creep: Creep): boolean {
  if (stillArmed(creep)) return false;

  announce(creep, "缴械");
  creep.suicide();
  return true;
}

/**
 * 本土早期防御兵该孵几个。这一步只管"该不该打、打几个"，不含跨房驰援。
 *
 * 只打系统入侵者：早期防御兵是为周期性刷新的 NPC 准备的应急手段，那种小体型的
 * 波次几个便宜兵加塔就能压住。一旦场上有敌对玩家的武装单位，就直接返回零——
 * 玩家的兵又大又会集火，我们现造的地面兵冲上去只是给对方送经验、把重启产线的
 * 能量白白喂掉，反而拖垮自己（E28S35 那次死循环就是这么来的）。真打玩家是塔和
 * rampart 的事，扛不住就认赔，而不是拿 spawn 一直往火里填人。
 *
 * 认得出是 NPC 的前提下，再按战力折算需要几个，最后被 cap 封顶。
 */
export function localDefenderCount(hostiles: Creep[], budget: number, cap: number): number {
  if (hostiles.length === 0) return 0;
  if (hostiles.some(isPlayer)) return 0;

  return Math.min(defendersNeeded(hostiles, budget), cap);
}

/**
 * 本土早期防御兵：就在自己房间里迎战，不跨房。
 *
 * 它的配额只在本房挨 NPC 入侵时才亮（见 localDefenderCount），所以这里不需要
 * 再判断该不该打，直接找目标开打就是。
 */
export function runDefender(creep: Creep): void {
  if (retireIfDisarmed(creep)) return;

  fight(creep);
}

/**
 * 远程协防兵：从老家孵出来，先赶到分房，清完场就地转为驻守。
 *
 * 和早期防御兵是两个兵种、两套账：早期防御兵守本土、只打 NPC；协防兵是老家有
 * 余裕时派去替弱小分房扛一阵的远征力量。战斗动作两者共用 fight，区别只在这一
 * 步跨房通勤。
 */
export function runGuardian(creep: Creep): void {
  if (retireIfDisarmed(creep)) return;
  if (dispatch(creep)) return;

  fight(creep);
}

function fight(creep: Creep): void {
  // 优先打带武器的，剩下的经济单位随手清理——先解决打得死人的那些
  const threat = threatOf(creep.room);
  const hostiles = threat.armed.length > 0 ? threat.armed : threat.all;
  const target = creep.pos.findClosestByRange(hostiles);

  // 追击距离的限制只在有塔的房间才成立：那条绳子拴的是"别离开火力掩护"。
  // 没有塔的房间（刚占下的分房就是）没有掩护可言，追出去二十格和站在原地
  // 一样安全，而不追就等于白派了一个兵——它会在门口一直站到老死。
  const tooFar = threat.towered && target && creep.pos.getRangeTo(target) > CHASE_RANGE;

  if (!target || tooFar) {
    rally(creep);
    return;
  }

  announce(creep, "迎战");

  // 先打再走：攻击不看这一 tick 有没有移动，够得着就先削一刀
  if (creep.attack(target) === ERR_NOT_IN_RANGE) {
    travelTo(creep, target.pos, { range: 1, visualizePathStyle: { stroke: "#ff4444" } });
  }
}

/**
 * 远征清场：被派去别的房间时先赶过去，返回 true 表示这一 tick 都在路上。
 *
 * 用途是给还没有 spawn 的分房清场——那里没有塔也造不出兵，而赖着不走的外人
 * 会让 destroy 一直失败，整座前人基地就一直占着建筑上限。
 *
 * 清空之后把目标忘掉，就地转成本土守卫：它还剩不少寿命，站在新家门口守着
 * 比跑回老家有用。
 */
function dispatch(creep: Creep): boolean {
  const target = creep.memory.targetRoom;
  if (!target) return false;

  if (creep.room.name === target) {
    if (intrudersIn(creep.room).length > 0) return false;

    log.info("防御", `${target} 已清场，${creep.name} 转为驻守`);
    delete creep.memory.targetRoom;
    return false;
  }

  announce(creep, "驰援");
  return commuteTo(creep, target);
}

/**
 * 没仗打时回 spawn 边上待着。
 *
 * 待在门口而不是原地不动，是因为入侵者是冲着 spawn 来的，在那儿等
 * 等于站在必经之路上。
 */
function rally(creep: Creep): void {
  announce(creep, "待命");

  const post = rallyPoint(creep.room);
  if (post) travelTo(creep, post, { range: 3 });
}

/**
 * 待命的地方。
 *
 * spawn 是首选，因为入侵者冲的就是它。但不能只认 spawn：刚占下的分房里前主人的
 * spawn 已经拆掉、我们自己的还是个工地，那时候 `find(FIND_MY_SPAWNS)` 是空的，
 * 而原来的写法遇到空就直接返回——被派去清场的兵会在进门那几格站到老死。
 *
 * 退而认锚点：那是未来的基地中心，也是新房间里最该守的地方。
 */
function rallyPoint(room: Room): RoomPosition | undefined {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (spawn) return spawn.pos;

  const anchor = room.memory.anchor;
  if (anchor) return new RoomPosition(anchor.x, anchor.y, room.name);

  return room.controller?.pos;
}

/**
 * 没塔的时候让非战斗 creep 躲远点。返回 true 表示这一 tick 它只顾逃命。
 *
 * 三级之前房间是没有塔的，一个矿工站在原地被入侵者慢慢磨死，损失的不只是
 * 那 550 能量，还有它本该挖出来的几千点。跑开虽然也停产，但人还在。
 *
 * 有塔之后就不躲了：塔的火力比 creep 的命值钱得多，把敌人引到塔下才是对的，
 * 何况满房间乱跑还会把交通搅乱。
 */
export function evade(creep: Creep): boolean {
  const threat = threatOf(creep.room);
  if (threat.armed.length === 0 || threat.towered) {
    delete creep.memory.fleeing;
    return false;
  }

  const nearest = nearestArmedWalkRange(creep.pos, threat.armed, creep.room);
  if (!shouldKeepFleeing(nearest, Boolean(creep.memory.fleeing))) {
    delete creep.memory.fleeing;
    return false;
  }

  creep.memory.fleeing = true;
  announce(creep, "逃");
  // 逃跑路线和平时的路径缓存冲突，留着下 tick 会被当成还在原路上走
  delete creep.memory.travel;

  // 目标是全部武装敌人，不是只躲最近那个——否则会从 A 身边逃进 B 怀里
  const escape = PathFinder.search(
    creep.pos,
    threat.armed.map(hostile => ({ pos: hostile.pos, range: FLEE_CLEAR })),
    {
      flee: true,
      maxOps: FLEE_OPS,
      plainCost: 2,
      swampCost: 10,
      roomCallback: name => (name === creep.room.name ? costMatrixFor(creep.room) : false)
    }
  );

  const step = escape.path[0] ?? stepAway(creep.pos, threat.armed);
  if (step) requestMove(creep, step);
  return true;
}

/**
 * 离最近武装敌人的寻路距离。
 *
 * 直线距离是下界：已到安全线外就不必寻路；贴身（≤1）也同 getRangeTo。
 * 中间那段才 PathFinder——隔墙绕不过去时是 Infinity，不会误触发逃命。
 */
export function nearestArmedWalkRange(
  from: RoomPosition,
  armed: { pos: RoomPosition }[],
  room: Room
): number {
  let best = Infinity;

  for (const hostile of armed) {
    const straight = from.getRangeTo(hostile.pos);
    if (straight >= best) continue;

    if (straight <= 1) {
      best = straight;
      continue;
    }

    // 走路 ≥ 直线：直线已在安全线外，不必再算
    if (straight >= FLEE_CLEAR) {
      best = straight;
      continue;
    }

    const walked = walkRangeTo(from, hostile.pos, room);
    if (walked < best) best = walked;
  }

  return best;
}

/** 两点之间的寻路格数（与 getRangeTo 同口径）；走不到就是 Infinity */
function walkRangeTo(from: RoomPosition, to: RoomPosition, room: Room): number {
  const straight = from.getRangeTo(to);
  if (straight <= 1) return straight;

  const result = PathFinder.search(
    from,
    { pos: to, range: 1 },
    {
      maxOps: FLEE_OPS,
      maxRooms: 1,
      plainCost: 1,
      swampCost: 1,
      roomCallback: name => (name === room.name ? costMatrixFor(room) : false)
    }
  );

  return walkRangeFromSearch(straight, result.path.length, result.incomplete);
}

/**
 * 把寻路结果折成距离。path 不含起点；goal range=1 时 length+1 ≈ 开阔地 getRangeTo。
 */
export function walkRangeFromSearch(straight: number, pathLength: number, incomplete: boolean): number {
  if (straight <= 1) return straight;
  if (incomplete) return Infinity;
  return pathLength + 1;
}

/** 离最近武装敌人的直线距离；邻格逃命评分用，不认墙 */
export function nearestArmedRange(from: RoomPosition, armed: { pos: RoomPosition }[]): number {
  let best = Infinity;
  for (const hostile of armed) {
    const range = from.getRangeTo(hostile.pos);
    if (range < best) best = range;
  }
  return best;
}

/**
 * 逃命滞回：进了触发圈就开始逃，撤出安全圈才停。
 *
 * 单阈值会抖——刚到安全线外一格就回去干活，敌人一步跟上来又触发，
 * 来回晃几下就被贴身。
 */
export function shouldKeepFleeing(nearest: number, wasFleeing: boolean): boolean {
  if (nearest <= FLEE_TRIGGER) return true;
  if (wasFleeing && nearest < FLEE_CLEAR) return true;
  return false;
}

/** PathFinder 没给出下一步时，朝离敌人更远的邻格硬挪一步 */
function stepAway(from: RoomPosition, armed: { pos: RoomPosition }[]): RoomPosition | undefined {
  let best: RoomPosition | undefined;
  let bestScore = nearestArmedRange(from, armed);

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = from.x + dx;
      const y = from.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;

      const terrain = Game.map.getRoomTerrain(from.roomName).get(x, y);
      if (terrain === TERRAIN_MASK_WALL) continue;

      const next = new RoomPosition(x, y, from.roomName);
      const score = nearestArmedRange(next, armed);
      if (score > bestScore) {
        best = next;
        bestScore = score;
      }
    }
  }

  return best;
}

/**
 * 敌情播报，给主循环用。数量变了才吭声，不然一千多 tick 全是同一行。
 *
 * 记进 Memory 的是带武器的那些，因为读它的地方（配额、面板）问的都是
 * "要不要打"。手无寸铁的邻居单独提一句就够——那是竞争，不是战争。
 */
export function reportThreat(room: Room): void {
  const threat = threatOf(room);
  const count = threat.armed.length;
  const previous = room.memory.threat ?? 0;
  if (count === previous) return;

  room.memory.threat = count;
  if (count > 0) {
    const unarmed = threat.all.length - count;
    log.warn("防御", `${room.name} 出现 ${count} 个武装敌人${unarmed > 0 ? `，另有 ${unarmed} 个经济单位` : ""}`);
  } else {
    log.info("防御", `${room.name} 武装敌人清空${threat.all.length > 0 ? `，还有 ${threat.all.length} 个邻居在场` : ""}`);
  }
}
