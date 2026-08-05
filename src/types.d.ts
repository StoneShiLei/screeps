/**
 * 全局类型扩展。
 *
 * 这个文件没有顶层 import/export，因此其中的 interface 会自动与 @types/screeps
 * 里的同名 interface 合并，成为全局类型。往 Memory 里存新字段时，先在这里声明。
 */

type CreepRole = "harvester" | "upgrader";

interface CreepMemory {
  role: CreepRole;
  /** creep 归属的房间名，用于按房间统计数量 */
  room: string;
  /** false = 正在采集，true = 正在把能量送出去 */
  working: boolean;
  /** 缓存的能量源，避免每 tick 重新寻路查找 */
  sourceId?: Id<Source>;
}

interface RoomMemory {
  /**
   * bunker 中心点。所有建筑位置都是相对它的偏移，所以整个房间的布局
   * 只需要存这一对坐标，几十字节就够，不用把上百个建筑位置塞进 Memory。
   */
  anchor?: { x: number; y: number };
  /** 上次检查建造进度的 tick，用来控制检查频率 */
  lastBuildCheck?: number;
}
