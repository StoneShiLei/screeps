/**
 * 空闲时用满桶搓像素。
 *
 * generatePixel 会取消同 tick 全部意图，所以只能在 loop 开头判定：通过就搓完直接
 * return，本 tick 不跑房间和 creep。搓完桶归零，靠 (limit - used) 回填——平时 CPU
 * 贴着 limit 时回填极慢，必须用近期用量 EMA 卡住"不紧张"才动手。
 */

import { hostilesIn } from "../roles/defender";
import { log } from "../utils/logger";

/** 搓一个像素要整桶这么多，也是桶的上限 */
export const PIXEL_BUCKET = 10000;

/**
 * 近期平均用量相对 limit 低于这个比例才算空闲。
 *
 * 留三成半给尖峰和回填：搓完桶从零爬，若平时吃满 limit，爬满要很久还容易超时。
 */
export const CPU_IDLE_RATIO = 0.65;

/** EMA 系数，时间常数大约二十 tick */
const CPU_SMOOTHING = 0.05;

export interface PixelDecisionInput {
  bucket: number;
  /** 还没采过样时不搓，不知道是否真空闲 */
  avgCpu: number | undefined;
  limit: number;
  underAttack: boolean;
  enabled: boolean;
  apiAvailable: boolean;
}

/** 纯判定，单测只碰这个 */
export function shouldGeneratePixel(input: PixelDecisionInput): boolean {
  if (!input.enabled) return false;
  if (!input.apiAvailable) return false;
  if (input.bucket < PIXEL_BUCKET) return false;
  if (input.limit <= 0) return false;
  if (input.avgCpu === undefined) return false;
  if (input.avgCpu >= input.limit * CPU_IDLE_RATIO) return false;
  if (input.underAttack) return false;
  return true;
}

export function smoothCpu(prev: number | undefined, used: number): number {
  if (prev === undefined) return used;
  return prev * (1 - CPU_SMOOTHING) + used * CPU_SMOOTHING;
}

/** loop 末尾（含搓像素那 tick）记本 tick 实际用量 */
export function sampleCpuUsage(): void {
  if (!Game.cpu?.getUsed) return;
  if (!Memory.cpu) Memory.cpu = {};
  Memory.cpu.avg = smoothCpu(Memory.cpu.avg, Game.cpu.getUsed());
}

/**
 * 己方房，或有己方 creep 的可见房里出现武装敌人。
 *
 * 跳过整 tick 等于放弃开火/逃跑/孵化那一拍，有仗打就不搓。
 */
export function hasArmedThreat(): boolean {
  const names = new Set<string>();

  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    if (room.controller?.my) names.add(name);
  }

  for (const name in Game.creeps) {
    names.add(Game.creeps[name].room.name);
  }

  for (const name of names) {
    const room = Game.rooms[name];
    if (room && hostilesIn(room).length > 0) return true;
  }

  return false;
}

export function pixelsEnabled(): boolean {
  return Memory.settings?.pixels !== false;
}

export function setPixelsEnabled(enabled: boolean): void {
  if (!Memory.settings) Memory.settings = {};
  Memory.settings.pixels = enabled;
}

/**
 * 条件满足则搓一像素并返回 true（调用方应立刻结束本 tick）。
 *
 * 搓完仍采样：本 tick 几乎不烧逻辑 CPU，EMA 会往下掉，符合"空闲"信号。
 */
export function tryGeneratePixel(): boolean {
  const cpu = Game.cpu;
  if (!cpu) return false;

  const apiAvailable = typeof cpu.generatePixel === "function";
  if (
    !shouldGeneratePixel({
      bucket: cpu.bucket,
      avgCpu: Memory.cpu?.avg,
      limit: cpu.limit,
      underAttack: hasArmedThreat(),
      enabled: pixelsEnabled(),
      apiAvailable
    })
  ) {
    return false;
  }

  const code = cpu.generatePixel();
  if (code !== OK) return false;

  const avg = Memory.cpu?.avg;
  const avgText = avg === undefined ? "?" : avg.toFixed(1);
  log.info("像素", `桶满且空闲（均 ${avgText}/${cpu.limit}），搓了 1 像素`);
  sampleCpuUsage();
  return true;
}
