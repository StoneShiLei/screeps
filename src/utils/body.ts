/**
 * 按角色生成体型。
 *
 * 所有角色共用一套 [WORK, CARRY, MOVE] 的年代，挖矿时 CARRY 闲着、
 * 搬运时 WORK 闲着，等于一直在为用不上的部件付孵化费和维护费。
 * 分工之后每个角色只带自己真正用得上的部件。
 *
 * 不依赖 Game 对象，可以直接跑单元测试。
 */

/**
 * 部件造价。这里写死而不用全局的 BODYPART_COST：
 * 那张表只在游戏运行时存在，模块顶层引用会让单元测试加载阶段就崩掉。
 */
const PART_COST: Record<string, number> = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ["ranged_attack"]: 150,
  heal: 250,
  claim: 600,
  tough: 10
};

/** 一个 creep 最多 50 个身体部件，这是游戏硬性限制 */
const MAX_PARTS = 50;

interface BodyTemplate {
  /** 按预算重复的部件组 */
  pattern: BodyPartConstant[];
  /** 不管重复几组都只加一次的部件 */
  fixed: BodyPartConstant[];
  /** 最多重复几组 */
  maxRepeat: number;
  /** 预算宽裕时才加的锦上添花部件 */
  bonus?: { minBudget: number; parts: BodyPartConstant[] };
  /** 凑不满一整组的零头拿来买什么，默认 CARRY */
  filler?: BodyPartConstant;
}

/**
 * 各角色的体型模板。
 *
 * miner 只挖不动：5 个 WORK 每 tick 挖 10 点，正好等于一个能量源的再生速率，
 * 再多就是浪费。挖出来的能量直接落进脚下的 container，所以一个 CARRY 都不要，
 * 一个 MOVE 只是用来走到岗位上。
 *
 * hauler 只搬不挖：CARRY 和 MOVE 一比一，这样满载时在平地上也能每 tick 走一格。
 * 等路修好了可以降到二比一。
 *
 * upgrader 钉在控制器旁边，每 tick 从容器里取一点马上花掉，所以 CARRY 只要一个，
 * 省下的预算全堆 WORK。
 */
const TEMPLATES: Record<CreepRole, BodyTemplate> = {
  // 预算够的话给 miner 配一个 CARRY：挖出来的能量会先进自己的口袋再溢进容器，
  // 正好拿这 50 点能量顺手修脚下的容器，省得另派人跑一趟。
  miner: { pattern: ["work"], fixed: ["move"], maxRepeat: 5, bonus: { minBudget: 600, parts: ["carry"] } },
  hauler: { pattern: ["carry", "move"], fixed: [], maxRepeat: 10 },
  upgrader: { pattern: ["work"], fixed: ["carry", "move", "move"], maxRepeat: 8 },
  builder: { pattern: ["work", "carry", "move"], fixed: [], maxRepeat: 5 },
  harvester: { pattern: ["work", "carry", "move"], fixed: [], maxRepeat: 3 },
  // defender 的零头买 TOUGH：10 能量一个、抵 100 点伤害，是全表里最便宜的血。
  // 它挡不住多少刀，但足够撑到塔或者同伴补上——而这些零头本来是要浪费掉的。
  defender: { pattern: ["attack", "move"], fixed: [], maxRepeat: 10, filler: "tough" }
};

/** 输出顺序：受伤时身体从头开始掉，把 MOVE 放最后，残血了也还能挪回家 */
const PART_ORDER: BodyPartConstant[] = ["tough", "work", "attack", "ranged_attack", "carry", "claim", "heal", "move"];

function costOf(parts: BodyPartConstant[]): number {
  return parts.reduce((sum, part) => sum + PART_COST[part], 0);
}

/**
 * 在预算内造尽量大的 creep。
 *
 * 预算不够一组的时候仍然返回一组——宁可造个孱弱的也别返回空体型，
 * 那会让孵化直接报错，房间彻底卡死。调用方要自己确认能量够不够。
 *
 * repeatLimit 用来临时改写模板的上限。房间等级会改变某些角色的最优规模，
 * 但那是调用方才知道的事，模板本身不该去读游戏状态。
 */
export function bodyFor(role: CreepRole, budget: number, repeatLimit?: number): BodyPartConstant[] {
  const template = TEMPLATES[role];
  const bonus = template.bonus && budget >= template.bonus.minBudget ? template.bonus.parts : [];
  const base = [...template.fixed, ...bonus];

  const patternCost = costOf(template.pattern);
  const affordable = Math.floor((budget - costOf(base)) / patternCost);
  const withinPartLimit = Math.floor((MAX_PARTS - base.length) / template.pattern.length);
  const repeat = Math.max(1, Math.min(repeatLimit ?? template.maxRepeat, withinPartLimit, affordable));

  const body: BodyPartConstant[] = [...base];
  for (let i = 0; i < repeat; i++) {
    body.push(...template.pattern);
  }

  if (affordable <= repeat) spendLeftover(body, budget, template.filler ?? "carry");

  return body.sort((a, b) => PART_ORDER.indexOf(a) - PART_ORDER.indexOf(b));
}

/**
 * 把凑不满一整组的零头花掉。
 *
 * 300 能量造 [WORK,CARRY,MOVE] 只花得起一组，剩下的 100 就这么扔了——
 * 而这 100 能再买一个 CARRY 加一个 MOVE，容量直接翻倍。早期每一点预算都金贵。
 *
 * 只在预算确实不够下一整组时才补，预算宽裕却被角色上限卡住的情况（比如矿工
 * 满了五个 WORK 就不该再加）不能补，否则会堆一身用不上的部件。
 *
 * 买什么由角色决定：干活的买 CARRY，打架的买 TOUGH。给防御兵塞一身 CARRY
 * 就是白给对方多砍几刀的血条。
 */
function spendLeftover(body: BodyPartConstant[], budget: number, filler: BodyPartConstant): void {
  let leftover = budget - costOf(body);

  while (body.length < MAX_PARTS) {
    // 每两个干活的部件配一个 MOVE，这是平地上不至于慢得离谱的底线
    const movers = body.filter(existing => existing === "move").length;
    const needsMove = movers * 2 < body.length - movers;

    // 该买 MOVE 但钱不够时退而买 filler，别把剩下的零头干脆扔了
    const part = needsMove && leftover >= PART_COST.move ? "move" : filler;
    if (leftover < PART_COST[part]) break;

    body.push(part);
    leftover -= PART_COST[part];
  }
}

/** 孵化这个体型要花多少能量 */
export function bodyCost(body: BodyPartConstant[]): number {
  return costOf(body);
}
