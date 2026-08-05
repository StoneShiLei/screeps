/**
 * 交通结算：creep 本 tick 只登记想去哪，等所有角色跑完再统一决定谁真的能动。
 *
 * 分成两步是为了处理让位。creep 各自 move 的话，谁先执行谁占便宜，后面的
 * 只能绕路——房间越窄绕得越远，几个 creep 卡在一条走廊里能互相堵上几十 tick。
 * 攒齐所有意图之后，"A 想去 B 那格、B 正想走开"这种情况一眼就能看出来，
 * 两个人同一 tick 交换位置，谁都不用绕。
 *
 * 结算用的是增广路径搜索，也就是二分图匹配那套：试着把 creep 塞进它想去的
 * 格子，塞不进就递归地请占位者让开。递归天然覆盖 A 推 B、B 推 C、C 挪进空地
 * 这种链式让位，而只会两两交换的简单版在这里就卡住了。
 */

import { costMatrixFor } from "./costMatrix";

/** 房间边缘那圈会触发换房间，让位时不能往上面推 */
const EDGE = 0;
const FAR_EDGE = 49;

/** 本 tick 谁想去哪，键是 creep 名字 */
const intents = new Map<string, RoomPosition>();

/** 声明钉死的 creep，任何人都推不动它们 */
const anchored = new Set<string>();

let currentTick = -1;

function ensureFreshTick(): void {
  if (currentTick === Game.time) return;

  currentTick = Game.time;
  intents.clear();
  anchored.clear();
}

/** 登记移动意图。目标必须与当前位置相邻，寻路那一层负责保证这点 */
export function requestMove(creep: Creep, target: RoomPosition): void {
  ensureFreshTick();
  intents.set(creep.name, target);
}

/**
 * 声明这一 tick 钉在原地不接受让位请求。
 *
 * 给的是那些位置本身就是产出的角色：矿工站在容器上挖，被挤开一格就少挖一个
 * tick，还得再走回来；升级工同理。它们让出来的那点通行便利，远不如踩着的
 * 位置值钱，所以宁可让路过的人绕。
 */
export function holdPosition(creep: Creep): void {
  ensureFreshTick();
  anchored.add(creep.name);
}

/**
 * 结算所有意图并真正发出 move。
 *
 * 必须在所有 creep 的角色逻辑跑完之后调用，否则会漏掉后面登记的意图。
 */
export function runTraffic(): void {
  ensureFreshTick();
  if (intents.size === 0) return;

  const context: Context = {
    occupied: new Map<string, Creep>(),
    claimed: new Set<string>(),
    moves: new Map<string, RoomPosition>()
  };
  for (const creep of Object.values(Game.creeps)) {
    context.occupied.set(keyOf(creep.pos), creep);
  }

  for (const name of intents.keys()) {
    const creep = Game.creeps[name];
    if (!creep || context.moves.has(name)) continue;

    // visited 存的是格子而不是 creep：同一格在一条递归链里只该被争取一次，
    // 否则两个 creep 会绕着一个环互相让位，永远递归不到底
    resolve(creep, new Set<string>(), context, false);
  }

  for (const [name, target] of context.moves) {
    const creep = Game.creeps[name];
    if (!creep || creep.pos.isEqualTo(target)) continue;

    creep.move(creep.pos.getDirectionTo(target));
  }
}

interface Context {
  /** 结算开始时每格站着谁 */
  occupied: Map<string, Creep>;
  /** 已经许给某个 creep 的格子 */
  claimed: Set<string>;
  /** 结算结果：谁移到哪 */
  moves: Map<string, RoomPosition>;
}

/**
 * 试着给 creep 安排一个落脚点，安排不下就返回 false。
 *
 * 返回 true 保证它会离开现在这格——调用方正是靠这个判断能不能进来。
 * 之所以成立，是因为进入递归前调用方已经把这格加进了 visited，
 * 被请求让位的一方挑候选时会自动跳过原地。
 *
 * forced 区分主动和被动。自己想走的只认自己那个目标，去不了就老实待着；
 * 被别人请着让位的才会退而求其次挪到旁边去。
 */
function resolve(creep: Creep, visited: Set<string>, context: Context, forced: boolean): boolean {
  for (const target of candidatesFor(creep, forced)) {
    const key = keyOf(target);
    if (visited.has(key)) continue;
    // visited 只在一条递归链里防重，跨链撞车得靠这个：两个 creep 同时挤进
    // 一格的话，游戏引擎会让两边都失败
    if (context.claimed.has(key)) continue;
    visited.add(key);

    const blocker = context.occupied.get(key);
    if (blocker && blocker !== creep && !clearOut(blocker, visited, context)) continue;

    context.moves.set(creep.name, target);
    context.claimed.add(key);
    return true;
  }

  return false;
}

/** 请占位者腾地方。已经在别的链里决定要走的就不必再动员一次 */
function clearOut(blocker: Creep, visited: Set<string>, context: Context): boolean {
  const settled = context.moves.get(blocker.name);
  if (settled) return !settled.isEqualTo(blocker.pos);

  return resolve(blocker, visited, context, true);
}

/**
 * 这个 creep 愿意去的格子，按意愿从高到低。
 *
 * 被请着让位的时候先试自己本来就想去的地方，不行才随便挪一格——反正都要动，
 * 顺路的方向白捡一步。挪开之后路径下一 tick 会重算，不怕走偏。
 */
function candidatesFor(creep: Creep, forced: boolean): RoomPosition[] {
  // 疲劳的走不动，和钉死的一样推不开，别指望它让位
  if (anchored.has(creep.name) || creep.fatigue > 0) return [creep.pos];

  const intent = intents.get(creep.name);
  // 自己想走的只认准目标那一格：去不了就在原地等下一 tick，
  // 随便挪到旁边只会离目标更远，还可能把别人的位置占了
  if (!forced) return intent ? [intent] : [];

  const alternatives = walkableNeighbors(creep);
  return intent ? [intent, ...alternatives] : alternatives;
}

/**
 * 周围能落脚的格子。
 *
 * 这里只看地形和建筑，不看有没有人站着：站着人的格子交给递归去争取，
 * 提前排除掉就没有链式让位了。
 */
function walkableNeighbors(creep: Creep): RoomPosition[] {
  const matrix = costMatrixFor(creep.room);
  const terrain = creep.room.getTerrain();
  const result: RoomPosition[] = [];

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;

      const x = creep.pos.x + dx;
      const y = creep.pos.y + dy;
      if (x <= EDGE || y <= EDGE || x >= FAR_EDGE || y >= FAR_EDGE) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      if (matrix.get(x, y) === 255) continue;

      result.push(new RoomPosition(x, y, creep.room.name));
    }
  }

  return result;
}

function keyOf(pos: RoomPosition): string {
  return `${pos.roomName},${pos.x},${pos.y}`;
}
