/**
 * 安全模式：己方关键建筑被敌人拆掉时拉闸。
 *
 * Safe Mode 一开，外人在本房不能对己方单位/建筑造成伤害，持续约两万 tick，
 * 但全 shard 同时只能有一个房间开着，次数也有限——所以只在"已经破防丢建筑"
 * 时用，不当日常防御。
 */

import { hostilesIn } from "../roles/defender";
import { log } from "../utils/logger";

/**
 * 丢了才值得拉闸的建筑。
 *
 * 不含路/容器/墙：路和容器会自然朽掉，墙在清前人基地时我们自己也会拆，
 * 那些都不是"被打穿了"。spawn / 塔 / extension 没了才是真破防。
 */
const CRITICAL_LOSS: ReadonlySet<string> = new Set([
  "spawn",
  "extension",
  "tower",
  "storage",
  "terminal",
  "link",
  "lab",
  "observer",
  "powerSpawn",
  "factory",
  "nuker",
  "rampart"
]);

/** 游戏常量 EVENT_OBJECT_DESTROYED；测试里可能还没注入，用字面量兜底 */
const OBJECT_DESTROYED = typeof EVENT_OBJECT_DESTROYED === "number" ? EVENT_OBJECT_DESTROYED : 2;

export interface SafeModeController {
  my?: boolean;
  safeMode?: number;
  safeModeAvailable: number;
  safeModeCooldown?: number;
  activateSafeMode: () => number;
}

export interface RoomEvent {
  event: number;
  data?: { type?: string };
}

/**
 * 这一 tick 该不该拉闸。
 *
 * 条件同时满足：
 * 1. 有可用次数、不在冷却、本房没在安全模式里
 * 2. 房间里有武装敌人（没敌人时丢建筑多半是我们自己拆的，或自然朽掉）
 * 3. 事件日志里出现关键己方建筑被毁
 */
export function shouldActivateSafeMode(
  controller: SafeModeController | undefined,
  armedHostiles: number,
  events: RoomEvent[]
): boolean {
  if (!controller?.my) return false;
  if (controller.safeMode) return false;
  if (controller.safeModeAvailable <= 0) return false;
  if (controller.safeModeCooldown) return false;
  if (armedHostiles <= 0) return false;

  return events.some(
    event => event.event === OBJECT_DESTROYED && !!event.data?.type && CRITICAL_LOSS.has(event.data.type)
  );
}

/** 每个己方房间每 tick 查一次；破防立刻拉闸，越早越好 */
export function runSafeMode(room: Room): void {
  const controller = room.controller;
  if (!controller?.my) return;

  const events =
    typeof room.getEventLog === "function" ? (room.getEventLog() as RoomEvent[]) : [];

  if (!shouldActivateSafeMode(controller, hostilesIn(room).length, events)) return;

  const result = controller.activateSafeMode();
  if (result === OK) {
    log.warn("防御", `${room.name} 关键建筑被毁，已激活安全模式（剩余 ${controller.safeModeAvailable} 次）`);
  } else {
    log.warn("防御", `${room.name} 想开安全模式失败：${result}`);
  }
}
