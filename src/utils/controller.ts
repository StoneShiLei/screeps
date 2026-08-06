/**
 * 控制器降级相关的共用判断。
 *
 * 建造优先策略里，升级工和物流都要问同一句话："是不是快掉级了？"——
 * 阈值必须两边一致，否则会出现粮仓在补、升级工却停手（或反过来）的打架。
 */

/** 各 RCL 的降级倒计时上限，对应游戏常量 CONTROLLER_DOWNGRADE */
const DOWNGRADE_MAX: Record<number, number> = {
  1: 20000,
  2: 10000,
  3: 20000,
  4: 40000,
  5: 80000,
  6: 120000,
  7: 150000,
  8: 200000
};

/**
 * 降级倒计时掉到上限的四分之一以下才需要专人顶住。
 *
 * 刚升一级时计时器只有一半；阈值若定在一半以上，房间会永远处在"防降级"
 * 模式，建造优先就成空话。四分之一留了足够反应时间：一个升级工每 tick
 * 给计时器加 100，几天就能拉回安全区。
 */
export function needsDowngradeShield(room: Room): boolean {
  const controller = room.controller;
  if (!controller?.my) return false;

  const max = DOWNGRADE_MAX[controller.level] ?? 20000;
  return controller.ticksToDowngrade < max / 4;
}
