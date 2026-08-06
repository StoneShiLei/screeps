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
  defender: { pattern: ["attack", "move"], fixed: [], maxRepeat: 10, filler: "tough" },

  // scout 只要视野，不干活也不挨打。一个 MOVE 五十能量，死了再造一个就是
  scout: { pattern: ["move"], fixed: [], maxRepeat: 1 },

  // 外矿的源是 1500 容量、300 tick 再生，平均 5 能量/tick，3 个 WORK 每 tick
  // 挖 6 点就已经超过再生速度。再多带只会更早把源挖空然后干站着，白付孵化费。
  // MOVE 配到一比一：它要跨房间通勤几十格，路上每一 tick 都是纯亏。
  remoteMiner: { pattern: ["work", "move"], fixed: [], maxRepeat: 3 },

  // 长途运输队，CARRY 和 MOVE 一比一保证平地满载也能全速。外矿路线前期没有路，
  // 二比一那种省钱配法会让它在平地上就走两 tick 一格，往返多花几十 tick
  remoteHauler: { pattern: ["carry", "move"], fixed: [], maxRepeat: 12 },

  // 预定员只要一个 CLAIM。
  //
  // 预定的剩余时长每 tick 自减一，一个 CLAIM 每 tick 补一，净增为零——但那正好够：
  // 源的容量是在再生的那一刻按"这个房间此刻有没有被预定"决定的，只要人在岗，
  // 房间就一直算被预定，容量就是 3000。攒余量只对换人的空窗有意义。
  //
  // 两个 CLAIM 能攒余量，摊到每 tick 的成本也几乎一样（1250 管 2×(600-路程) tick，
  // 对 650 管 600-路程），但它要 1300 能量、得等 RCL4；一个 CLAIM 只要 650，
  // RCL3 造出七个 extension 就够，能早几千 tick 让外矿产能翻倍。空窗靠提前孵化
  // 接班的人来盖，那比多背一个 CLAIM 便宜。
  reserver: { pattern: ["claim", "move"], fixed: [], maxRepeat: 1 },

  // 两个 WORK 配一个 MOVE：平地上每步的疲劳等于非 MOVE 部件数，一个 MOVE 每 tick
  // 消两点，这个比例刚好让它满载走平地也是一格一 tick。零头继续买 MOVE——它去的
  // 是没有路的外矿，早到几十 tick 就是早几十 tick 开始砸墙。
  dismantler: { pattern: ["work", "work", "move"], fixed: [], maxRepeat: 16, filler: "move" },

  // 占领者：一个 CLAIM 就够，claimController 不看数量，多带一个纯浪费六百能量。
  //
  // MOVE 却要给到两个。它和预定员的差别在这里：预定员到岗之后一站几百 tick，
  // 路上慢一点无所谓；占领者是一次性的，寿命只有 600 tick，全部价值都在"多快
  // 走到那个控制器旁边"。一个 MOVE 拖着一个 CLAIM 在平地上要两 tick 一格，
  // 两个 MOVE 就是一格一 tick——五十能量买回一半路程。
  claimer: { pattern: ["move"], fixed: ["claim"], maxRepeat: 2 },

  // 拓荒者就是能自己找饭吃的 builder。新房间什么都没有，它得自己挖、自己建，
  // 所以 WORK CARRY MOVE 一比一比一，和 builder 同款。
  pioneer: { pattern: ["work", "carry", "move"], fixed: [], maxRepeat: 5 },

  // 搬空别人仓库的运输队。和外矿运输队同款一比一：那条路上没有路面，
  // 二比一的省钱配法会让它满载时两 tick 才走一格，往返多花几十 tick。
  // 一趟能拉走多少纯看 CARRY，所以上限给得高，预算有多少就装多少
  looter: { pattern: ["carry", "move"], fixed: [], maxRepeat: 12 }
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

  const limit = repeatLimit ?? template.maxRepeat;
  const patternCost = costOf(template.pattern);
  const affordable = Math.floor((budget - costOf(base)) / patternCost);
  const withinPartLimit = Math.floor((MAX_PARTS - base.length) / template.pattern.length);
  const repeat = Math.max(1, Math.min(limit, withinPartLimit, affordable));

  const body: BodyPartConstant[] = [...base];
  for (let i = 0; i < repeat; i++) {
    body.push(...template.pattern);
  }

  // 只有"钱不够再凑一组"时才花零头。顶到角色上限的一律不加：预算刚好买满
  // 上限那一档时零头看着像白扔，可给预定员塞三个 MOVE、给矿工塞第六个 WORK
  // 都是纯亏——多出来的部件每 tick 都在收孵化费，却一点产出都不多。
  if (repeat < limit) spendLeftover(body, budget, template.filler ?? "carry");

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
