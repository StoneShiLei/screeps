/**
 * 全局类型扩展。
 *
 * 这个文件没有顶层 import/export，因此其中的 interface 会自动与 @types/screeps
 * 里的同名 interface 合并，成为全局类型。往 Memory 里存新字段时，先在这里声明。
 */

type CreepRole =
  | "harvester"
  | "upgrader"
  | "builder"
  | "miner"
  | "hauler"
  | "defender"
  | "scout"
  | "remoteMiner"
  | "remoteHauler"
  | "reserver"
  | "dismantler";

interface CreepMemory {
  role: CreepRole;
  /** creep 归属的房间名，用于按房间统计数量 */
  room: string;
  /** false = 正在采集，true = 正在把能量送出去 */
  working: boolean;
  /** 缓存的能量源，避免每 tick 重新寻路查找 */
  sourceId?: Id<Source>;
  /** builder 正在建的工地，盯住一个建完再换下一个 */
  siteId?: Id<ConstructionSite>;
  /** hauler 正在送货的目标 id，物流系统靠它扣减在途量 */
  deliverTo?: string;
  /** hauler 正在取货的目标 id，可能是建筑、墓碑，也可能是地上的一堆能量 */
  withdrawFrom?: string;
  /** 移动系统的路径缓存，由 travelTo 维护，别的地方不要碰 */
  travel?: TravelState;
  /** upgrader 认领的升级站位，认领之后别人不来抢 */
  station?: { x: number; y: number };
  /** upgrader 连续多少 tick 没从容器里拿到能量，用来判断要不要出门自己找 */
  idleTicks?: number;
  /** announce 上次喊过的内容，一样就不重复喊 */
  lastSay?: string;
  /**
   * 外派 creep 的目标房间。
   *
   * 和 room 是两回事：room 是它归哪个基地管（配额、物流都按这个算），
   * targetRoom 是它这趟要去哪个外矿。
   */
  targetRoom?: string;
}

/**
 * 官方为了堵 XSS 漏洞改了控制台：console.log 现在会在服务端转义 HTML，
 * 想要带颜色的输出得走新加的 logUnsafe。@types/screeps 还没跟上，先自己声明。
 *
 * 声明成可选的，因为私服和旧版官服上可能没有这个方法。
 */
interface Console {
  logUnsafe?(...data: unknown[]): void;
}

interface Memory {
  /** 调试开关：日志级别、可视化模块、say */
  settings?: {
    level?: "error" | "warn" | "info" | "debug";
    visuals?: Partial<Record<"movement" | "logistics" | "planner" | "spawn" | "panel", boolean>>;
    say?: boolean;
  };
}

/**
 * 路径缓存。
 *
 * path 存的是方向常量拼成的字符串，一步一个字符。存坐标的话每步至少要
 * 四五个字节，几十步的路径就上百字节了，而 Memory 是按序列化后的长度收费的。
 */
interface TravelState {
  /** 目标位置和容差，变了就得重新寻路 */
  dest: string;
  /** 还没走完的路，每个字符是一个方向常量 */
  path: string;
  /** 连续几 tick 位置没变 */
  stuck: number;
  /** 上一 tick 所在的格子，用来判断上一步走成了没有 */
  last: string;
}

interface RoomMemory {
  /**
   * bunker 中心点。所有建筑位置都是相对它的偏移，所以整个房间的布局
   * 只需要存这一对坐标，几十字节就够，不用把上百个建筑位置塞进 Memory。
   */
  anchor?: { x: number; y: number };
  /**
   * 每个能量源旁边的采集点，键是能量源 id。
   * 这里会建 container，矿工站在上面挖，能量直接落进容器。
   */
  miningSpots?: Record<string, { x: number; y: number }>;
  /** 控制器旁边的能量堆放点，升级工站在它旁边取货 */
  upgradeSpot?: { x: number; y: number };
  /**
   * 升级工的站位，都在容器 1 格以内。
   *
   * 每人认领一个固定格子，省得几个升级工挤在同一片地方互相别。
   * 数量也是配额上限——站位不够时多派的人只能干站着。
   */
  upgradeStations?: { x: number; y: number }[];
  /**
   * 主干道要铺的格子，一格两个字符编码。
   *
   * 二十来格的路存成串也就四十字节，换成坐标对象数组要好几百。
   * 解码用 planner/roads 里的 decodeCells。
   */
  roads?: string;
  /** 上次检查建造进度的 tick，用来控制检查频率 */
  lastBuildCheck?: number;
  /** 上次播报时房间里的敌人数量，数量没变就不重复刷屏 */
  threat?: number;
  /**
   * 本房间正在外派采集的房间名。
   *
   * 只有基地房间有这个字段，外矿房间那边记的是 home，两边互指方便双向查。
   */
  remotes?: string[];
  /** 外矿房间归哪个基地管。这个字段也是 Memory 清理时的白名单标记 */
  home?: string;
  /**
   * 侦察到的能量源位置，键是 source id。
   *
   * 外矿房间平时没有视野，find(FIND_SOURCES) 是空的，派矿工出门前得靠这份
   * 记录才知道该去哪一格。地形和 source 位置都是永久不变的，存一次就够。
   */
  sources?: Record<string, { x: number; y: number }>;
  /** 上次侦察完成的 tick，没有这个字段就是还没侦察过 */
  scouted?: number;
  /**
   * 这个房间不能采，以及为什么。
   *
   * owned/reserved 是被别人占了，keeper 是有 Source Keeper 守着，
   * core 是驻了 invader core，none 是压根没有能量源。
   */
  unusable?: "owned" | "reserved" | "keeper" | "core" | "none";
  /** 上次在这里撞见敌人的 tick，用来给外派人员放一段冷却 */
  raided?: number;
  /**
   * 控制器被前人的墙圈住了，要拆哪一段才够得着。
   *
   * 有这个字段就说明预定员派过去也只能站在墙外，所以配额那边会跳过这个房间，
   * 改派拆迁工。墙拆完了这个字段会被清掉，预定随之恢复。
   *
   * hits 记的是整条路上要砸掉的总血量，不只是第一段——用来判断值不值得动手。
   */
  breach?: {
    /**
     * 挡在最省那条路上的第一段墙，先拆它。
     *
     * 没有这个字段说明连拆都拆不进去——目标那片地方被天然岩石隔开，
     * 只能从别的房间绕，而带 CLAIM 的 creep 活不到走完那段路。
     */
    wall?: { x: number; y: number };
    /** 整条路上要砸掉的血量总和，不只是第一段 */
    hits: number;
    /** 要拆几段 */
    walls: number;
  };
  /**
   * 自己的预定什么时候到期，绝对 tick。
   *
   * 存到期时刻而不是剩余时长，是因为这个字段在没视野的几百 tick 里也要能读：
   * 预定期间源的容量从 1500 涨到 3000，矿工体型和运力配额都要照这个改，
   * 而算配额是在基地跑的，那边看不见外矿的 controller。
   */
  reserveEnds?: number;
  /**
   * 平滑后的孵化忙碌率，0 到 1。
   *
   * 只存平滑值不存采样历史：孵化忙不忙看的是几百 tick 的趋势，逐 tick 的
   * 0/1 抖动没有意义，而 Memory 是按序列化长度收费的。
   */
  spawnBusy?: number;
  /**
   * 升级进度采样，用来估距下一级还要多久。
   *
   * 只存三个数：上次采样的 tick、那时的 progress、平滑后的每 tick 增量。
   * 不做通用统计系统——那是另一个量级的东西。
   */
  progressSample?: {
    tick: number;
    progress: number;
    rate: number;
  };
}
