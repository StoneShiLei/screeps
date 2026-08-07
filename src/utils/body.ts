/**
 * 按角色生成体型。
 *
 * 移动配比按官方疲劳规则分两档（见 screeps-cn Creeps「移动力」）：
 *   - 有路：每重部件疲劳 1，MOVE 每 tick 消 2 → 满速要 MOVE ≥ ceil(重部件/2)（约 2:1）
 *   - 无路/平原：每重部件疲劳 2 → 满速要 MOVE ≥ 重部件（约 1:1）
 * 空的 CARRY 不计重；满载后才算。
 *
 * 本房 hauler/builder 还要看 RCL：规划里平原路要 RCL4 才铺（与 roomPlanner 的
 * ROAD_MIN_LEVEL 一致）。RCL2/3 主干道还不存在，不能按有路 2:1 造，否则满载
 * 平原直接 2t/格。跨房角色始终按无路。
 *
 * 不依赖 Game 对象，可以直接跑单元测试。
 */

/**
 * 本房开始按「有路」体型孵化的最低 RCL。
 *
 * 与 `planner/roomPlanner` 的 ROAD_MIN_LEVEL 对齐：3 级只铺沼泽段，平地主干道
 * 仍没有，家用搬运/建造继续走无路比。
 */
export const HOME_ROAD_BODY_LEVEL = 4;

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
  /**
   * 凑不满一整组的零头拿来买什么。不填就不补零头。
   *
   * 补零头会往身上加部件，可能破坏满速比。纯搬运、无路满速角色一般不填；
   * 本房有路的建造类可补 CARRY（spendLeftover 仍按有路比补 MOVE）。
   */
  filler?: BodyPartConstant;
}

/**
 * 各角色的体型模板。
 *
 * miner / upgrader 基本站桩，MOVE 只够挪位。其余按「有路 vs 无路」选比。
 */
const TEMPLATES: Record<CreepRole, BodyTemplate> = {
  // —— 站桩：不通勤，MOVE 极少 ——
  // 预算够的话给 miner 配一个 CARRY：挖出来的能量会先进口袋再溢进容器，顺手修桶。
  miner: {
    pattern: ["work"],
    fixed: ["move"],
    maxRepeat: 5,
    bonus: { minBudget: 600, parts: ["carry"] },
    filler: "carry"
  },
  // 钉站等粮：1 CARRY 现取现用，1 MOVE 够从 spawn 走到站位；预算全堆 WORK。
  upgrader: { pattern: ["work"], fixed: ["carry", "move"], maxRepeat: 8 },

  // —— 本房有路（RCL≥HOME_ROAD_BODY_LEVEL）：满载路速 ≈ 重部件:MOVE = 2:1 ——
  // RCL2/3 见 PLAIN_HOME：那时还没平原主干道，不能用这套。
  hauler: { pattern: ["carry", "carry", "move"], fixed: [], maxRepeat: 10 },
  // W+C 配 1 MOVE：路上满载 1t。零头可补 CARRY（按有路比补 MOVE）。
  builder: { pattern: ["work", "carry", "move"], fixed: [], maxRepeat: 5, filler: "carry" },

  // —— 无路 / 跨房：满载平速 ≈ 重部件:MOVE = 1:1（带 WORK 满载则 MOVE≥W+C）——
  // 早期应急工，房间往往还没路，按平原满速配。
  harvester: { pattern: ["work", "carry", "move", "move"], fixed: [], maxRepeat: 3 },
  // 本土肉搏，可能离路追击；ATTACK:MOVE=1:1 保平原 1t。零头买 TOUGH。
  defender: { pattern: ["attack", "move"], fixed: [], maxRepeat: 10, filler: "tough" },
  // 跨房驰援，无路。零头买 MOVE，别买 TOUGH 拖成 2t。
  guardian: { pattern: ["attack", "move"], fixed: [], maxRepeat: 10, filler: "move" },
  scout: { pattern: ["move"], fixed: [], maxRepeat: 1 },
  // 外矿通勤无路；源 1500/300tick，3 WORK 够。
  // 预算够就加 1 CARRY，让矿工自己建、自己修脚下的容器：它本来就站在那儿，
  // 3 WORK 挖 6 点而源只回 5 点，本身就有余力，派第三个 creep 跨房来干是重复投资。
  // 门槛卡在 500，是因为 450 预算下加了 CARRY 就只剩 2 个 WORK，挖不满源的再生。
  remoteMiner: {
    pattern: ["work", "move"],
    fixed: [],
    maxRepeat: 3,
    bonus: { minBudget: 500, parts: ["carry"] }
  },
  // 外矿路修好前大量平地，满载必须 1:1；修好后多 MOVE 也不亏多少。
  remoteHauler: { pattern: ["carry", "move"], fixed: [], maxRepeat: 12 },
  // CLAIM 始终算重；CLAIM:MOVE=1:1 即平原 1t。RCL3 一组、RCL4 两组。
  reserver: { pattern: ["claim", "move"], fixed: [], maxRepeat: 2 },
  // 外矿拆墙，无路。旧 2W1M 注释写错了（平原其实 2t）；改正为 1:1。
  dismantler: { pattern: ["work", "move"], fixed: [], maxRepeat: 25, filler: "move" },
  // 占领者寿限 600，全程赶路：1 CLAIM 配 2 MOVE（多 50 能量换平原余量/沼泽）。
  claimer: { pattern: ["move"], fixed: ["claim"], maxRepeat: 2 },
  // 跨房满载无路：W:C:M = 1:1:2。不补 CARRY 零头。
  pioneer: { pattern: ["work", "carry", "move", "move"], fixed: [], maxRepeat: 5 },
  // 搬空外房仓库，无路，与 remoteHauler 同 1:1。
  looter: { pattern: ["carry", "move"], fixed: [], maxRepeat: 12 }
};

/**
 * 本房尚未铺平原路时，hauler/builder 改用无路满速模板。
 *
 * 只覆盖会受「有路 2:1」坑害的角色；其余角色本身就是无路比，不必改。
 */
const PLAIN_HOME: Partial<Record<CreepRole, BodyTemplate>> = {
  hauler: { pattern: ["carry", "move"], fixed: [], maxRepeat: 10 },
  // 与 pioneer/harvester 同：满载平原 MOVE ≥ W+C；不补 CARRY 零头
  builder: { pattern: ["work", "carry", "move", "move"], fixed: [], maxRepeat: 5 }
};

/**
 * RCL 到了铺外矿路那一档之后，运输队带上 1 个 WORK。
 *
 * 修路和建路都不占移动意图：creep 同一 tick 可以既 move 又 build/repair，所以
 * 顺路干这点活不掉一格速度，只花掉车上那几点能量——而那正是路本身该花的钱。
 * 代价只有少带的那一个 CARRY：1300 预算下从 12C 变成 11C，约 8%，而它换掉的是
 * 一个常驻外矿的维修拓荒者（0.5 能量/tick）。
 *
 * 仍按无路 1:1 配（MOVE ≥ WORK + CARRY）：外矿路要几千能量才铺得完，在那之前
 * 大半路程还是平地，按 2:1 造会一路 2 tick 一格。
 */
const ROAD_REMOTE: Partial<Record<CreepRole, BodyTemplate>> = {
  remoteHauler: { pattern: ["carry", "move"], fixed: ["work", "move"], maxRepeat: 12 }
};

/** 输出顺序：受伤时身体从头开始掉，把 MOVE 放最后，残血了也还能挪回家 */
const PART_ORDER: BodyPartConstant[] = ["tough", "work", "attack", "ranged_attack", "carry", "claim", "heal", "move"];

function costOf(parts: BodyPartConstant[]): number {
  return parts.reduce((sum, part) => sum + PART_COST[part], 0);
}

function templateFor(role: CreepRole, level?: number): BodyTemplate {
  if (level === undefined) return TEMPLATES[role];

  if (level < HOME_ROAD_BODY_LEVEL) return PLAIN_HOME[role] ?? TEMPLATES[role];
  return ROAD_REMOTE[role] ?? TEMPLATES[role];
}

/**
 * 在预算内造尽量大的 creep。
 *
 * 预算不够一组的时候仍然返回一组——宁可造个孱弱的也别返回空体型，
 * 那会让孵化直接报错，房间彻底卡死。调用方要自己确认能量够不够。
 *
 * @param repeatLimit 临时改写模板上限（如 RCL8 升级工 WORK 封顶）
 * @param level 房间 RCL；本房 hauler/builder 在低于 HOME_ROAD_BODY_LEVEL 时用无路比
 */
export function bodyFor(
  role: CreepRole,
  budget: number,
  repeatLimit?: number,
  level?: number
): BodyPartConstant[] {
  const template = templateFor(role, level);
  const bonus = template.bonus && budget >= template.bonus.minBudget ? template.bonus.parts : [];
  const base = [...template.fixed, ...bonus];

  const limit = repeatLimit ?? template.maxRepeat;
  const patternCost = costOf(template.pattern);
  const affordable = Math.floor((budget - costOf(base)) / patternCost);
  const withinPartLimit = Math.floor((MAX_PARTS - base.length) / template.pattern.length);
  const repeat = Math.max(1, Math.min(limit, withinPartLimit, affordable));

  const body: BodyPartConstant[] = [...base];
  for (let i = 0; i < repeat; i++) {
    body.push(...template.pattern);
  }

  // 只有"钱不够再凑一组"、且这个角色明确要补零头时才补。顶到角色上限的一律不加。
  // 有路建造的 filler 按路比补 MOVE；无路模板本身不开 carry filler。
  const onRoad = level === undefined || level >= HOME_ROAD_BODY_LEVEL;
  if (repeat < limit && template.filler) spendLeftover(body, budget, template.filler, onRoad);

  return body.sort((a, b) => PART_ORDER.indexOf(a) - PART_ORDER.indexOf(b));
}

/**
 * 把凑不满一整组的零头花掉。
 *
 * @param onRoad true 时按有路满速补 MOVE（2*MOVE≥重部件）；false 按平原（MOVE≥重部件）
 */
function spendLeftover(
  body: BodyPartConstant[],
  budget: number,
  filler: BodyPartConstant,
  onRoad: boolean
): void {
  let leftover = budget - costOf(body);

  while (body.length < MAX_PARTS) {
    const movers = body.filter(existing => existing === "move").length;
    const heavies = body.length - movers;
    const needsMove = onRoad ? movers * 2 < heavies : movers < heavies;

    const part = needsMove && leftover >= PART_COST.move ? "move" : filler;
    if (leftover < PART_COST[part]) break;

    body.push(part);
    leftover -= PART_COST[part];
  }
}

/**
 * 模板允许的最大重复组数。
 *
 * 配额计算要按这个封顶：高等级房间的预算能买下几十组，但模板上限拦在那里，
 * 照预算估出来的运力是造不出来的，人数就会算少。
 */
export function maxRepeatFor(role: CreepRole): number {
  return TEMPLATES[role].maxRepeat;
}

/** 孵化这个体型要花多少能量 */
export function bodyCost(body: BodyPartConstant[]): number {
  return costOf(body);
}
