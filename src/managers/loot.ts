/**
 * 搬空别人留下的仓库。
 *
 * 无主房间里常留着前人整座基地。人走了，控制器降级归零，房间里所有建筑就此
 * 失效——塔打不了人，terminal 发不了货，spawn 造不出人——但**存货还在**，
 * 而且规则明确允许外人取：withdraw 对敌方建筑有效，只要上面没有 rampart 盖着。
 *
 * 这是全游戏性价比最高的一笔收入。隔壁 E28S35 的 terminal 里躺着 84000 能量，
 * 而我们两个源满负荷也就每 tick 20 点——那一个 terminal 相当于四千多 tick 的
 * 全部产出，走过去取就行，不用打，不用占，不用等再生。
 *
 * 唯一的成本是运力和时间，唯一的对手是同样看得见这批货的邻居。所以配额按
 * "还剩多少"算，抢完就自动收摊。
 */

import { partsWeight, spawnHeadroom } from "./spawnLoad";
import { bodyFor } from "../utils/body";
import { log } from "../utils/logger";

/**
 * 会存东西、又值得跑一趟的建筑类型。
 *
 * 故意不含 container：容器没有归属字段，谁都能用，我们自己矿边那几个正是这个
 * 类型——把它算成战利品，搬运工就会去掏自家的矿。真正的战利品都是有主的建筑。
 */
const LOOT_TYPES: StructureConstant[] = ["terminal", "storage", "spawn", "tower", "link", "lab", "factory"];

/**
 * 最多派几个搬运工，取决于家里放不放得下。
 *
 * 有 storage 是分水岭。没有它的时候，运回来的能量只能进 spawn、extension 和
 * 控制器容器，加起来几千点就满了，之后的出口只有升级速度——四个人运回来的货
 * 大半只能背在身上，等于花四份孵化费雇了四个会走路的仓库。
 *
 * 有了 storage 就是一百万容量的坑，运多少都吃得下，这才轮到"多派人多赚"。
 */
const LOOT_CREW_WITH_STORAGE = 4;
const LOOT_CREW_BARE = 2;

/** 少于这么多就不值得再专门派人，剩下的零头让路过的顺手带走 */
const LOOT_FLOOR = 200;

/** 一个搬运工跑几趟算一轮。按这个折算要几个人，免得为了几百点残货养一支队伍 */
const TRIPS_PER_CREW = 3;

/** 一个 CARRY 装 50，对应游戏常量 CARRY_CAPACITY */
const PER_CARRY = 50;

export interface LootPile {
  structure: AnyStoreStructure;
  /** 里面一共有多少东西，能量和矿物都算 */
  amount: number;
}

/** 这个家正在搬哪个房间 */
export function lootRoom(home: Room): string | undefined {
  return home.memory.loot;
}

/**
 * 房间里还有多少**我们拿得动**的货。
 *
 * 有视野就现场数，没视野读上次记下的数——配额要在家里算，而那时候多半
 * 看不见目标房间。
 *
 * "拿得动"这个限定是必须的：家里没有 storage 时矿物运回来无处可放，取货那头
 * 本来就会跳过它。要是这里照总量算，配额就会为了三万点搬不走的矿物一直派人，
 * 而人到了现场发现无货可取，喊一声"拿不动"就站着——两边口径必须是同一个。
 */
export function lootLeft(roomName: string): number {
  const room = Game.rooms[roomName];
  if (room) return takeableIn(room, homeFor(roomName));

  return Memory.rooms[roomName]?.lootLeft ?? 0;
}

/** 这批货归哪个家搬。任务记在家的 Memory 上，所以反查要扫一遍己方房间 */
function homeFor(target: string): Room | undefined {
  return Object.values(Game.rooms).find(room => room.controller?.my && room.memory.loot === target);
}

/** 现场清点拿得动的部分：能量恒算，矿物只在家里有 storage 时算 */
function takeableIn(room: Room, home: Room | undefined): number {
  let total = 0;

  for (const pile of lootPiles(room)) {
    const store = pile.structure.store;
    total += store[RESOURCE_ENERGY];
    if (home?.storage) total += (store.getUsedCapacity() ?? 0) - store[RESOURCE_ENERGY];
  }

  return total;
}

/**
 * 值得取的敌方建筑，按存量从多到少。
 *
 * 排除被 rampart 盖住的：那种情况下 withdraw 会失败，而站在旁边反复失败
 * 是最难查的一类空转。
 */
export function lootPiles(room: Room): LootPile[] {
  const ramparts = new Set(
    room
      .find(FIND_STRUCTURES, { filter: structure => structure.structureType === STRUCTURE_RAMPART })
      .map(rampart => `${rampart.pos.x},${rampart.pos.y}`)
  );

  return room
    .find(FIND_STRUCTURES)
    .filter((structure): structure is AnyStoreStructure => {
      if (!LOOT_TYPES.includes(structure.structureType)) return false;
      // 只搬别人的：有主、而且主人不是自己
      if (!("my" in structure) || structure.my) return false;
      return !ramparts.has(`${structure.pos.x},${structure.pos.y}`);
    })
    .map(structure => ({ structure, amount: structure.store.getUsedCapacity() ?? 0 }))
    .filter(pile => pile.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

/**
 * 现成能取到能量的仓库，存量多的在前。
 *
 * 拓荒者用它替代自己挖矿：从 terminal 里取满一趟是一个 tick 的事，同样的量
 * 自己挖要上百 tick。新占的房间里恰好常有这种前人留下的存货，那 15000 能量的
 * spawn 就该用它来建。
 */
export function energyPiles(room: Room): AnyStoreStructure[] {
  return lootPiles(room)
    .filter(pile => pile.structure.store[RESOURCE_ENERGY] > 0)
    .sort((a, b) => b.structure.store[RESOURCE_ENERGY] - a.structure.store[RESOURCE_ENERGY])
    .map(pile => pile.structure);
}

/** 有视野时记一笔存量，好让家里算配额 */
export function trackLoot(room: Room): void {
  const memory = Memory.rooms[room.name];
  if (!memory) return;

  const left = takeableIn(room, homeFor(room.name));
  const previous = memory.lootLeft;
  memory.lootLeft = left;

  // 每次变化都播报会刷屏，跨过一万点这个刻度才说一声
  if (previous !== undefined && Math.floor(previous / 10000) !== Math.floor(left / 10000)) {
    log.info("搬运", `${room.name} 还剩 ${Math.round(left / 1000)}k 可搬`);
  }
}

/**
 * 派几个人去搬。
 *
 * 按剩余量折算：够跑好几轮就给满编，快搬完了自然收缩到一个人，搬空归零。
 * 上限再被孵化预算卡一道——这批人是纯赚的额外收入，但不能挤掉本土的补人。
 */
export function looterQuota(home: Room): number {
  const target = lootRoom(home);
  if (!target) return 0;

  // 从来没看见过那个房间，先派一个人过去看。它的身体和普通搬运工完全一样，
  // 白跑一趟也不亏——发现里面是空的就地转成 hauler，孵化费一点没浪费
  if (Memory.rooms[target]?.lootLeft === undefined && !Game.rooms[target]) return 1;

  const left = lootLeft(target);
  if (left < LOOT_FLOOR) return 0;

  const capacity = looterCapacity(home);
  const crew = home.storage ? LOOT_CREW_WITH_STORAGE : LOOT_CREW_BARE;
  const wanted = Math.min(crew, Math.max(1, Math.ceil(left / capacity / TRIPS_PER_CREW)));

  const alive = ourLooters(home).length;
  if (alive >= wanted) return wanted;

  const each = partsWeight(bodyFor("looter", home.energyCapacityAvailable).length);
  const extra = Math.floor(spawnHeadroom(home) / each);
  return Math.min(wanted, alive + Math.max(0, extra));
}

function looterCapacity(home: Room): number {
  const carry = bodyFor("looter", home.energyCapacityAvailable).filter(part => part === "carry").length;
  return Math.max(1, carry * PER_CARRY);
}

function ourLooters(home: Room): Creep[] {
  return Object.values(Game.creeps).filter(
    creep => creep.memory.role === "looter" && creep.memory.room === home.name
  );
}

/**
 * 搬空了就收摊。
 *
 * 判断依据是有视野时数出来的存量，没视野不动——万一是路上没人经过，
 * 不能因为看不见就以为搬完了。
 */
export function runLootManager(home: Room): void {
  const target = lootRoom(home);
  if (!target) return;

  // 这个房间已经归我们了，那批货就地留给它自己用。跨房间往老家倒腾没有意义：
  // 新家正要拿它建 spawn 和 extension，而运一趟的路上损耗全是白付的
  if (Game.rooms[target]?.controller?.my) {
    log.info("搬运", `${target} 已经占下来了，剩下的货留给它自己用，${home.name} 收摊`);
    stopLoot(home);
    return;
  }

  if (!Game.rooms[target]) return;
  if (lootLeft(target) >= LOOT_FLOOR) return;

  log.info("搬运", `${target} 已经搬空，${home.name} 收摊`);
  delete home.memory.loot;
}

/** 给占领者和搬运工派活用 */
export function lootAssignment(home: Room): Partial<CreepMemory> {
  const target = lootRoom(home);
  return target ? { targetRoom: target } : {};
}

export function startLoot(home: Room, target: string): string {
  if (!/^[WE]\d+[NS]\d+$/.test(target)) return `${target} 不像房间名`;
  if (target === home.name) return "这就是老家";

  home.memory.loot = target;
  const left = lootLeft(target);
  log.info("搬运", `${home.name} 开始搬 ${target}`);

  return left > 0
    ? `${home.name} → ${target}：已知 ${Math.round(left / 1000)}k 可搬，派 ${looterQuota(home)} 人`
    : `${home.name} → ${target}：还没有视野，等有人过去看一眼再定人数`;
}

export function stopLoot(home: Room): string {
  const target = lootRoom(home);
  if (!target) return `${home.name} 没在搬东西`;

  delete home.memory.loot;
  for (const creep of ourLooters(home)) delete creep.memory.targetRoom;

  return `${home.name} 停止搬 ${target}`;
}

/** 一行状态，面板和控制台共用 */
export function lootStatus(home: Room): string | undefined {
  const target = lootRoom(home);
  if (!target) return undefined;

  const left = lootLeft(target);
  const seen = Game.rooms[target] ? "" : "（无视野，上次所见）";
  return `${target} 剩 ${Math.round(left / 1000)}k${seen}，${ourLooters(home).length} 人在搬`;
}

/** 搬运工这一趟该取什么。能量优先，矿物要等家里有 storage 才拿得动 */
export function pickResource(store: StoreDefinition, home: Room): ResourceConstant | undefined {
  if (store[RESOURCE_ENERGY] > 0) return RESOURCE_ENERGY;

  // spawn 和 extension 只收能量，没有 storage 的时候矿物运回来无处可放，
  // 只能扔在地上慢慢蒸发——那不如先留在别人的仓库里，反正它不会跑
  if (!home.storage) return undefined;

  const resource = (Object.keys(store) as ResourceConstant[]).find(type => store[type] > 0);
  return resource;
}

/** 播报用：把数字缩成 k */
export function short(amount: number): string {
  return amount >= 1000 ? `${Math.round(amount / 1000)}k` : String(amount);
}
