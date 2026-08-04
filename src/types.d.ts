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
