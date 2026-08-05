/**
 * 全局类型扩展。
 *
 * 这个文件没有顶层 import/export，因此其中的 interface 会自动与 @types/screeps
 * 里的同名 interface 合并，成为全局类型。往 Memory 里存新字段时，先在这里声明。
 */

type CreepRole = "harvester" | "upgrader" | "builder" | "miner" | "hauler" | "defender";

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
